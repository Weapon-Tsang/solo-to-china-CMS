import crypto from "node:crypto";
import { pageBlockSignature } from "./evidence-validator.mjs";

export function markdownToContentBlocks(markdown) {
  const lines = String(markdown || "").replace(/\r/g, "").split("\n");
  const blocks = [];
  let list = [];
  let listOrdered = false;
  const flushList = () => {
    if (!list.length) return;
    blocks.push({ type: "list", items: list, ordered: listOrdered });
    list = [];
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { flushList(); continue; }
    const heading = line.match(/^(#{2,4})\s+(.+)$/);
    if (heading) {
      flushList();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (bullet || ordered) {
      const nextOrdered = Boolean(ordered);
      if (list.length && nextOrdered !== listOrdered) flushList();
      listOrdered = nextOrdered;
      list.push((ordered || bullet)[1]);
      continue;
    }
    flushList();
    blocks.push({ type: "paragraph", text: line });
  }
  flushList();
  return blocks;
}

export function buildContentAst({ draft = {}, brief = {}, visuals = [] } = {}) {
  const blocks = markdownToContentBlocks(draft.body_markdown);
  const ledger = draft.evidence_ledger || [];
  let activeLedger = null;
  const occurrence = new Map();
  const usedPreferredIds = new Set();
  const nodes = blocks.map((block) => {
    if (block.type === "heading") activeLedger = ledger.find((entry) => normalize(entry.section) === normalize(block.text)) || null;
    const signature = JSON.stringify(block);
    const count = (occurrence.get(signature) || 0) + 1;
    occurrence.set(signature, count);
    const candidate = block.type !== "heading" ? activeLedger?.content_node_ids?.[0] : null;
    const preferred = candidate && !usedPreferredIds.has(candidate) ? candidate : null;
    if (preferred) usedPreferredIds.add(preferred);
    return {
      id: preferred || `node_${crypto.createHash("sha256").update(`${brief.id || "brief"}:${signature}:${count}`).digest("hex").slice(0, 20)}`,
      type: block.type,
      semantic_role: block.type === "heading" ? "section_heading" : activeLedger?.claim_keys?.length ? "factual" : "editorial",
      visible_text: block.type === "list" ? block.items.join("\n") : block.text,
      ...(block.level ? { level: block.level } : {}),
      ...(block.type === "list" ? { items: [...block.items], ordered: Boolean(block.ordered) } : {}),
      fact_refs: [...new Set(activeLedger?.claim_keys || [])],
      source_section_ids: activeLedger?.section_id ? [activeLedger.section_id] : [],
      source_ids: [...new Set(activeLedger?.source_ids || [])],
      media_refs: [],
    };
  });
  const media = visuals.map((visual, index) => ({ id: visual.id || `visual_${index + 1}`, role: visual.image_role || "context",
    placement: visual.placement || "content", alt: visual.alt_text || "", caption: visual.caption || "",
    media_id: visual.wordpress_media_id || null, source_asset_id: visual.source_asset_id || null,
    media_url: visual.wordpress_media_url || visual.media_url || "", factual: Boolean(visual.factual_image_required) }));
  const ast = {
    version: "content-ast-compat-1",
    content_type: brief.content_type || brief.canonical?.content_type || "first_time_guide",
    title: String(draft.title || ""), slug: String(draft.slug || ""),
    summary: String(draft.meta_description || ""),
    faq: (draft.faqs || draft.seo?.faqs || []).map((item) => ({ question: String(item.question || ""), answer: String(item.answer || "") })),
    nodes: placeMediaNodes(nodes, media, brief.id || "brief"),
    media,
  };
  ast.content_hash = crypto.createHash("sha256").update(JSON.stringify(ast)).digest("hex");
  return ast;
}

export function renderContentAstMarkdown(ast) {
  return (ast?.nodes || []).filter((node) => node.type !== "media").map((node) => {
    if (node.type === "heading") return `${"#".repeat(Math.min(4, Math.max(2, Number(node.level) || 2)))} ${node.visible_text}`;
    if (node.type === "list") return (node.items || []).map((item, index) => node.ordered ? `${index + 1}. ${item}` : `- ${item}`).join("\n");
    return node.visible_text;
  }).join("\n\n");
}

export function composePageFromAst(ast, capabilities = {}, pageSchema = {}) {
  const atomic = composeAtomicPageFromAst(ast, capabilities, pageSchema);
  return atomic || composeLegacyFirstTimeGuideFromAst(ast, capabilities, pageSchema);
}

export function composeFirstTimeGuideFromAst(ast, capabilities = {}, pageSchema = {}) {
  return composePageFromAst(ast, capabilities, pageSchema);
}

function composeAtomicPageFromAst(ast, capabilities, pageSchema) {
  if (!Array.isArray(ast?.nodes) || !ast.nodes.length) return null;
  const available = new Map((capabilities.components || [])
    .filter((item) => item?.id && item.status !== "deprecated")
    .map((item) => [item.id, item]));
  const heading = available.get("heading");
  const paragraph = available.get("paragraph");
  const list = available.get("list");
  const image = available.get("image") || [...available.values()].find((item) => item.category === "media"
    && (item.schema?.properties?.media_id || item.schema?.properties?.mediaId));
  if (!heading?.schema?.properties?.text || !heading.schema.properties.level
      || !paragraph?.schema?.properties?.content || !list?.schema?.properties?.items) return null;
  const faq = available.get("faq") || available.get("faqList");
  const blocks = [];
  const provenance = [];
  const append = (block, nodes, { factuality = null } = {}) => {
    const sourceNodes = nodes.filter(Boolean);
    const index = blocks.length;
    const resolvedFactuality = factuality || (sourceNodes.some((node) => node.fact_refs?.length) ? "factual" : "non_factual");
    blocks.push(block);
    provenance.push({
      blockIndex: index,
      blockSignature: pageBlockSignature(block),
      contentNodeId: sourceNodes.find((node) => node.type !== "heading")?.id || sourceNodes[0]?.id || null,
      sourceSectionIds: [...new Set(sourceNodes.flatMap((node) => node.source_section_ids || []))],
      claimKeys: resolvedFactuality === "factual" ? [...new Set(sourceNodes.flatMap((node) => node.fact_refs || []))] : [],
      factuality: resolvedFactuality,
    });
  };
  for (let index = 0; index < ast.nodes.length; index += 1) {
    const node = ast.nodes[index];
    if (node.type === "heading" && Number(node.level || 2) === 2 && faq?.schema?.properties?.items
        && ast.faq?.length && /frequently asked questions|^faq$/i.test(node.visible_text)) {
      const sectionNodes = [node];
      while (index + 1 < ast.nodes.length) {
        const next = ast.nodes[index + 1];
        if (next.type === "heading" && Number(next.level || 2) === 2) break;
        sectionNodes.push(next);
        index += 1;
      }
      const data = { items: ast.faq.map((item) => ({ question: item.question, answer: inlineHtml(item.answer) })) };
      if (faq.schema.properties.title) data.title = node.visible_text;
      append({ type: faq.id, variant: preferredVariant(faq, "default"), data }, sectionNodes);
      continue;
    }
    if (node.type === "heading") {
      const level = Math.min(3, Math.max(2, Number(node.level) || 2));
      append({ type: heading.id, variant: preferredVariant(heading, level === 2 ? "section" : "subsection"),
        data: { text: node.visible_text, level } }, [node], { factuality: "non_factual" });
      continue;
    }
    if (node.type === "paragraph") {
      append({ type: paragraph.id, variant: preferredVariant(paragraph, "default"),
        data: { content: inlineHtml(node.visible_text) } }, [node]);
      continue;
    }
    if (node.type === "list" && node.items?.length) {
      append({ type: list.id, variant: preferredVariant(list, node.ordered ? "ordered" : "unordered"), data: { items: [...node.items] } }, [node]);
      continue;
    }
    if (node.type === "media") {
      if (!image || !node.media_id) continue;
      const data = {};
      if (image.schema.properties.media_id) data.media_id = node.media_id;
      if (image.schema.properties.mediaId) data.mediaId = node.media_id;
      if (image.schema.properties.alt) data.alt = node.alt;
      if (image.schema.properties.alt_text) data.alt_text = node.alt;
      if (image.schema.properties.caption) data.caption = node.caption;
      append({ type: image.id, variant: preferredVariant(image, node.role || "default"), data }, [node], { factuality: "non_factual" });
      continue;
    }
    return null;
  }
  if (!blocks.length || blocks.some((block) => !block.variant)) return null;
  return {
    output: { metadata: pageMetadata(ast, pageSchema), blocks },
    model: "deterministic-content-ast-compat-2",
    provenance: { version: "content-ast-compat-2", valid: true, errors: [], entries: provenance },
  };
}

function composeLegacyFirstTimeGuideFromAst(ast, capabilities = {}, pageSchema = {}) {
  if (ast?.content_type !== "first_time_guide") return null;
  const component = (capabilities.components || []).find((item) => item.id === "articleSection" && item.status !== "deprecated");
  if (!component || !component.schema?.properties?.heading || !component.schema?.properties?.body) return null;
  const faqComponent = (capabilities.components || []).find((item) => ["faq", "faqList"].includes(item.id)
    && item.status !== "deprecated" && item.schema?.properties?.items);
  const sections = [];
  for (const node of ast.nodes || []) {
    if (node.type === "heading" && Number(node.level || 2) === 2) sections.push({ heading: node, content: [] });
    else if (sections.length) sections.at(-1).content.push(node);
  }
  if (!sections.length) return null;
  const variants = component.variants || [];
  const variant = variants.includes("answer-first") ? "answer-first" : variants[0];
  const blocks = sections.map((section) => {
    if (faqComponent && ast.faq?.length && /frequently asked questions|^faq$/i.test(section.heading.visible_text)) {
      const faqVariant = faqComponent.variants?.[0];
      return { type: faqComponent.id, ...(faqVariant ? { variant: faqVariant } : {}),
        data: { items: ast.faq.map((item) => ({ question: item.question, answer: item.answer })) } };
    }
    const contentNodes = section.content;
    const body = contentNodes.map((node) => node.type === "list"
      ? (node.items || []).map((item) => `- ${item}`).join("\n") : node.visible_text).join("\n\n");
    return { type: component.id, ...(variant ? { variant } : {}), data: { heading: section.heading.visible_text, body } };
  });
  const metadata = pageMetadata(ast, pageSchema);
  const provenance = blocks.map((block, index) => {
    const section = sections[index];
    const nodes = [section.heading, ...section.content];
    return { blockIndex: index, blockSignature: pageBlockSignature(block), contentNodeId: section.content[0]?.id || section.heading.id,
      sourceSectionIds: [...new Set(nodes.flatMap((node) => node.source_section_ids))],
      claimKeys: [...new Set(nodes.flatMap((node) => node.fact_refs))], factuality: nodes.some((node) => node.fact_refs.length) ? "factual" : "non_factual" };
  });
  return { output: { metadata, blocks }, model: "deterministic-content-ast-compat-1", provenance: {
    version: "content-ast-compat-1", valid: true, errors: [], entries: provenance,
  } };
}

function pageMetadata(ast, pageSchema) {
  const metadataProperties = pageSchema?.properties?.metadata?.properties || {};
  const metadata = {};
  const put = (key, value) => { if (metadataProperties[key]) metadata[key] = value; };
  put("pageId", ast.content_hash);
  put("title", ast.title);
  put("slug", ast.slug);
  put("contentType", ast.content_type);
  put("excerpt", ast.summary);
  metadata.title ||= ast.title;
  return metadata;
}

function preferredVariant(component, preferred) {
  const variants = component?.variants || [];
  return variants.includes(preferred) ? preferred : variants[0] || null;
}

function inlineHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character])
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener" target="_blank">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

function placeMediaNodes(nodes, media, briefId) {
  const output = [...nodes];
  for (const item of media) {
    const node = { id: `node_${crypto.createHash("sha256").update(`${briefId}:media:${item.id}`).digest("hex").slice(0, 20)}`,
      type: "media", semantic_role: item.factual ? "evidence_media" : "editorial_media", visible_text: "",
      media_ref: item.id, media_id: item.media_id, source_asset_id: item.source_asset_id, media_url: item.media_url,
      role: item.role, placement: item.placement, alt: item.alt, caption: item.caption,
      fact_refs: [], source_section_ids: [], source_ids: [], media_refs: [item.id] };
    let index = output.length;
    if (item.placement === "hero") index = 0;
    else if (item.placement === "after_intro") index = Math.max(0, output.findIndex((entry) => entry.type === "paragraph") + 1);
    else if (item.placement === "mid_article") index = Math.ceil(output.length / 2);
    else if (item.placement === "before_faq") {
      const faqIndex = output.findIndex((entry) => entry.type === "heading" && /frequently asked questions|^faq$/i.test(entry.visible_text));
      index = faqIndex < 0 ? output.length : faqIndex;
    }
    output.splice(index, 0, node);
  }
  return output;
}

export function contentBlockSummary(blocks) {
  const output = { paragraphs: 0, headings: 0, lists: 0, faq: false };
  for (const block of blocks || []) {
    if (block.type === "paragraph") output.paragraphs += 1;
    if (block.type === "heading") {
      output.headings += 1;
      if (/frequently asked questions/i.test(block.text || "")) output.faq = true;
    }
    if (block.type === "list") output.lists += 1;
    if (block.type === "commercial") output.commercial = (output.commercial || 0) + 1;
  }
  return output;
}

function normalize(value) { return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
