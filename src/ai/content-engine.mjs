import { slugify, truncate } from "../utils.mjs";
import { CONTENT_STRATEGY } from "../content-strategy.mjs";
import { createAiClient } from "./client.mjs";

const BRIEF_SCHEMA = objectSchema(
  ["title", "primary_keyword", "search_intent", "audience", "angle", "reader_promise", "outline", "adaptation_requirements", "conflict_instructions", "verification_instructions", "canonical"],
  {
    title: { type: "string" },
    primary_keyword: { type: "string" },
    search_intent: { type: "string" },
    audience: { type: "array", items: { type: "string" } },
    angle: { type: "string" },
    reader_promise: { type: "string" },
    outline: {
      type: "array",
      items: objectSchema(["heading", "purpose", "claim_keys"], {
        heading: { type: "string" }, purpose: { type: "string" },
        claim_keys: { type: "array", items: { type: "string" } },
      }),
    },
    adaptation_requirements: { type: "array", items: { type: "string" } },
    conflict_instructions: { type: "array", items: { type: "string" } },
    verification_instructions: { type: "array", items: { type: "string" } },
    canonical: objectSchema(["content_type", "summary", "quick_answer", "entities", "secondary_queries", "highlights", "practical_tips", "warnings", "faq", "answer_blocks", "image_plan", "seo"], {
      content_type: { type: "string", enum: ["city_guide", "itinerary", "attraction_guide", "food_guide", "transport_guide", "neighborhood_guide", "hotel_area_guide", "shopping_guide", "practical_guide", "first_time_guide", "comparison", "listicle", "how_to"] },
      summary: { type: "string" }, quick_answer: { type: "string" },
      entities: { type: "array", items: { type: "string" } }, secondary_queries: { type: "array", items: { type: "string" } },
      highlights: { type: "array", items: { type: "string" } }, practical_tips: { type: "array", items: { type: "string" } }, warnings: { type: "array", items: { type: "string" } },
      faq: { type: "array", items: objectSchema(["question", "answer"], { question: { type: "string" }, answer: { type: "string" } }) },
      answer_blocks: { type: "array", items: objectSchema(["question", "direct_answer", "supporting_points", "entity"], {
        question: { type: "string" }, direct_answer: { type: "string" }, supporting_points: { type: "array", items: { type: "string" } }, entity: { type: "string" },
      }) },
      image_plan: { type: "array", items: objectSchema(["type", "role", "subject", "placement", "strategy", "factual_image_required"], {
        type: { type: "string", enum: ["real_world_photo", "infographic", "map_or_route", "illustration"] },
        role: { type: "string" }, subject: { type: "string" }, placement: { type: "string" }, strategy: { type: "string" }, factual_image_required: { type: "boolean" },
      }) },
      seo: objectSchema(["primary_keyword", "secondary_keywords", "search_intent"], {
        primary_keyword: { type: "string" }, secondary_keywords: { type: "array", items: { type: "string" } }, search_intent: { type: "string" },
      }),
    }),
  },
);

const INTAKE_SCHEMA = objectSchema(
  ["classification", "confidence", "primary_topic", "entities", "knowledge_points", "claims", "article_potential", "information_density", "topic_completeness", "duplicate_likelihood", "recommended_action", "suggested_content_type", "suggested_article_title", "missing_information", "possible_cluster_topics", "reasoning_summary"],
  {
    classification: { type: "string", enum: ["ARTICLE_CANDIDATE", "KNOWLEDGE_ONLY", "CLAIM_ONLY", "CLUSTER_CANDIDATE", "RESEARCH_REQUIRED", "DUPLICATE", "LOW_VALUE", "UNSURE"] },
    confidence: { type: "number", minimum: 0, maximum: 1 }, primary_topic: { type: "string" },
    entities: { type: "array", items: { type: "string" } }, knowledge_points: { type: "array", items: { type: "string" } }, claims: { type: "array", items: { type: "string" } },
    article_potential: { type: "number", minimum: 0, maximum: 100 }, information_density: { type: "number", minimum: 0, maximum: 100 },
    topic_completeness: { type: "number", minimum: 0, maximum: 100 }, duplicate_likelihood: { type: "number", minimum: 0, maximum: 100 },
    recommended_action: { type: "string", enum: ["CREATE_CONTENT_PLAN", "ADD_TO_KNOWLEDGE", "ADD_TO_CLUSTER", "RESEARCH_FIRST", "MERGE_OR_IGNORE", "IGNORE", "HUMAN_REVIEW"] },
    suggested_content_type: { type: "string" }, suggested_article_title: { type: "string" },
    missing_information: { type: "array", items: { type: "string" } }, possible_cluster_topics: { type: "array", items: { type: "string" } }, reasoning_summary: { type: "string" },
  },
);

const DRAFT_SCHEMA = objectSchema(
  ["title", "slug", "meta_description", "body_markdown", "evidence_ledger", "unresolved_conflicts", "verification_notes", "seo", "faqs", "visuals"],
  {
    title: { type: "string" }, slug: { type: "string" }, meta_description: { type: "string" }, body_markdown: { type: "string" },
    evidence_ledger: {
      type: "array",
      items: objectSchema(["section", "claim_keys", "source_ids"], {
        section: { type: "string" },
        claim_keys: { type: "array", items: { type: "string" } },
        source_ids: { type: "array", items: { type: "string" } },
      }),
    },
    unresolved_conflicts: { type: "array", items: { type: "string" } },
    verification_notes: { type: "array", items: { type: "string" } },
    seo: objectSchema(["meta_title", "focus_keyword", "secondary_keywords", "search_intent", "key_takeaways"], {
      meta_title: { type: "string" }, focus_keyword: { type: "string" }, secondary_keywords: { type: "array", items: { type: "string" } }, search_intent: { type: "string" },
      key_takeaways: { type: "array", items: { type: "string" } },
    }),
    faqs: { type: "array", items: objectSchema(["question", "answer"], { question: { type: "string" }, answer: { type: "string" } }) },
    visuals: { type: "array", items: objectSchema(["placement", "purpose", "alt_text", "caption", "generation_prompt", "aspect_ratio", "image_type", "image_role", "image_subject", "factual_image_required"], {
      placement: { type: "string", enum: ["hero", "after_intro", "mid_article", "before_faq", "closing"] },
      purpose: { type: "string" }, alt_text: { type: "string" }, caption: { type: "string" }, generation_prompt: { type: "string" },
      aspect_ratio: { type: "string", enum: ["16:9", "4:3", "1:1", "3:2", "9:16"] },
      image_type: { type: "string", enum: ["real_world_photo", "infographic", "map_or_route", "illustration"] },
      image_role: { type: "string" }, image_subject: { type: "string" }, factual_image_required: { type: "boolean" },
    }) },
  },
);

const REVIEW_SCHEMA = objectSchema(
  ["passed", "score", "checks", "issues", "unsupported_claims"],
  {
    passed: { type: "boolean" }, score: { type: "number", minimum: 0, maximum: 100 },
    checks: {
      type: "array",
      items: objectSchema(["name", "passed", "detail"], {
        name: { type: "string" }, passed: { type: "boolean" }, detail: { type: "string" },
      }),
    },
    issues: {
      type: "array",
      items: objectSchema(["code", "severity", "message"], {
        code: { type: "string" }, severity: { type: "string", enum: ["blocker", "warning"] }, message: { type: "string" },
      }),
    },
    unsupported_claims: { type: "array", items: { type: "string" } },
  },
);

const PAGE_PLAN_SCHEMA = objectSchema(
  ["blocks"],
  {
    blocks: {
      type: "array",
      minItems: 1,
      items: objectSchema(["type", "semantic_role", "writer_guidance"], {
        type: { type: "string" },
        variant: { type: "string" },
        semantic_role: { type: "string" },
        writer_guidance: { type: "string" },
      }),
    },
  },
);

const ENTITY_LOCATION_SCHEMA = objectSchema([], {
  country: { type: "string" }, region: { type: "string" }, city: { type: "string" }, district: { type: "string" },
  latitude: { type: "number" }, longitude: { type: "number" },
});

const ENTITY_RESOLUTION_SCHEMA = objectSchema(
  ["entities", "claim_updates", "candidates"],
  {
    entities: {
      type: "array",
      items: objectSchema(["entity_key", "canonical_subject", "aliases", "confidence"], {
        entity_key: { type: "string" }, canonical_subject: { type: "string" },
        aliases: { type: "array", items: { type: "string" } }, confidence: { type: "number", minimum: 0, maximum: 1 },
        entity_type: { type: "string" }, granularity: { type: "string" }, location: ENTITY_LOCATION_SCHEMA,
      }),
    },
    claim_updates: {
      type: "array",
      items: objectSchema(["claim_id", "entity_key", "canonical_subject", "canonical_key", "confidence"], {
        claim_id: { type: "string" }, entity_key: { type: "string" }, canonical_subject: { type: "string" },
        canonical_key: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 },
        entity_type: { type: "string" }, granularity: { type: "string" }, location: ENTITY_LOCATION_SCHEMA,
      }),
    },
    candidates: {
      type: "array",
      items: objectSchema(["alias", "proposed_entity_key", "proposed_canonical_subject", "confidence", "rationale"], {
        alias: { type: "string" }, proposed_entity_key: { type: "string" }, proposed_canonical_subject: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 }, rationale: { type: "string" },
        candidate_entity_key: { type: "string" }, candidate_entity_type: { type: "string" }, candidate_granularity: { type: "string" },
        proposed_entity_type: { type: "string" }, proposed_granularity: { type: "string" },
        candidate_location: ENTITY_LOCATION_SCHEMA, proposed_location: ENTITY_LOCATION_SCHEMA,
        recommendation: { type: "string", enum: ["MERGE", "DO_NOT_MERGE", "UNCERTAIN"] },
        suggested_relation: { type: "string" },
      }),
    },
  },
);

export class ContentEngine {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.contentStrategy = config.contentStrategy || CONTENT_STRATEGY;
    this.client = createAiClient(config, fetchImpl);
  }

  get enabled() {
    return this.client.enabled;
  }

  async plan(research) {
    return this.respond({
      name: "content_brief",
      schema: BRIEF_SCHEMA,
      instructions: briefPrompt(this.contentStrategy.version),
      input: JSON.stringify(research),
    });
  }

  async analyzeIntake(research) {
    return this.respond({
      name: "content_intake_analysis",
      schema: INTAKE_SCHEMA,
      instructions: intakePrompt(this.contentStrategy.version),
      input: JSON.stringify(research),
    });
  }

  async draft(contentPackage, revisionFeedback = null) {
    const result = await this.respond({
      name: "article_draft",
      schema: DRAFT_SCHEMA,
      instructions: DRAFT_PROMPT,
      input: JSON.stringify({ ...contentPackage, revision_feedback: revisionFeedback }),
    });
    result.output.slug = slugify(result.output.slug || result.output.title);
    result.output.seo ||= {};
    result.output.meta_description = truncate(result.output.meta_description, 160);
    result.output.seo.meta_title = truncate(result.output.seo.meta_title || result.output.title, 70);
    result.output.seo.focus_keyword = truncate(result.output.seo.focus_keyword, 160);
    result.output.seo.secondary_keywords = (result.output.seo.secondary_keywords || []).slice(0, 8).map((item) => truncate(item, 160));
    result.output.seo.search_intent = truncate(result.output.seo.search_intent, 120);
    result.output.seo.key_takeaways = (result.output.seo.key_takeaways || []).slice(0, 6).map((item) => truncate(item, 240));
    result.output.faqs = (result.output.faqs || []).slice(0, 5).map((item) => ({ question: truncate(item.question, 220), answer: truncate(item.answer, 700) }));
    result.output.visuals = (result.output.visuals || []).slice(0, 5).map((item) => ({ ...item, purpose: truncate(item.purpose, 300), alt_text: truncate(item.alt_text, 220), caption: truncate(item.caption, 300), generation_prompt: truncate(item.generation_prompt, 2_000) }));
    return result;
  }

  async composePagePlan(contentPackage, capabilities) {
    return this.respond({
      name: "frontend_page_plan",
      schema: PAGE_PLAN_SCHEMA,
      instructions: pagePlanPrompt(contentPackage.brief?.strategy_version || this.contentStrategy.version, capabilities),
      input: JSON.stringify({
        canonical: contentPackage.brief?.canonical || {}, outline: contentPackage.brief?.plan || {},
        facts: (contentPackage.facts || []).map((fact) => ({ key: fact.normalized_key, subject: fact.subject, predicate: fact.predicate, status: fact.consensus_status })),
      }),
    });
  }

  async resolveEntities(entityPackage) {
    return this.respond({
      name: "destination_entity_resolution",
      schema: ENTITY_RESOLUTION_SCHEMA,
      instructions: ENTITY_RESOLUTION_PROMPT,
      input: JSON.stringify(entityPackage),
    });
  }

  async composeFrontendPage(contentPackage, capabilities, pageSchema) {
    return this.respond({
      name: "frontend_page_payload",
      schema: pageSchema,
      instructions: pagePayloadPrompt(contentPackage.brief?.strategy_version || this.contentStrategy.version, capabilities),
      input: JSON.stringify({
        page_plan: contentPackage.frontend_page_plan?.plan || null,
        canonical: contentPackage.brief?.canonical || {},
        draft: contentPackage.draft,
        visuals: contentPackage.draft?.visuals || [],
      }),
    });
  }

  async review(contentPackage) {
    const modelReview = await this.respond({
      name: "quality_review",
      schema: REVIEW_SCHEMA,
      instructions: REVIEW_PROMPT,
      input: JSON.stringify(contentPackage),
    });
    return { ...modelReview, output: applyDeterministicGates(modelReview.output, contentPackage) };
  }

  async respond({ name, schema, instructions, input }) {
    return this.client.completeJson({ name, schema, instructions, content: input });
  }
}
const intakePrompt = (strategyVersion) => `Analyze one already-captured human-selected China travel source for SoloToChina Content Production Strategy ${strategyVersion}.
- This is decision support, not article generation. Do not write an article and do not reveal private reasoning.
- Use only the supplied source and structured claims. A useful narrow fact can be KNOWLEDGE_ONLY or CLAIM_ONLY.
- Classify the source as ARTICLE_CANDIDATE, KNOWLEDGE_ONLY, CLAIM_ONLY, CLUSTER_CANDIDATE, RESEARCH_REQUIRED, DUPLICATE, LOW_VALUE, or UNSURE.
- Score article_potential, information_density, topic_completeness, and duplicate_likelihood from 0 to 100. Confidence is 0 to 1.
- Recommend one action: CREATE_CONTENT_PLAN, ADD_TO_KNOWLEDGE, ADD_TO_CLUSTER, RESEARCH_FIRST, MERGE_OR_IGNORE, IGNORE, or HUMAN_REVIEW.
- Surface missing facts such as verified booking process, price, route, opening hours, location, or warnings when the source is not enough for a safe standalone guide.
- reasoning_summary must be a short operator-facing explanation, never hidden chain-of-thought. Commercial conversion is outside this task.`;

const briefPrompt = (strategyVersion) => `Create an evidence-backed English content plan and Canonical Travel Content object for SoloToChina Content Production Strategy ${strategyVersion}.
- Audience: independent international visitors, especially solo travelers, first-time China visitors, and people who cannot read Chinese.
- Use only the supplied knowledge facts. Claim keys in the outline must exactly match supplied keys.
- Conflicted facts require explicit handling instructions; never silently choose a side.
- Facts marked time_sensitive or requires_official need explicit verification instructions. Exclude stale facts from the outline.
- Build an original synthesis, not a translation or imitation of any one UGC source.
- Include practical adaptation for language, booking, payment, navigation, safety, and solo logistics where evidence permits.
- Canonical fields are structured source data for the writer and renderer. Use empty arrays or empty strings for unknown information rather than guessing.
- Include direct answer blocks only where the supplied facts support them. The image plan must distinguish real_world_photo, infographic, map_or_route, and illustration; only illustration is eligible for image-model generation.
- Affiliate inventory and commercial conversion are outside this task and must not appear.`;

const DRAFT_PROMPT = `Write an original, publication-quality English China travel guide from the supplied brief and evidence package.
- Never invent a price, opening hour, policy, route, booking rule, safety guarantee, or other fact.
- Use only supplied claim keys; report conflicts and temporal uncertainty transparently.
- Write for solo, first-time, non-Chinese-speaking travelers without stereotyping or alarmism.
- Do not mention Xiaohongshu, source authors, internal claim keys, evidence ledgers, affiliate products, Trip.com, or commercial calls to action in body_markdown.
- Synthesize across sources. Do not translate one source section-by-section.
- Return a separate evidence ledger mapping each article section to exact claim keys and source IDs.
- Do not use stale facts. List every used time_sensitive/requires_official claim key in verification_notes and state temporal uncertainty in reader-facing copy.
- The article should be useful even with no commercial module. Aim for at least 1,200 words when evidence coverage supports it.
- Make the body easy for Search and AI answer systems to parse: use one answer-first opening paragraph, descriptive H2/H3 headings, short scannable sections, and a visible "Key takeaways" list. Do not make unsupported claims just for SEO.
- Return 2-5 concise FAQs that are answered by the article and evidence. FAQ answers must not introduce new facts. Include the same questions in a visible "Frequently asked questions" section of body_markdown.
- Return SEO metadata: a natural meta title under 60 characters, one focus keyword, and 3-6 reader-facing key takeaways. The meta description remains the top-level meta_description field.
- Return SEO metadata with secondary keywords and search intent. Do not invent internal links or canonical URLs.
- If the evidence package includes a frontend_page_plan, honor its semantic section order and writer guidance in the reader-facing article. It is a composition plan, not permission to invent components, props, or visual styling.
- Return a rights-safe image plan. Use 2 visuals for 800-1,299 words, 3 for 1,300-2,199 words, 4 for 2,200-3,199 words, and 5 above that. Every item needs accurate alt text, a useful placement, caption, image type, role, subject, factual_image_required, and aspect ratio. When a factual real-world visual supports the evidence, plan REAL_WORLD_PHOTO: the pipeline will prioritize an explicitly saved, user-authorized source image that is linked to the article evidence. Use ILLUSTRATION only for original no-text/no-logo generation prompts. A real venue, street, landmark, hotel, meal, ticket, or route must be REAL_WORLD_PHOTO / factual_image_required and must never ask an image model to fabricate a documentary-looking photo. Use INFOGRAPHIC only when structured facts support it; use MAP_OR_ROUTE only when validated coordinates or route data are supplied.
- If revision_feedback exists, fix every blocker without adding unsupported facts.`;

const ENTITY_RESOLUTION_PROMPT = `Resolve destination entities in SoloToChina's evidence store.
- Identity asks whether two references identify the same real-world object. Semantic relatedness, shared topic, shared location, shared category, or cross-language similarity is never sufficient identity evidence.
- Group only references that identify the same physical place, route, venue, attraction, restaurant, station, neighbourhood, or named travel entity within the supplied destination.
- Chinese names, pinyin, common English names, literal translations, abbreviations, and source-language variants may be aliases only when the supplied claims make the identity clear. Never merge merely similar names.
- Classify entity_type as place, attraction, restaurant, hotel, transport_hub, route, city, district, region, country, organization, government_agency, event, category, collection, topic, policy, rule, procedure, product_or_service, or other.
- Classify granularity as specific_entity, collection, category, route, area, city_level, regional, national, or general_topic.
- A specific entity cannot be merged with a collection/category/general topic. A city cannot be merged with a district; a route cannot be merged with a destination. Return DO_NOT_MERGE for obvious type, geography, granularity, canonical-identity, or alias-plausibility violations; do not put those cases in the uncertain queue.
- If two entities are related but not identical, suggest member_of, part_of, located_in, applies_to, related_to, supports, contradicts, generalizes, specializes, derived_from, or example_of instead of a merge.
- Entity and Claim are separate. Phrases such as 'Chongqing attractions (advance reservation)' or 'Hongyadong reservation' are not place aliases merely because a Claim discusses a place.
- Preserve the source claims. This task only establishes canonical entity identity and, where confident, a stable canonical claim key.
- entity_key must be lowercase ASCII dot-separated and semantic, for example attraction.zhongshan_4th_road. canonical_subject should use the clearest reader-facing English/common name; aliases must retain all useful source forms, including Chinese.
- Return claim_updates only when confidence is at least 0.85. Use the same canonical_key only for truly equivalent claim concepts; otherwise preserve the claim's original key.
- For plausible but uncertain identity matches with confidence 0.60-0.84, return candidates with recommendation UNCERTAIN, both type/granularity values, a concise rationale, and any suggested relation. Do not add them to entities or claim_updates.
- Do not guess translations, addresses, venues, or relationships not supported by the supplied claims. Return empty arrays when no safe merge is available.`;

const pagePlanPrompt = (strategyVersion, capabilities) => `You are the Page Composer for SoloToChina Content Production Strategy ${strategyVersion}.
Select the semantic Frontend components and their final order before the writer produces reader-facing copy.
You may only use component IDs and variants published by the current Frontend Component Registry below. Never invent a component, a variant, CSS class, visual style, color, spacing, or layout instruction.
Do not make content type a hardcoded layout template. Select only components that match the actual evidence-backed editorial need.
Do not select deprecated components for a new page. blocks array order is the final intended reader order.
Each writer_guidance explains the evidence-bounded content that the Writer should prepare for this semantic component; it is not visual direction.
Current capability candidates (machine-derived):\n${JSON.stringify(promptCapabilities(capabilities))}`;

const pagePayloadPrompt = (strategyVersion, capabilities) => `Produce a Frontend page payload for SoloToChina Content Production Strategy ${strategyVersion}.
Follow the supplied Page Schema exactly. The blocks array order is final render order.
Use only component IDs, variants, fields, and data schemas published by the current Frontend Component Registry candidates below. Never invent components, variants, props, CSS, styling tokens, or visual instructions.
Use the page plan as an editorial ordering guide. Use only information contained in the supplied canonical content and draft. Preserve uncertainty instead of fabricating facts. Do not use deprecated components in a new payload.
Current capability candidates (machine-derived):\n${JSON.stringify(promptCapabilities(capabilities))}`;

const REVIEW_PROMPT = `Act as an independent senior editor. Audit the English draft against its evidence package and brief.
Fail the draft for any unsupported factual assertion, hidden conflict, misleading certainty, source-key leakage, affiliate contamination, or unsafe advice.
Also check originality, usefulness for solo/first-time/non-Chinese-speaking visitors, SEO/GEO structure, clarity, and whether the evidence ledger honestly covers factual sections.
Do not rewrite the article. Return actionable blockers and warnings.`;

function applyDeterministicGates(review, contentPackage) {
  const draft = contentPackage.draft;
  const facts = contentPackage.facts || [];
  const validKeys = new Set(facts.map((fact) => fact.normalized_key));
  const ledgerKeys = new Set((draft.evidence_ledger || []).flatMap((entry) => entry.claim_keys));
  const issues = [...review.issues];
  const checks = [...review.checks];
  const addGate = (name, passed, detail, code) => {
    checks.push({ name, passed, detail });
    if (!passed) issues.push({ code, severity: "blocker", message: detail });
  };

  const invalidKeys = [...ledgerKeys].filter((key) => !validKeys.has(key));
  addGate("evidence-key-integrity", invalidKeys.length === 0, invalidKeys.length ? `Unknown claim keys: ${invalidKeys.join(", ")}` : "All ledger keys exist in the research package.", "invalid_evidence_key");
  const affiliateLeak = /trip\.com|affiliate|commission|booking link/i.test(draft.body_markdown);
  addGate("commercial-isolation", !affiliateLeak, affiliateLeak ? "Commercial or affiliate language leaked into the Research Draft." : "No commercial language detected.", "commercial_contamination");
  const internalLeak = /\bclaim[_ .-]?key\b|\bevidence ledger\b|\bsrc_[a-f0-9]+\b/i.test(draft.body_markdown);
  addGate("internal-metadata", !internalLeak, internalLeak ? "Internal research metadata appears in reader-facing copy." : "No internal identifiers detected.", "internal_metadata_leak");
  const conflictedKeys = facts.filter((fact) => fact.consensus_status === "conflicted").map((fact) => fact.normalized_key);
  const acknowledged = new Set(draft.unresolved_conflicts || []);
  const hiddenConflicts = conflictedKeys.filter((key) => ledgerKeys.has(key) && !acknowledged.has(key));
  addGate("conflict-disclosure", hiddenConflicts.length === 0, hiddenConflicts.length ? `Used conflicted facts without ledger disclosure: ${hiddenConflicts.join(", ")}` : "Used conflicts are disclosed or avoided.", "hidden_conflict");
  const staleKeys = facts.filter((fact) => fact.freshness_state === "stale").map((fact) => fact.normalized_key);
  const usedStaleKeys = staleKeys.filter((key) => ledgerKeys.has(key));
  addGate("stale-evidence", usedStaleKeys.length === 0, usedStaleKeys.length ? `Draft uses stale facts that must be refreshed or omitted: ${usedStaleKeys.join(", ")}` : "No stale evidence is used.", "stale_evidence_used");
  const verificationKeys = facts.filter((fact) => fact.freshness_state === "time_sensitive" || fact.verification_priority === "requires_official")
    .map((fact) => fact.normalized_key);
  const acknowledgedVerification = new Set(draft.verification_notes || []);
  const hiddenVerification = verificationKeys.filter((key) => ledgerKeys.has(key) && !acknowledgedVerification.has(key));
  addGate("temporal-verification", hiddenVerification.length === 0, hiddenVerification.length ? `Used time-sensitive facts without verification notes: ${hiddenVerification.join(", ")}` : "Time-sensitive evidence is flagged or avoided.", "missing_verification_note");
  addGate("minimum-depth", wordCount(draft.body_markdown) >= 800, `Draft has ${wordCount(draft.body_markdown)} words; minimum evidence-backed review threshold is 800.`, "draft_too_short");
  const seo = draft.seo || {};
  addGate("seo-metadata", Boolean(seo.meta_title && seo.focus_keyword) && String(seo.meta_title).length <= 60 && String(draft.meta_description || "").length <= 160,
    "SEO title, focus keyword, and concise meta description are present.", "seo_metadata_invalid");
  addGate("geo-structure", /(?:^|\n)#{2,3}\s+key takeaways\b/im.test(draft.body_markdown) && /(?:^|\n)#{2,3}\s+frequently asked questions\b/im.test(draft.body_markdown),
    "Reader-facing Key takeaways and Frequently asked questions sections are required.", "geo_structure_missing");
  const expectedVisuals = visualCountForWords(wordCount(draft.body_markdown));
  addGate("visual-plan", Array.isArray(draft.visuals) && draft.visuals.length === expectedVisuals,
    `Draft needs ${expectedVisuals} rights-safe visual plan item(s) for its length.`, "visual_plan_incomplete");
  const strategyVersion = contentPackage.brief?.strategy_version;
  addGate("strategy-version", Boolean(strategyVersion) && draft.strategy_version === strategyVersion,
    "Draft and canonical content plan must carry the same active Content Strategy version.", "strategy_version_mismatch");
  const canonical = contentPackage.brief?.canonical || {};
  addGate("canonical-content", Boolean(canonical.quick_answer) && Array.isArray(canonical.answer_blocks),
    "Canonical content requires an answer-first summary and structured answer blocks before publication.", "canonical_content_incomplete");
  addGate("heading-hierarchy", hasSafeHeadingHierarchy(draft.body_markdown),
    "The post title owns H1; body Markdown may use orderly H2/H3/H4 headings only.", "heading_hierarchy_invalid");
  const visualStrategySafe = (draft.visuals || []).every((visual) => {
    if (visual.image_type === "real_world_photo") {
      if (visual.acquisition_strategy === "use_authorized_source_image") {
        return visual.factual_image_required && Boolean(visual.source_asset_id && visual.source_remote_url);
      }
      return visual.acquisition_strategy === "search_real_image" && visual.factual_image_required;
    }
    if (visual.image_type === "infographic") return visual.acquisition_strategy === "render_infographic";
    if (visual.image_type === "map_or_route") return visual.acquisition_strategy === "render_map";
    return visual.image_type === "illustration" && visual.acquisition_strategy === "generate_illustration" && !visual.factual_image_required;
  });
  addGate("image-strategy", visualStrategySafe,
    "Image plans must never use an image model to fabricate a factual real-world photo or route.", "image_strategy_invalid");
  const graph = draft.schema_jsonld?.["@graph"] || [];
  addGate("schema-consistency", graph.some((item) => item["@type"] === "Article") && graph.every((item) => !/undefined|null/.test(JSON.stringify(item))),
    "Deterministic schema must contain an Article and no placeholder values.", "schema_inconsistent");

  const dedupedIssues = uniqueBy(issues, (item) => `${item.code}:${item.message}`);
  return {
    ...review,
    checks: uniqueBy(checks, (item) => `${item.name}:${item.detail}`),
    issues: dedupedIssues,
    passed: review.passed && !dedupedIssues.some((item) => item.severity === "blocker"),
    score: Math.max(0, review.score - dedupedIssues.filter((item) => item.severity === "blocker").length * 10),
  };
}

function objectSchema(required, properties) {
  return { type: "object", additionalProperties: false, required, properties };
}

function wordCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function visualCountForWords(words) {
  if (words < 800) return 2;
  if (words < 1300) return 2;
  if (words < 2200) return 3;
  if (words < 3200) return 4;
  return 5;
}

function hasSafeHeadingHierarchy(markdown) {
  const levels = [...String(markdown || "").matchAll(/^(#{1,6})\s+/gm)].map((match) => match[1].length);
  if (levels.includes(1)) return false;
  return levels.every((level, index) => level >= 2 && (index === 0 || level <= levels[index - 1] + 1));
}

function uniqueBy(items, key) {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

function promptCapabilities(capabilities) {
  return (capabilities?.components || []).slice(0, 32).map((component) => ({
    id: component.id, category: component.category, purpose: component.purpose, status: component.status,
    variants: component.variants, requiredFields: component.requiredFields, optionalFields: component.optionalFields,
    schema: component.schema,
  }));
}
