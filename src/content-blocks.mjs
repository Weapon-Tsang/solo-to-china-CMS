import crypto from "node:crypto";
import { evidenceTextContains, pageBlockSignature, protectedFactTokens } from "./evidence-validator.mjs";
import { toFrontendGuideType } from "./content-taxonomy.mjs";

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
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    const line = rawLine.trim();
    if (!line) { flushList(); continue; }
    const tableHeader = markdownTableCells(line);
    const tableDivider = markdownTableCells(lines[lineIndex + 1] || "");
    if (tableHeader?.length > 1 && tableDivider?.length === tableHeader.length
        && tableDivider.every((cell) => /^:?(?:-{3,}|[\u2013\u2014]+):?$/.test(cell))) {
      flushList();
      const rows = [];
      lineIndex += 2;
      while (lineIndex < lines.length) {
        const cells = markdownTableCells(lines[lineIndex]);
        if (!cells || cells.length !== tableHeader.length) break;
        rows.push(cells.map(plainInlineText));
        lineIndex += 1;
      }
      lineIndex -= 1;
      if (rows.length) blocks.push({ type:"table", headers:tableHeader.map(plainInlineText), rows });
      continue;
    }
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
      // Preserve safe inline Markdown for the legacy WordPress renderer. The
      // Contract-native composer removes decorators from its plain list data
      // below, so no raw Markdown crosses the final Page Payload boundary.
      list.push((ordered || bullet)[1]);
      continue;
    }
    flushList();
    blocks.push({ type: "paragraph", text: line });
  }
  flushList();
  return blocks;
}

export function buildContentAst({ draft = {}, brief = {}, visuals = [], facts = [] } = {}) {
  const blocks = markdownToContentBlocks(draft.body_markdown);
  const ledger = draft.evidence_ledger || [];
  const ledgerByHeading = ledgerHeadingIndex(ledger, brief);
  // The first planned section is commonly rendered as an answer-first intro
  // without a visible H2. Treat pre-heading prose as that first section until
  // the first actual heading establishes another scope.
  let activeLedger = ledger[0] || null;
  let activeLedgerLevel = activeLedger ? 2 : null;
  const occurrence = new Map();
  const usedPreferredIds = new Set();
  const preferredIndex = new Map();
  const nodes = blocks.map((block) => {
    if (block.type === "heading") {
      const matched = ledgerByHeading.get(normalize(block.text)) || null;
      if (matched) {
        activeLedger = matched;
        activeLedgerLevel = Number(block.level || 2);
      } else if (activeLedgerLevel == null || Number(block.level || 2) <= activeLedgerLevel) {
        activeLedger = null;
        activeLedgerLevel = null;
      }
    }
    const signature = JSON.stringify(block);
    const count = (occurrence.get(signature) || 0) + 1;
    occurrence.set(signature, count);
    const ledgerIndex = activeLedger ? ledger.indexOf(activeLedger) : -1;
    const nextPreferred = ledgerIndex < 0 ? 0 : preferredIndex.get(ledgerIndex) || 0;
    const candidate = block.type !== "heading" ? activeLedger?.content_node_ids?.[nextPreferred] : null;
    if (block.type !== "heading" && ledgerIndex >= 0) preferredIndex.set(ledgerIndex, nextPreferred + 1);
    const preferred = candidate && !usedPreferredIds.has(candidate) ? candidate : null;
    if (preferred) usedPreferredIds.add(preferred);
    return {
      id: preferred || `node_${crypto.createHash("sha256").update(`${brief.id || "brief"}:${signature}:${count}`).digest("hex").slice(0, 20)}`,
      type: block.type,
      semantic_role: block.type === "heading" ? "section_heading" : "editorial",
      visible_text: block.type === "list" ? block.items.join("\n")
        : block.type === "table" ? [block.headers, ...block.rows].flat().join("\n") : block.text,
      ...(block.level ? { level: block.level } : {}),
      ...(block.type === "list" ? { items: [...block.items], ordered: Boolean(block.ordered) } : {}),
      ...(block.type === "table" ? { headers:[...block.headers], rows:block.rows.map((row) => [...row]) } : {}),
      fact_refs: [],
      source_section_ids: activeLedger?.section_id ? [activeLedger.section_id] : [],
      source_ids: [],
      media_refs: [],
    };
  });
  assignFactsToNodes(nodes, ledger, facts);
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

export function reconcileContentAstLedger(ast, ledger = []) {
  const nodes = (ast?.nodes || []).filter((node) => node.type !== "heading" && node.type !== "media");
  return (ledger || []).map((entry) => {
    const claims = new Set(entry.claim_keys || []);
    const sectionNodes = nodes.filter((node) => (node.source_section_ids || []).includes(entry.section_id));
    const factualNodes = sectionNodes.filter((node) => (node.fact_refs || []).some((key) => claims.has(key)));
    // A plan ledger describes the facts available to a section, while the
    // persisted draft ledger must describe only facts the visible prose
    // actually asserts. Keeping unused planned keys here makes QA demand that
    // every available price/hour appears in the article and produces false
    // evidence mismatches on otherwise honest, concise copy.
    const assertedClaims = [...new Set(factualNodes.flatMap((node) => node.fact_refs || []))]
      .filter((key) => claims.has(key));
    const assertedSources = [...new Set(factualNodes.flatMap((node) => node.source_ids || []))].sort();
    return { ...entry, content_node_ids: [...new Set(factualNodes.map((node) => node.id))],
      claim_keys: assertedClaims, source_ids: assertedSources };
  });
}

function assignFactsToNodes(nodes, ledger, facts) {
  const factsByKey = new Map((facts || []).map((fact) => [fact.normalized_key, fact]));
  for (const entry of ledger || []) {
    const candidates = nodes.filter((node) => node.type !== "heading" && node.type !== "media"
      && (node.source_section_ids || []).includes(entry.section_id));
    if (!candidates.length) continue;
    (entry.claim_keys || []).forEach((key, claimIndex) => {
      const fact = factsByKey.get(key);
      const signals = factSearchSignals(fact);
      const ranked = candidates.map((node, index) => {
        const matched = signals.filter((signal) => normalize(node.visible_text).includes(signal.term));
        const protectedTokens = fact ? protectedFactTokens(fact) : [];
        const protectedValuePresent = !protectedTokens.length
          || protectedTokens.some((token) => evidenceTextContains(node.visible_text, token));
        return { node, index, score: protectedValuePresent ? matched.reduce((score, signal) => score + signal.weight, 0) : 0,
          strongest: Math.max(0, ...matched.map((signal) => signal.weight)) };
      })
        .sort((left, right) => right.score - left.score || left.index - right.index);
      // A ledger states which facts belong to a section, not that every fact is
      // asserted by every block in that section.  Old drafts often carry broad
      // section ledgers, so an unmatched fact must remain unassigned instead of
      // contaminating an arbitrary paragraph and failing final-page QA forever.
      // Keep the legacy fallback only when the caller genuinely has no fact
      // material (the pre-Content-AST compatibility path).
      const target = ranked[0]?.score >= 4 && ranked[0]?.strongest >= 4
        ? ranked[0].node : !fact ? candidates[claimIndex % candidates.length] : null;
      if (!target) return;
      target.fact_refs = [...new Set([...(target.fact_refs || []), key])];
      target.semantic_role = "factual";
      const evidenceSources = (fact?.evidence || []).map((item) => item.source_id).filter(Boolean);
      target.source_ids = [...new Set([...(target.source_ids || []), ...(evidenceSources.length ? evidenceSources : entry.source_ids || [])])].sort();
    });
  }
}

function factSearchSignals(fact) {
  if (!fact) return [];
  const weighted = [
    ...[fact.subject, fact.canonical_subject].flatMap((value) => searchParts(value).map((part) => [part, 4])),
    ...predicateSearchParts(fact.predicate).flatMap((item) => [[item.value, item.weight]]),
    ...searchParts(fact.preferred_value).map((value) => [value, 12]),
    ...(isZeroFeeValue(fact.preferred_value) ? [["free", 12]] : []),
    ...(fact.evidence || []).flatMap((item) => [
      ...searchParts(item.value).map((value) => [value, 10]),
      ...(item.qualifiers || []).filter(isUsefulSearchQualifier).flatMap((value) => searchParts(value).map((part) => [part, 5])),
    ]),
  ];
  const signals = new Map();
  for (const [value, weight] of weighted) {
    const term = normalize(value);
    if (term.length >= 3 || /^\d+(?:\s+\d+)+$/.test(term)) signals.set(term, Math.max(weight, signals.get(term) || 0));
  }
  return [...signals].map(([term, weight]) => ({ term, weight }));
}

function isZeroFeeValue(value) {
  return /^(?:(?:CNY|RMB|[¥￥])\s*0|0\s*(?:CNY|RMB|元))$/iu.test(String(value || "").trim());
}

function searchParts(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  // Preserve compact values such as 24/7 as one high-confidence signal while
  // still exposing individual stops from long route/list values.
  const parenthetical = [...text.matchAll(/\(([^)]+)\)/g)].map((match) => match[1]).filter(Boolean);
  return [...new Set([text, ...parenthetical, ...text.split(/\s*(?:\||,|;|->|→|—>)\s*/u).filter(Boolean)])];
}

function predicateSearchParts(value) {
  const parts = String(value || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((part) => part.length >= 4);
  const weighted = [...parts.map((part) => ({ value:part, weight:3 })),
    ...parts.slice(0, -1).map((part, index) => ({ value:`${part} ${parts[index + 1]}`, weight:6 }))];
  return [...new Map(weighted.map((item) => [item.value, item])).values()];
}

function isUsefulSearchQualifier(value) {
  const text = String(value || "").trim();
  if (!text || /^[a-z0-9]+(?:_[a-z0-9]+)+$/i.test(text)) return false;
  return !/^(?:(?:day|line|route|itinerary)\s*\d*|current|ordinary|common occurrence|walking|on foot|metro route)$/i.test(text);
}

function ledgerHeadingIndex(ledger, brief) {
  const output = new Map();
  for (const entry of ledger || []) if (normalize(entry.section)) output.set(normalize(entry.section), entry);
  let plan = brief?.plan || brief?.outline ? brief : null;
  if (!plan && brief?.plan_json) {
    try { plan = JSON.parse(brief.plan_json); } catch { plan = null; }
  }
  const outline = plan?.plan?.outline || plan?.outline || [];
  for (const section of outline) {
    const entry = (ledger || []).find((item) => item.section_id === section.section_id);
    if (entry && normalize(section.heading)) output.set(normalize(section.heading), entry);
  }
  return output;
}

export function renderContentAstMarkdown(ast) {
  return (ast?.nodes || []).filter((node) => node.type !== "media").map((node) => {
    if (node.type === "heading") return `${"#".repeat(Math.min(4, Math.max(2, Number(node.level) || 2)))} ${node.visible_text}`;
    if (node.type === "list") return (node.items || []).map((item, index) => node.ordered ? `${index + 1}. ${item}` : `- ${item}`).join("\n");
    if (node.type === "table") return [
      `| ${node.headers.join(" | ")} |`,
      `| ${node.headers.map(() => "---").join(" | ")} |`,
      ...node.rows.map((row) => `| ${row.join(" | ")} |`),
    ].join("\n");
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
      append({ type: list.id, variant: preferredVariant(list, node.ordered ? "ordered" : "unordered"),
        data: { items: node.items.map(plainInlineText) } }, [node]);
      continue;
    }
    if (node.type === "table" && node.rows?.length) {
      append({ type: list.id, variant: preferredVariant(list, "unordered"),
        data:{ items:node.rows.map((row) => tableRowSummary(node.headers, row)) } }, [node]);
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
  put("contentType", toFrontendGuideType(ast.content_type));
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
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character])
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener" target="_blank">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

function markdownTableCells(value) {
  const text = String(value || "").trim();
  if (!text.startsWith("|") || !text.endsWith("|")) return null;
  return text.slice(1, -1).split("|").map((cell) => cell.trim());
}

function plainInlineText(value) {
  return String(value || "")
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)\s]+\)/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .trim();
}

function tableRowSummary(headers, row) {
  const primary = plainInlineText(row[0]);
  const details = row.slice(1).map((value, index) => {
    const label = plainInlineText(headers[index + 1]);
    const text = plainInlineText(value);
    return label && text ? `${label}: ${text}` : text;
  }).filter(Boolean);
  return [primary, details.join("; ")].filter(Boolean).join(" \u2014 ");
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
