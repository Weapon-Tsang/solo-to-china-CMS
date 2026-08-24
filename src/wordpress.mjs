export class WordPressDraftAdapter {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.config.siteUrl && this.config.username && this.config.applicationPassword);
  }

  async listContentInventory() {
    if (!this.enabled) throw new Error("WordPress inventory sync is not configured.");
    assertSafeSiteUrl(this.config.siteUrl);
    const inventory = [];
    let page = 1;
    let totalPages = 1;
    do {
      const params = new URLSearchParams({
        context: "edit",
        status: "publish,draft,pending,private,future",
        per_page: "100",
        page: String(page),
        _fields: "id,slug,status,link,modified,title",
      });
      const { body, response } = await this.requestWithResponse(`/wp-json/wp/v2/posts?${params}`, { method: "GET" });
      if (!Array.isArray(body)) throw new Error("WordPress inventory response must be an array.");
      inventory.push(...body.map((post) => ({
        postId: post.id,
        slug: String(post.slug || ""),
        title: plainText(post.title?.raw || post.title?.rendered || ""),
        status: String(post.status || ""),
        postUrl: post.link || null,
        modifiedAt: post.modified || null,
      })));
      totalPages = Math.max(1, Number.parseInt(response.headers.get("x-wp-totalpages") || "1", 10) || 1);
      page += 1;
    } while (page <= totalPages);
    return inventory;
  }

  async upsertDraft(draft, existingPostId = null) {
    if (!this.enabled) throw new Error("WordPress draft delivery is not configured.");
    assertSafeSiteUrl(this.config.siteUrl);
    if (existingPostId) {
      const current = await this.request(`/wp-json/wp/v2/posts/${existingPostId}?context=edit`, { method: "GET" });
      if (current.status !== "draft") {
        throw new Error(`WordPress post ${existingPostId} is '${current.status}', so the engine refuses to overwrite it.`);
      }
    }
    const post = {
      title: draft.title,
      slug: draft.slug,
      content: this.config.contentFormat === "html" ? markdownToSafeHtml(draft.body_markdown) : markdownToWordPressBlocks(draft.body_markdown),
      excerpt: draft.meta_description,
      status: "draft",
      comment_status: "closed",
      ping_status: "closed",
    };
    if (this.config.authorId > 0) post.author = this.config.authorId;
    if (this.config.categoryIds?.length) post.categories = this.config.categoryIds;
    if (this.config.tagIds?.length) post.tags = this.config.tagIds;
    if (this.config.featuredMediaId > 0) post.featured_media = this.config.featuredMediaId;
    if (this.config.template) post.template = this.config.template;
    const meta = {};
    if (this.config.seoTitleMetaKey) meta[this.config.seoTitleMetaKey] = draft.title;
    if (this.config.seoDescriptionMetaKey) meta[this.config.seoDescriptionMetaKey] = draft.meta_description;
    if (Object.keys(meta).length) post.meta = meta;
    const result = await this.request(`/wp-json/wp/v2/posts${existingPostId ? `/${existingPostId}` : ""}`, {
      method: "POST",
      body: JSON.stringify(post),
    });
    if (result.status !== "draft") throw new Error("WordPress did not confirm draft status; refusing to record the sync.");
    return { postId: result.id, postUrl: result.link || null, status: result.status };
  }

  async request(pathname, options) {
    const { body } = await this.requestWithResponse(pathname, options);
    return body;
  }

  async requestWithResponse(pathname, options) {
    const response = await this.fetch(`${this.config.siteUrl}${pathname}`, {
      ...options,
      headers: {
        authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.applicationPassword}`).toString("base64")}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`WordPress API failed (${response.status}): ${body?.message || response.statusText}`);
    return { body, response };
  }
}

export function markdownToSafeHtml(markdown) {
  return parseMarkdown(markdown).map((block) => block.html).join("\n");
}

export function markdownToWordPressBlocks(markdown) {
  return parseMarkdown(markdown).map((block) => {
    if (block.type === "heading") return `<!-- wp:heading {"level":${block.level}} -->\n${block.html}\n<!-- /wp:heading -->`;
    if (block.type === "list") return `<!-- wp:list -->\n${block.html}\n<!-- /wp:list -->`;
    return `<!-- wp:paragraph -->\n${block.html}\n<!-- /wp:paragraph -->`;
  }).join("\n\n");
}

function parseMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r/g, "").split("\n");
  const output = [];
  let list = [];
  const closeList = () => {
    if (!list.length) return;
    output.push({ type: "list", html: `<ul>${list.map((item) => `<li>${item}</li>`).join("")}</ul>` });
    list = [];
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { closeList(); continue; }
    const heading = line.match(/^(#{2,4})\s+(.+)$/);
    if (heading) { closeList(); const level = heading[1].length; output.push({ type: "heading", level, html: `<h${level}>${inline(heading[2])}</h${level}>` }); continue; }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) { list.push(inline(bullet[1])); continue; }
    closeList();
    output.push({ type: "paragraph", html: `<p>${inline(line)}</p>` });
  }
  closeList();
  return output;
}

function inline(text) {
  return escapeHtml(text)
    .replace(/\[\[affiliate:([^|\]]+)\|(https:\/\/[^\]\s]+)\]\]/g, '<a href="$2" rel="sponsored nofollow noopener" target="_blank">$1</a>')
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener" target="_blank">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function plainText(value) {
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function assertSafeSiteUrl(value) {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !local) throw new Error("WordPress Application Passwords require HTTPS outside localhost.");
  if (url.username || url.password || url.search || url.hash) throw new Error("WORDPRESS_SITE_URL must be a clean site origin/path without credentials or query parameters.");
}
