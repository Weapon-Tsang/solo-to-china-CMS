const COMMERCIAL_VARIANTS = {
  affiliate_booking_card: () => "default",
  affiliate_search_card: (data) => data.embed_config ? "search_box" : "link",
  affiliate_banner: (data) => data.asset_type === "DYNAMIC_BANNER" ? "dynamic" : "static",
  affiliate_promotion_card: () => "default",
};

const MEDIA_ROLES = new Set(["featured", "evidence", "context", "illustration", "decorative"]);

export class PublishCompositionError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = "PublishCompositionError";
    this.code = code;
    this.details = details;
    this.retryable = false;
  }
}

export function mergeCommercialOverlay(pagePayload, commercialComposition) {
  const page = structuredClone(pagePayload);
  const editorialBlocks = Array.isArray(page.blocks) ? page.blocks : [];
  const overlay = (commercialComposition?.commercial_blocks || []).map((block, order) => ({
    order,
    afterIndex: Number.isInteger(block.after_block_index) ? block.after_block_index : editorialBlocks.length - 1,
    placement: block.placement === "end_resource" ? "end_resource" : "contextual",
    block: commercialPageBlock(block, commercialComposition?.strategy_version || ""),
  }));
  const contextual = new Map();
  const endResource = [];
  for (const item of overlay) {
    if (item.placement === "end_resource") {
      endResource.push(item);
      continue;
    }
    const index = Math.max(0, Math.min(editorialBlocks.length - 1, item.afterIndex));
    const items = contextual.get(index) || [];
    items.push(item);
    contextual.set(index, items);
  }
  const blocks = [];
  editorialBlocks.forEach((block, index) => {
    blocks.push(block);
    for (const item of (contextual.get(index) || []).sort((a, b) => a.order - b.order)) blocks.push(item.block);
  });
  for (const item of endResource.sort((a, b) => a.order - b.order)) blocks.push(item.block);
  return { ...page, blocks };
}

export function buildPublishPackage({ pagePayload, draft, contract, publication = null, media = [] }) {
  if (!contract?.contractVersion || !contract?.checksum) {
    throw new PublishCompositionError("NO_VALID_FRONTEND_CONTRACT", "A valid active Frontend Contract is required.");
  }
  const page = structuredClone(pagePayload);
  const manifest = buildMediaManifest(media);
  const featured = manifest.find((item) => item.role === "featured");
  if (featured && page.metadata && page.metadata.featuredMediaId == null) page.metadata.featuredMediaId = featured.media_id;
  return {
    contract: {
      componentContractVersion: contract.contractVersion,
      pageSchemaVersion: contract.pageSchemaContractVersion || contract.contractVersion,
      contractChecksum: contract.checksum,
    },
    page,
    seo: semanticSeo(draft),
    schema_jsonld: isObject(draft?.schema_jsonld) ? structuredClone(draft.schema_jsonld) : {},
    media: manifest,
    publication: {
      status: "draft",
      existing_post_id: positiveInteger(publication?.post_id) || null,
      cms_draft_id: draft.id,
    },
  };
}

export function mediaReferences(visuals = []) {
  return visuals
    .filter((visual) => positiveInteger(visual.wordpress_media_id))
    .map((visual) => ({
      visualId: visual.id,
      media_id: positiveInteger(visual.wordpress_media_id),
      url: safeUrl(visual.wordpress_media_url || visual.media_url),
      alt: String(visual.alt_text || "").slice(0, 500),
      caption: String(visual.caption || "").slice(0, 2_000),
      role: mediaRole(visual),
      placement: String(visual.placement || "content").slice(0, 160),
    }));
}

function commercialPageBlock(block, strategyVersion) {
  const component = String(block?.component || "");
  const variantResolver = COMMERCIAL_VARIANTS[component];
  if (!variantResolver) throw new PublishCompositionError("UNKNOWN_COMPONENT", `Commercial component '${component}' is not supported by the overlay mapper.`);
  const source = isObject(block.data) ? block.data : {};
  const data = compact({
    affiliate_asset_id: source.affiliate_asset_id,
    provider: source.provider,
    asset_type: source.asset_type,
    product_category: source.product_category,
    title: source.title,
    description: source.description,
    cta_label: source.cta_label,
    target_url: source.target_url,
    disclosure: source.disclosure,
    scope_type: source.scope_type,
    scope_key: source.scope_key,
    slot_key: block.slot_key || source.slot_key,
    placement: block.placement || source.placement,
    strategy_version: source.strategy_version || strategyVersion,
    price_text: source.price_text,
    valid_from: source.valid_from,
    valid_until: source.valid_until,
    entity: source.entity,
    route: source.route,
    destination: source.destination,
    anchor: source.anchor,
    image_url: source.image_url,
    alt_text: source.alt_text,
    embed_config: normalizeEmbedConfig(source.embed_config),
  });
  // The Frontend search schema uses oneOf(target_url, embed_config). When an
  // approved structured embed exists, sending both would fail that schema.
  if (component === "affiliate_search_card" && data.embed_config) delete data.target_url;
  return { type: component, variant: variantResolver(data), data };
}

function normalizeEmbedConfig(value) {
  if (!isObject(value) || !Object.keys(value).length) return undefined;
  return compact({
    embed_type: value.embed_type || value.embedType,
    src: value.src,
    width: integer(value.width),
    height: integer(value.height),
    language: value.language,
    theme: value.theme,
    variant: value.variant,
  });
}

function semanticSeo(draft) {
  const seo = isObject(draft?.seo) ? draft.seo : {};
  return compact({
    meta_title: String(seo.meta_title || draft?.title || "").slice(0, 200),
    meta_description: String(draft?.meta_description || seo.meta_description || "").slice(0, 500),
    focus_keyword: String(seo.focus_keyword || "").slice(0, 160),
    secondary_keywords: Array.isArray(seo.secondary_keywords)
      ? seo.secondary_keywords.slice(0, 30).map((item) => String(item).slice(0, 160)) : [],
    search_intent: String(seo.search_intent || "").slice(0, 160),
    strategy_version: String(draft?.strategy_version || seo.strategy_version || "").slice(0, 80),
  }, { preserveEmpty: true });
}

function buildMediaManifest(items) {
  return items.slice(0, 200).map((item) => compact({
    media_id: positiveInteger(item.media_id || item.id),
    url: safeUrl(item.url),
    alt: String(item.alt || "").slice(0, 500),
    caption: String(item.caption || "").slice(0, 2_000),
    role: MEDIA_ROLES.has(item.role) ? item.role : "context",
    placement: String(item.placement || "content").slice(0, 160),
  }, { preserveEmpty: true }));
}

function mediaRole(visual) {
  if (visual.placement === "hero") return "featured";
  if (MEDIA_ROLES.has(visual.image_role)) return visual.image_role;
  if (visual.image_type === "illustration") return "illustration";
  if (visual.factual_image_required) return "evidence";
  return "context";
}

function compact(value, { preserveEmpty = false } = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && (preserveEmpty || item !== "")));
}

function integer(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function positiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
