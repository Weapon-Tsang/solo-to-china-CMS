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
  ["classification", "production_mode", "production_modes", "production_paths", "confidence", "primary_topic", "entities", "knowledge_points", "claims", "article_potential", "information_density", "topic_completeness", "duplicate_likelihood", "recommended_action", "suggested_content_type", "suggested_article_title", "missing_information", "possible_cluster_topics", "reasoning_summary"],
  {
    classification: { type: "string", enum: ["ARTICLE_CANDIDATE", "KNOWLEDGE_ONLY", "CLAIM_ONLY", "CLUSTER_CANDIDATE", "RESEARCH_REQUIRED", "DUPLICATE", "LOW_VALUE", "UNSURE"] },
    production_mode: { type: "string", enum: ["SOURCE_ADAPTATION", "TOPIC_FEATURE", "MULTI_SOURCE_SYNTHESIS"] },
    production_modes: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", enum: ["SOURCE_ADAPTATION", "TOPIC_FEATURE", "MULTI_SOURCE_SYNTHESIS"] } },
    production_paths: {
      type: "array", minItems: 1, maxItems: 8,
      items: objectSchema(["mode", "content_type", "title", "reader_promise", "why_it_works", "evidence_boundary"], {
        mode: { type: "string", enum: ["SOURCE_ADAPTATION", "TOPIC_FEATURE", "MULTI_SOURCE_SYNTHESIS"] },
        content_type: { type: "string", enum: ["city_guide", "itinerary", "attraction_guide", "food_guide", "transport_guide", "neighborhood_guide", "hotel_area_guide", "shopping_guide", "practical_guide", "first_time_guide", "comparison", "listicle", "how_to"] },
        title: { type: "string" }, reader_promise: { type: "string" }, why_it_works: { type: "string" }, evidence_boundary: { type: "string" },
      }),
    },
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

  async plan(research, options = {}) {
    return this.respond({
      name: "content_brief",
      schema: BRIEF_SCHEMA,
      instructions: briefPrompt(this.contentStrategy.version),
      input: JSON.stringify(research), options,
    });
  }

  async analyzeIntake(research, options = {}) {
    return this.respond({
      name: "content_intake_analysis",
      schema: INTAKE_SCHEMA,
      instructions: intakePrompt(this.contentStrategy.version),
      input: JSON.stringify(research), options,
    });
  }

  async draft(contentPackage, revisionFeedback = null, options = {}) {
    const policy = contentPackage.content_policy || {};
    const result = await this.respond({
      name: "article_draft_v2",
      schema: DRAFT_SCHEMA,
      instructions: draftPrompt(policy),
      input: JSON.stringify({ ...draftInputDto(contentPackage), revision_feedback: revisionFeedback }), options,
    });
    result.output.slug = slugify(result.output.slug || result.output.title);
    result.output.seo ||= {};
    result.output.meta_description = truncate(result.output.meta_description, 160);
    result.output.seo.meta_title = truncate(result.output.seo.meta_title || result.output.title, 70);
    result.output.seo.focus_keyword = truncate(result.output.seo.focus_keyword, 160);
    result.output.seo.secondary_keywords = (result.output.seo.secondary_keywords || []).slice(0, 8).map((item) => truncate(item, 160));
    result.output.seo.search_intent = truncate(result.output.seo.search_intent, 120);
    result.output.seo.key_takeaways = (result.output.seo.key_takeaways || []).slice(0, 6).map((item) => truncate(item, 240));
    result.output.faqs = (result.output.faqs || []).slice(0, policy.faq?.maximum ?? 4).map((item) => ({ question: truncate(item.question, 220), answer: truncate(item.answer, 700) }));
    result.output.visuals = (result.output.visuals || []).slice(0, policy.visuals?.maximum ?? 5).map((item) => ({ ...item, purpose: truncate(item.purpose, 300), alt_text: truncate(item.alt_text, 220), caption: truncate(item.caption, 300), generation_prompt: truncate(item.generation_prompt, 2_000) }));
    return result;
  }

  async composePagePlan(contentPackage, capabilities, options = {}) {
    return this.respond({
      name: "frontend_page_plan",
      schema: PAGE_PLAN_SCHEMA,
      instructions: pagePlanPrompt(contentPackage.brief?.strategy_version || this.contentStrategy.version, capabilities),
      input: JSON.stringify({
        canonical: contentPackage.brief?.canonical || {}, outline: contentPackage.brief?.plan || {},
        facts: (contentPackage.facts || []).map((fact) => ({ key: fact.normalized_key, subject: fact.subject, predicate: fact.predicate, status: fact.consensus_status })),
      }), options,
    });
  }

  async resolveEntities(entityPackage, options = {}) {
    return this.respond({
      name: "destination_entity_resolution",
      schema: ENTITY_RESOLUTION_SCHEMA,
      instructions: ENTITY_RESOLUTION_PROMPT,
      input: JSON.stringify(entityPackage), options,
    });
  }

  async composeFrontendPage(contentPackage, capabilities, pageSchema, options = {}) {
    return this.respond({
      name: "frontend_page_payload",
      schema: pageSchema,
      instructions: pagePayloadPrompt(contentPackage.brief?.strategy_version || this.contentStrategy.version, capabilities),
      input: JSON.stringify({
        page_plan: contentPackage.frontend_page_plan?.plan || null,
        canonical: contentPackage.brief?.canonical || {},
        draft: contentPackage.draft,
        visuals: contentPackage.draft?.visuals || [],
      }), options,
    });
  }

  async review(contentPackage, options = {}) {
    const modelReview = await this.respond({
      name: "quality_review_v2",
      schema: REVIEW_SCHEMA,
      instructions: REVIEW_PROMPT,
      input: JSON.stringify(reviewInputDto(contentPackage)), options,
    });
    return { ...modelReview, output: applyDeterministicGates(modelReview.output, contentPackage) };
  }

  async respond({ name, schema, instructions, input, options = {} }) {
    return this.client.completeJson({ name, schema, instructions, content: input, signal: options.signal || null });
  }
}

function draftInputDto(contentPackage) {
  return {
    brief: contentPackage.brief,
    production_mode: contentPackage.production_mode || "multi_source_synthesis",
    source_reference: contentPackage.source_reference || null,
    content_policy: contentPackage.content_policy,
    facts: (contentPackage.facts || []).map((fact) => ({
      normalized_key: fact.normalized_key, subject: fact.subject, predicate: fact.predicate,
      preferred_value: fact.preferred_value, consensus_status: fact.consensus_status,
      freshness_state: fact.freshness_state, verification_priority: fact.verification_priority,
      latest_evidence_at: fact.latest_evidence_at, consensus_method: fact.consensus_method,
      consensus_confidence: fact.consensus_confidence, consensus_detail: fact.consensus_detail,
      validity_state: fact.validity_state,
      evidence: (fact.evidence || []).map((item) => ({ source_id: item.source_id, value: item.value,
        quote: item.quote, canonical_url: item.canonical_url, source_title: item.source_title,
        published_at: item.published_at, observed_at: item.observed_at, captured_at: item.captured_at,
        verified_at: item.verified_at, valid_from: item.valid_from, valid_to: item.valid_to,
        date_kind: item.date_kind, date_confidence: item.date_confidence,
        timestamp_basis: item.timestamp_basis, authority_level: item.authority_level })),
    })),
    reader_sources: contentPackage.reader_sources || [],
    internal_link_inventory: contentPackage.internal_link_inventory || [],
    frontend_page_plan: contentPackage.frontend_page_plan?.plan || null,
  };
}

function reviewInputDto(contentPackage) {
  return {
    brief: { plan: contentPackage.brief?.plan, canonical: contentPackage.brief?.canonical, strategy_version: contentPackage.brief?.strategy_version },
    content_policy: contentPackage.content_policy,
    facts: draftInputDto(contentPackage).facts,
    reader_sources: contentPackage.reader_sources || [],
    draft: contentPackage.draft,
    frontend_page: contentPackage.frontend_page ? {
      payload: contentPackage.frontend_page.payload,
      validation: contentPackage.frontend_page.validation,
      current: contentPackage.frontend_page.current,
      status: contentPackage.frontend_page.status,
    } : null,
  };
}
const intakePrompt = (strategyVersion) => `Analyze one already-captured human-selected China travel source for SoloToChina Content Production Strategy ${strategyVersion}.
- This is decision support, not article generation. Do not write an article and do not reveal private reasoning.
- Use only the supplied source and structured claims. A useful narrow fact can be KNOWLEDGE_ONLY or CLAIM_ONLY, but a coherent small topic can be a standalone TOPIC_FEATURE.
- Do not judge a travel article against an encyclopedic destination checklist. Judge whether the evidence fulfills one clear, bounded reader promise.
- Complete itineraries, one-day routes, food lists, hotel-area guides, photo-location lists and similarly useful source notes can be ARTICLE_CANDIDATE in SOURCE_ADAPTATION mode when editing rights are supplied. They do not need unrelated destination facts or a second source.
- Treat SOURCE_ADAPTATION, TOPIC_FEATURE and MULTI_SOURCE_SYNTHESIS as parallel, non-exclusive opportunity paths. A source may support several paths at the same time; multi-source synthesis is a creative option, not an emergency fallback.
- Classify the source as ARTICLE_CANDIDATE, KNOWLEDGE_ONLY, CLAIM_ONLY, CLUSTER_CANDIDATE, RESEARCH_REQUIRED, DUPLICATE, LOW_VALUE, or UNSURE.
- Set production_mode to the best primary path for the first proposed article, but return every applicable path in production_modes. SOURCE_ADAPTATION requires source.editing_allowed=true; the other paths remain available independently.
- Return concrete production_paths for the useful articles this source can support. Every path becomes an independently approvable opportunity, so assign its exact content_type, specific title, bounded reader promise, direct explanation of why it works, and exact evidence boundary. Explain in plain operator language; do not use vague labels.
- Score article_potential, information_density, topic_completeness, and duplicate_likelihood from 0 to 100. Confidence is 0 to 1.
- Recommend one action: CREATE_CONTENT_PLAN, ADD_TO_KNOWLEDGE, ADD_TO_CLUSTER, RESEARCH_FIRST, MERGE_OR_IGNORE, IGNORE, or HUMAN_REVIEW.
- Return 3-8 distinct, specific possible_cluster_topics when the evidence supports a useful series. Missing broad destination coverage is not a blocker for a narrow topic.
- Surface only missing facts that are necessary for the proposed reader promise, especially safety-critical or time-sensitive booking, price, route, opening-hour, location, or warning details.
- reasoning_summary must be a detailed, direct 4-8 sentence operator-facing explanation in Chinese. State which parallel routes are usable, why, what is genuinely missing, and what is not a blocker. Never provide hidden chain-of-thought. Commercial conversion is outside this task.`;

const briefPrompt = (strategyVersion) => `Create an evidence-backed English content plan and Canonical Travel Content object for SoloToChina Content Production Strategy ${strategyVersion}.
- Audience: independent international visitors, especially solo travelers, first-time China visitors, and people who cannot read Chinese.
- Use only the supplied knowledge facts. Claim keys in the outline must exactly match supplied keys.
- Unresolved strict safety/semantic conflicts require explicit handling instructions; never silently choose a side.
- Dynamic prices, hours, reservations, schedules and access details are already selected by an auditable independent-source, source-quality and recency-weighted consensus. They do not require manual official verification. Include the supplied current value when useful, state the evidence date and normal change risk, and prefer higher-confidence conclusions. Dated evidence may be used with a clear as-of caveat rather than discarded.
- Follow the selected production_mode for this one plan, without treating the other parallel routes as disabled. For source_adaptation, preserve the authorized source's useful itinerary, selection, sequence and practical intent while writing original English copy; do not copy wording or claim facts outside that source package. For topic_feature, fulfill only the bounded topic promise. For multi_source_synthesis, deliberately combine compatible perspectives across sources; it is a creative format, not a completeness repair step.
- When editorial_assignment is present, it is an explicit administrator-provided writing assignment. Follow its title, brief, and target_entities closely, but use only its selected evidence package. Do not broaden it into a destination encyclopedia. Honor visual_brief when safe: route_sketch means an original conceptual editorial illustration, not a geographically accurate navigation map; never invent roads, coordinates, labels, or travel times.
- Include practical adaptation for language, booking, payment, navigation, safety, and solo logistics where evidence permits.
- Canonical fields are structured source data for the writer and renderer. Use empty arrays or empty strings for unknown information rather than guessing.
- Include direct answer blocks only where the supplied facts support them. The image plan must distinguish real_world_photo, infographic, map_or_route, and illustration; only illustration is eligible for image-model generation.
- Affiliate inventory and commercial conversion are outside this task and must not appear.`;

const draftPrompt = (policy) => `Write an original, publication-quality English China travel guide from the supplied brief and evidence package.
- Never invent a price, opening hour, policy, route, booking rule, safety guarantee, or other fact.
- Use only supplied claim keys; report strict conflicts and temporal uncertainty transparently.
- Write for solo, first-time, non-Chinese-speaking travelers without stereotyping or alarmism.
- Do not mention Xiaohongshu, source authors, internal claim keys, evidence ledgers, affiliate products, Trip.com, or commercial calls to action in body_markdown.
- Follow the production_mode selected for this article. A rights-authorized source_adaptation may faithfully preserve one source's itinerary, selections and practical structure in original English wording. topic_feature should stay narrow. multi_source_synthesis deliberately combines compatible perspectives, while the other routes remain valid future opportunities from the same evidence.
- Return a separate evidence ledger mapping each article section to exact claim keys and source IDs.
- For every used time_sensitive, provisional_latest, or refresh_recommended fact, list its claim key in verification_notes and state its supplied evidence date and normal change risk in reader-facing copy. This is disclosure, not an instruction for a human to verify an official page.
- The article should be useful even with no commercial module. Follow this evidence-scaled content policy: ${JSON.stringify(policy)}. Never pad thin evidence to reach a word target.
- Make the body easy for Search and AI answer systems to parse: use one answer-first opening paragraph, descriptive H2/H3 headings, short scannable sections, and a visible "Key takeaways" list. Do not make unsupported claims just for SEO.
- FAQ is optional. Include it only when content_policy.faq.allowed is true and the supplied evidence answers real reader questions. When present, include the exact same questions and answers in a visible "Frequently asked questions" section of body_markdown; otherwise return an empty faqs array and omit that section.
- Return SEO metadata: a natural meta title under 60 characters, one focus keyword, and 3-6 reader-facing key takeaways. The meta description remains the top-level meta_description field.
- Return SEO metadata with secondary keywords and search intent. Use internal links only from internal_link_inventory and preserve their exact URL. Do not invent canonical URLs.
- Add a visible "Sources" section when reader_sources is non-empty. Use human-readable source titles, real URLs, and published/verified dates where provided. Never expose internal source or claim IDs.
- If the evidence package includes a frontend_page_plan, honor its semantic section order and writer guidance in the reader-facing article. It is a composition plan, not permission to invent components, props, or visual styling.
- Return a rights-safe image plan within content_policy.visuals limits. Every item needs accurate alt text, a useful placement, caption, image type, role, subject, factual_image_required, and aspect ratio. When a factual real-world visual supports the evidence, plan REAL_WORLD_PHOTO: the pipeline will prioritize an explicitly saved, user-authorized source image that is linked to the article evidence. Use ILLUSTRATION only for original no-text/no-logo generation prompts. A real venue, street, landmark, hotel, meal, ticket, or route must be REAL_WORLD_PHOTO / factual_image_required and must never ask an image model to fabricate a documentary-looking photo. Use INFOGRAPHIC only when structured facts support it; use MAP_OR_ROUTE only when validated coordinates or route data are supplied.
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
When the Registry publishes an image component, use it only for supplied visuals that already include a positive wordpress_media_id. Copy that ID to media_id and preserve the supplied alt text and caption. Place each selected image explicitly in blocks[]; never invent a media ID or an image URL.
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
  const verificationKeys = facts.filter((fact) => fact.freshness_state === "time_sensitive"
    || ["RECENCY_WEIGHTED_CONSENSUS", "LATEST_WEIGHTED_PROVISIONAL", "SINGLE_SOURCE_LATEST"].includes(fact.consensus_method))
    .map((fact) => fact.normalized_key);
  const acknowledgedVerification = new Set(draft.verification_notes || []);
  const datedDisclosureKeys = new Set([...verificationKeys, ...usedStaleKeys]);
  const hiddenVerification = [...datedDisclosureKeys].filter((key) => ledgerKeys.has(key) && !acknowledgedVerification.has(key));
  addGate("temporal-disclosure", hiddenVerification.length === 0, hiddenVerification.length ? `Used dynamic or dated facts without an as-of disclosure: ${hiddenVerification.join(", ")}` : "Dynamic and dated evidence is disclosed or avoided.", "missing_temporal_disclosure");
  const policy = contentPackage.content_policy || { minimum_words: 800, faq: { required: true, allowed: true }, visuals: { minimum: 2, maximum: 5 } };
  addGate("minimum-depth", wordCount(draft.body_markdown) >= policy.minimum_words,
    `Draft has ${wordCount(draft.body_markdown)} words; this task requires at least ${policy.minimum_words} evidence-backed words.`, "draft_too_short");
  const seo = draft.seo || {};
  addGate("seo-metadata", Boolean(seo.meta_title && seo.focus_keyword) && String(seo.meta_title).length <= 60 && String(draft.meta_description || "").length <= 160,
    "SEO title, focus keyword, and concise meta description are present.", "seo_metadata_invalid");
  const hasTakeaways = /(?:^|\n)#{2,3}\s+key takeaways\b/im.test(draft.body_markdown);
  const hasVisibleFaq = /(?:^|\n)#{2,3}\s+frequently asked questions\b/im.test(draft.body_markdown);
  const faqCount = Array.isArray(draft.seo?.faqs) ? draft.seo.faqs.length : 0;
  addGate("geo-structure", hasTakeaways && (!policy.faq?.required || hasVisibleFaq),
    "Required reader-facing answer structure is present for this content task.", "geo_structure_missing");
  addGate("faq-consistency", policy.faq?.allowed ? (faqCount === 0 ? !hasVisibleFaq : hasVisibleFaq) : faqCount === 0 && !hasVisibleFaq,
    "FAQ exists only when the task policy and visible article support it.", "faq_policy_mismatch");
  const readerSources = contentPackage.reader_sources || [];
  const hasVisibleSources = !readerSources.length || (/(?:^|\n)#{2,3}\s+sources\b/im.test(draft.body_markdown)
    && readerSources.some((source) => String(draft.body_markdown).includes(source.url)));
  addGate("reader-source-traceability", hasVisibleSources,
    "Reader-facing sources use real titles, URLs, and available evidence dates without internal IDs.", "reader_sources_missing");
  const visualCount = Array.isArray(draft.visuals) ? draft.visuals.length : 0;
  addGate("visual-plan", visualCount >= (policy.visuals?.minimum || 0) && visualCount <= (policy.visuals?.maximum || 5),
    `Draft visual plan count ${visualCount} must be within ${policy.visuals?.minimum || 0}-${policy.visuals?.maximum || 5}.`, "visual_plan_incomplete");
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
  const incompleteRequiredVisuals = (draft.visuals || []).filter((visual) => visual.factual_image_required
    && !(visual.status === "generated" && (visual.media_url || visual.wordpress_media_url)));
  addGate("required-visual-assets", incompleteRequiredVisuals.length === 0,
    incompleteRequiredVisuals.length ? "One or more factual visuals lack a verified media asset." : "All required factual visuals have real assets.",
    "required_visual_missing");
  const unsupportedVisualRenders = (draft.visuals || []).filter((visual) => ["render_infographic", "render_map"].includes(visual.acquisition_strategy)
    && visual.status !== "generated");
  addGate("specialized-visual-renderers", unsupportedVisualRenders.length === 0,
    unsupportedVisualRenders.length ? "A planned map or infographic has no completed renderer output." : "Specialized visuals are complete or not required.",
    "visual_renderer_incomplete");
  const page = contentPackage.frontend_page;
  if (page || contentPackage.frontend_page_plan) {
    const payload = page?.payload || {};
    const pageText = visiblePageText(payload);
    const criticalHeadings = [...String(draft.body_markdown || "").matchAll(/^##\s+(.+)$/gm)].map((match) => normalizeComparable(match[1]));
    const missingHeadings = criticalHeadings.filter((heading) => !pageText.includes(heading));
    addGate("final-page-valid", Boolean(page?.current && page.status === "valid" && page.validation?.valid && payload.blocks?.length),
      "The QA artifact must be the current, schema-valid, non-empty final editorial Page Payload.", "final_page_invalid");
    addGate("final-page-content", normalizeComparable(payload.metadata?.title) === normalizeComparable(draft.title) && missingHeadings.length === 0,
      missingHeadings.length ? `Final page omits critical headings: ${missingHeadings.join(", ")}` : "Final page title and critical section headings match the draft.",
      "final_page_content_missing");
  }
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

function visiblePageText(payload) {
  const values = [payload?.metadata?.title];
  const visit = (value) => {
    if (typeof value === "string") values.push(value.replace(/<[^>]+>/g, " "));
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => {
      if (!/(?:url|id|strategy|media)/i.test(key)) visit(item);
    });
  };
  visit(payload?.blocks || []);
  return normalizeComparable(values.join(" "));
}

function normalizeComparable(value) {
  return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
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
