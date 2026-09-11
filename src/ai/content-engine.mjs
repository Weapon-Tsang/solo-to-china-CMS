import { slugify, truncate } from "../utils.mjs";
import { CONTENT_STRATEGY } from "../content-strategy.mjs";
import { createAiClient } from "./client.mjs";
import { pageBlockSignature, protectedFactTokens, validatePageEvidence } from "../evidence-validator.mjs";
import { titlePromiseRisks } from "../seo-geo.mjs";
import { separateQualityResults } from "../services/content-recovery-policy.mjs";

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
      items: objectSchema(["section_id", "heading", "purpose", "claim_keys"], {
        section_id: { type: "string" },
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

const EXPERIENCE_SCHEMA = objectSchema(["blocks"], {
  // Keep the provider schema below Vertex's structured-output complexity
  // ceiling. The repository enforces the 20-block cap deterministically.
  blocks: { type: "array", items: objectSchema(
    ["type", "title", "traveler_goal", "segment_ids", "sequence", "decision_logic", "conditions", "tradeoffs", "warnings", "alternatives", "supporting_claim_ids", "evidence_span_ids", "confidence"],
    {
      type: { type: "string", enum: ["ROUTE", "DECISION", "CONDITION", "TRADEOFF", "WARNING", "ALTERNATIVE", "PROCESS", "FIELD_NOTE"] },
      title: { type: "string" }, traveler_goal: { type: "string" },
      segment_ids: { type: "array", items: { type: "string" } },
      sequence: { type: "array", items: { type: "string" } },
      decision_logic: { type: "array", items: { type: "string" } },
      conditions: { type: "array", items: { type: "string" } },
      tradeoffs: { type: "array", items: { type: "string" } },
      warnings: { type: "array", items: { type: "string" } },
      alternatives: { type: "array", items: { type: "string" } },
      supporting_claim_ids: { type: "array", items: { type: "string" } },
      evidence_span_ids: { type: "array", items: { type: "string" } },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    }),
  },
});

const ASSEMBLY_SCHEMA = objectSchema(
  ["selected_fact_keys", "selected_experience_block_ids", "selected_source_ids", "selected_blueprint_source_ids", "exclusions", "rationale"],
  {
    selected_fact_keys: { type: "array", maxItems: 48, items: { type: "string" } },
    selected_experience_block_ids: { type: "array", maxItems: 24, items: { type: "string" } },
    selected_source_ids: { type: "array", maxItems: 24, items: { type: "string" } },
    selected_blueprint_source_ids: { type: "array", maxItems: 8, items: { type: "string" } },
    exclusions: { type: "array", maxItems: 32, items: { type: "string" } },
    rationale: { type: "string" },
  },
);

const NARRATIVE_SCHEMA = objectSchema(
  ["opening_job", "throughline", "route_sequence", "experience_placements", "supporting_fact_keys", "conditional_branches", "tradeoffs", "exclusions", "closing_decision"],
  {
    opening_job: { type: "string" }, throughline: { type: "string" },
    route_sequence: { type: "array", maxItems: 24, items: { type: "string" } },
    experience_placements: { type: "array", maxItems: 24, items: objectSchema(["experience_block_id", "section_id", "purpose"], {
      experience_block_id: { type: "string" }, section_id: { type: "string" }, purpose: { type: "string" },
    }) },
    supporting_fact_keys: { type: "array", maxItems: 48, items: { type: "string" } },
    conditional_branches: { type: "array", maxItems: 24, items: { type: "string" } },
    tradeoffs: { type: "array", maxItems: 24, items: { type: "string" } },
    exclusions: { type: "array", maxItems: 24, items: { type: "string" } },
    closing_decision: { type: "string" },
  },
);

const DRAFT_SCHEMA = objectSchema(
  ["title", "slug", "meta_description", "body_markdown", "evidence_ledger", "unresolved_conflicts", "verification_notes", "seo", "faqs", "visuals"],
  {
    title: { type: "string" }, slug: { type: "string" }, meta_description: { type: "string" }, body_markdown: { type: "string" },
    evidence_ledger: {
      type: "array",
      items: objectSchema(["section_id", "section", "content_node_ids", "claim_keys", "source_ids"], {
        section_id: { type: "string" },
        section: { type: "string" },
        content_node_ids: { type: "array", items: { type: "string" } },
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

const DRAFT_REPAIR_SCHEMA = objectSchema(
  ["base_content_hash", "replacement_sections", "metadata", "evidence_ledger", "verification_notes"],
  {
    base_content_hash: { type: "string" },
    replacement_sections: {
      type: "array", maxItems: 3,
      items: objectSchema(["heading", "body_markdown"], {
        heading: { type: "string" }, body_markdown: { type: "string" },
      }),
    },
    metadata: objectSchema([], {
      title: { type: "string" }, meta_description: { type: "string" },
      meta_title: { type: "string" }, focus_keyword: { type: "string" },
    }),
    evidence_ledger: {
      type: "array", maxItems: 24,
      items: objectSchema(["section_id", "section", "content_node_ids", "claim_keys", "source_ids"], {
        section_id: { type: "string" }, section: { type: "string" },
        content_node_ids: { type: "array", items: { type: "string" } },
        claim_keys: { type: "array", maxItems: 12, items: { type: "string" } },
        source_ids: { type: "array", items: { type: "string" } },
      }),
    },
    verification_notes: { type: "array", maxItems: 48, items: { type: "string" } },
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
      items: objectSchema(["content_node_id", "source_section_ids", "claim_keys", "factuality", "type", "semantic_role", "writer_guidance"], {
        content_node_id: { type: "string" },
        source_section_ids: { type: "array", items: { type: "string" } },
        claim_keys: { type: "array", items: { type: "string" } },
        factuality: { type: "string", enum: ["factual", "non_factual"] },
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

  async analyzeExperience(sourcePackage, options = {}) {
    return this.respond({
      name: "experience_extraction",
      schema: EXPERIENCE_SCHEMA,
      instructions: EXPERIENCE_PROMPT,
      input: JSON.stringify(sourcePackage), options,
    });
  }

  async assembleEditorial(assemblyPackage, options = {}) {
    return this.respond({
      name: "editorial_assembly",
      schema: ASSEMBLY_SCHEMA,
      instructions: ASSEMBLY_PROMPT,
      input: JSON.stringify(assemblyPackage), options,
    });
  }

  async planNarrative(contentPackage, options = {}) {
    return this.respond({
      name: "narrative_plan",
      schema: NARRATIVE_SCHEMA,
      instructions: NARRATIVE_PROMPT,
      input: JSON.stringify(contentPackage), options,
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
    result.output.meta_description = truncate(result.output.meta_description, 500);
    result.output.seo.meta_title = truncate(result.output.seo.meta_title || result.output.title, 200);
    result.output.seo.focus_keyword = truncate(result.output.seo.focus_keyword, 160);
    result.output.seo.secondary_keywords = (result.output.seo.secondary_keywords || []).slice(0, 8).map((item) => truncate(item, 160));
    result.output.seo.search_intent = truncate(result.output.seo.search_intent, 120);
    result.output.seo.key_takeaways = (result.output.seo.key_takeaways || []).slice(0, 6).map((item) => truncate(item, 240));
    result.output.faqs = (result.output.faqs || []).slice(0, policy.faq?.maximum ?? 4).map((item) => ({ question: truncate(item.question, 220), answer: truncate(item.answer, 700) }));
    result.output.visuals = (result.output.visuals || []).slice(0, policy.visuals?.maximum ?? 5).map((item) => ({ ...item, purpose: truncate(item.purpose, 300), alt_text: truncate(item.alt_text, 220), caption: truncate(item.caption, 300), generation_prompt: truncate(item.generation_prompt, 2_000) }));
    return result;
  }

  async repairDraft(contentPackage, issues = [], options = {}) {
    const existing = contentPackage?.draft;
    if (!existing?.content_hash) throw new Error("Bounded repair requires a persisted draft content hash.");
    const repairInput = compactDraftRepairInput(contentPackage, issues);
    const result = await this.respond({
      name: "bounded_draft_repair",
      schema: DRAFT_REPAIR_SCHEMA,
      instructions: DRAFT_REPAIR_PROMPT,
      input: JSON.stringify(repairInput), options,
    });
    result.output = applyBoundedDraftRepair(existing, result.output, issues, { validFactKeys: repairInput.facts.map((fact) => fact.normalized_key) });
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
    const result = await this.respond({
      name: "frontend_page_payload",
      schema: pageSchemaWithCmsProvenance(pageSchema),
      instructions: pagePayloadPrompt(contentPackage.brief?.strategy_version || this.contentStrategy.version, capabilities),
      input: JSON.stringify({
        page_plan: contentPackage.frontend_page_plan?.plan || null,
        canonical: contentPackage.brief?.canonical || {},
        draft: contentPackage.draft,
        visuals: contentPackage.draft?.visuals || [],
      }), options,
    });
    const separated = separateCmsProvenance(result.output, contentPackage.frontend_page_plan?.plan);
    return { ...result, output: separated.payload, provenance: separated.provenance };
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
    return this.client.completeJson({ name, schema, instructions, content: input, signal: options.signal || null,
      telemetryContext: options.telemetryContext || null });
  }
}

export function applyBoundedDraftRepair(draft, patch, issues = [], { validFactKeys = [] } = {}) {
  if (!draft?.content_hash || patch?.base_content_hash !== draft.content_hash) {
    throw Object.assign(new Error("Draft repair base hash does not match the current persisted revision."), { code: "STALE_DRAFT_REPAIR" });
  }
  const replacements = patch.replacement_sections || [];
  if (replacements.length > 3) throw new Error("A bounded repair may replace at most three H2 sections.");
  let body = String(draft.body_markdown || draft.body || "");
  const seen = new Set();
  for (const replacement of replacements) {
    const heading = String(replacement.heading || "").trim().replace(/^##\s+/, "");
    const key = heading.toLowerCase();
    if (!heading || seen.has(key)) throw new Error("Draft repair headings must be unique and non-empty.");
    seen.add(key);
    const sections = markdownH2Sections(body);
    const section = sections.find((item) => item.heading.toLowerCase() === key);
    if (!section) throw Object.assign(new Error(`Draft repair cannot replace unknown H2 section: ${heading}`), { code: "INVALID_DRAFT_REPAIR_SCOPE" });
    const replacementBody = String(replacement.body_markdown || "").trim();
    if (!replacementBody || /^##\s+/m.test(replacementBody)) {
      throw Object.assign(new Error("A replacement section must contain body content only and cannot introduce H2 headings."), { code: "INVALID_DRAFT_REPAIR_SCOPE" });
    }
    body = `${body.slice(0, section.contentStart)}\n${replacementBody}\n${body.slice(section.end).replace(/^\n+/, "")}`;
  }
  const issueCodes = (issues || []).map((issue) => String(issue?.code || issue || "").toLowerCase());
  const metadataAllowed = issueCodes.some((code) => /seo|title|meta|keyword|slug/.test(code));
  const currentMetadata = {title:draft.title,meta_description:draft.meta_description,meta_title:draft.seo?.meta_title,focus_keyword:draft.seo?.focus_keyword};
  const metadata = Object.fromEntries(Object.entries(patch.metadata || {}).filter(([key,value])=>value!==currentMetadata[key]));
  if (Object.keys(metadata).length && !metadataAllowed) {
    throw Object.assign(new Error("Metadata changes were not authorized by the failed QA fields."), { code: "INVALID_DRAFT_REPAIR_SCOPE" });
  }
  const seo = { ...(draft.seo || {}) };
  if (metadata.meta_title != null) seo.meta_title = truncate(metadata.meta_title, 70);
  if (metadata.focus_keyword != null) seo.focus_keyword = truncate(metadata.focus_keyword, 160);
  const evidenceAllowed = issueCodes.some((code) => /evidence|coverage|temporal|conflict|factual/.test(code));
  const nextLedger = patch.evidence_ledger || draft.evidence_ledger || [];
  const nextNotes = patch.verification_notes || draft.verification_notes || [];
  const ledgerChanged = JSON.stringify(nextLedger) !== JSON.stringify(draft.evidence_ledger || []);
  const notesChanged = JSON.stringify(nextNotes) !== JSON.stringify(draft.verification_notes || []);
  if ((ledgerChanged || notesChanged) && !evidenceAllowed) {
    throw Object.assign(new Error("Evidence ledger changes were not authorized by the failed QA fields."), { code: "INVALID_DRAFT_REPAIR_SCOPE" });
  }
  const allowedKeys = new Set(validFactKeys);
  const ledgerKeys = nextLedger.flatMap((entry) => entry?.claim_keys || []);
  if (nextLedger.length > 24 || nextLedger.some((entry) => !entry || !Array.isArray(entry.claim_keys) || entry.claim_keys.length > 12)
      || (allowedKeys.size && ledgerKeys.some((key) => !allowedKeys.has(key)))) {
    throw Object.assign(new Error("Repaired evidence ledger exceeds its bounded scope or references an unknown fact."), { code: "INVALID_DRAFT_REPAIR_SCOPE" });
  }
  return {
    ...draft,
    body_markdown: body.trim(),
    title: metadata.title == null ? draft.title : truncate(metadata.title, 220),
    meta_description: metadata.meta_description == null ? draft.meta_description : truncate(metadata.meta_description, 160),
    seo,
    faqs: draft.faqs || draft.seo?.faqs || [],
    evidence_ledger: nextLedger,
    unresolved_conflicts: draft.unresolved_conflicts || [],
    verification_notes: nextNotes.slice(0, 48),
    visuals: draft.visuals || [],
  };
}

function markdownH2Sections(body) {
  const headings = [...String(body).matchAll(/^##\s+(.+?)\s*$/gm)];
  return headings.map((match, index) => ({
    heading: match[1].trim(),
    contentStart: match.index + match[0].length,
    end: headings[index + 1]?.index ?? body.length,
  }));
}

function draftInputDto(contentPackage) {
  const selectedKeys = new Set(contentPackage.writing_packet?.selected_fact_keys || contentPackage.brief?.evidence_ledger || []);
  return {
    brief: contentPackage.brief,
    writing_packet: contentPackage.writing_packet ? {
      text: contentPackage.writing_packet.packet_text,
      evidence_ledger: contentPackage.writing_packet.evidence_ledger,
    } : null,
    narrative_plan: contentPackage.narrative_plan || null,
    production_mode: contentPackage.production_mode || "multi_source_synthesis",
    source_reference: contentPackage.source_reference || null,
    content_policy: contentPackage.content_policy,
    evidence_ledger_facts: (contentPackage.facts || []).filter((fact) => !selectedKeys.size || selectedKeys.has(fact.normalized_key)).map((fact) => ({
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
        timestamp_basis: item.timestamp_basis, authority_level: item.authority_level,
        publication_usability: item.publication_usability, evidence_coverage: item.evidence_coverage,
        coverage_limitations: item.coverage_limitations || [] })),
    })),
    reader_sources: contentPackage.reader_sources || [],
    authorized_source_assets: contentPackage.authorized_source_assets || [],
    internal_link_inventory: contentPackage.internal_link_inventory || [],
    frontend_page_plan: contentPackage.frontend_page_plan?.plan || null,
  };
}

function factDtos(contentPackage) {
  return draftInputDto(contentPackage).evidence_ledger_facts || [];
}

function compactDraftRepairInput(contentPackage, issues = []) {
  const draft = contentPackage.draft;
  const brief = contentPackage.brief || {};
  const issueCodes = new Set((issues || []).map((issue) => String(issue?.code || '')));
  const mentioned = new Set();
  for (const issue of issues || []) {
    for (const match of String(issue?.message || '').matchAll(/[a-z][a-z0-9_]+(?:\.[a-z0-9_]+){1,4}/gi)) mentioned.add(match[0]);
  }
  const issueText = (issues || []).map((issue) => `${issue?.code || ""} ${issue?.message || ""}`).join(" ").toLowerCase();
  const outline = brief.plan?.outline || brief.outline || [];
  const affectedSections = outline.filter((section) => issueText.includes(String(section.heading || section.section_id || "").toLowerCase()));
  for (const section of affectedSections) for (const key of section.claim_keys || []) mentioned.add(key);
  if (!mentioned.size) for (const entry of draft.evidence_ledger || []) for (const key of entry.claim_keys || []) mentioned.add(key);
  const allFacts = factDtos(contentPackage);
  const facts = allFacts.filter((fact) => mentioned.has(fact.normalized_key));
  const fallbackFacts = facts.length ? facts : allFacts;
  const compactIssues = (issues || []).slice(0, 12).map((issue) => ({
    code: issue.code, severity: issue.severity,
    message: String(issue.message || '').split(',').slice(0, 8).join(',').slice(0, 1_200),
  }));
  return {
    base_content_hash: draft.content_hash,
    issues: compactIssues,
    allowed_changes: {
      evidence_ledger: [...issueCodes].some((code) => /evidence|coverage|temporal|conflict|factual/.test(code)),
      metadata: [...issueCodes].some((code) => /seo|title|meta|keyword|slug/.test(code)),
      maximum_replacement_sections: 3,
    },
    brief: {
      title: brief.plan?.title || brief.title,
      reader_promise: brief.plan?.reader_promise || brief.canonical?.reader_promise,
      outline: (brief.plan?.outline || brief.outline || []).map((section) => ({
        section_id: section.section_id, heading: section.heading,
        claim_keys: (section.claim_keys || []).filter((key) => fallbackFacts.some((fact) => fact.normalized_key === key)).slice(0, 12),
      })),
    },
    facts: fallbackFacts.map((fact) => ({
      normalized_key: fact.normalized_key, subject: fact.subject, predicate: fact.predicate,
      preferred_value: fact.preferred_value, consensus_status: fact.consensus_status,
      freshness_state: fact.freshness_state, latest_evidence_at: fact.latest_evidence_at,
      evidence: (fact.evidence || []).map((item) => ({ source_id: item.source_id, value: item.value,
        quote: item.quote, qualifiers: item.qualifiers || [], coverage_limitations: item.coverage_limitations || [],
        published_at: item.published_at, observed_at: item.observed_at, captured_at: item.captured_at })),
    })),
    draft: { title:draft.title, body_markdown:draft.body_markdown, meta_description:draft.meta_description,
      seo:draft.seo, evidence_ledger:draft.evidence_ledger, verification_notes:draft.verification_notes },
  };
}

function reviewInputDto(contentPackage) {
  return {
    brief: { plan: contentPackage.brief?.plan, canonical: contentPackage.brief?.canonical, strategy_version: contentPackage.brief?.strategy_version },
    content_policy: contentPackage.content_policy,
    facts: factDtos(contentPackage),
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
- Return concrete production_paths as editorial proposals only. A captured source adds Claims and Knowledge; it does not create a content opportunity by itself. A proposal becomes an actual production opportunity only after explicit approval or a destination-level multi-source synthesis gate. Assign each proposal an exact content_type, specific title, bounded reader promise, direct explanation of why it works, and exact evidence boundary.
- Score article_potential, information_density, topic_completeness, and duplicate_likelihood from 0 to 100. Confidence is 0 to 1.
- Recommend one action: CREATE_CONTENT_PLAN, ADD_TO_KNOWLEDGE, ADD_TO_CLUSTER, RESEARCH_FIRST, MERGE_OR_IGNORE, IGNORE, or HUMAN_REVIEW.
- Return 3-8 distinct, specific possible_cluster_topics when the evidence supports a useful series. Missing broad destination coverage is not a blocker for a narrow topic.
- Surface only missing facts that are necessary for the proposed reader promise, especially safety-critical or time-sensitive booking, price, route, opening-hour, location, or warning details.
- reasoning_summary must be a detailed, direct 4-8 sentence operator-facing explanation in Chinese. State which parallel routes are usable, why, what is genuinely missing, and what is not a blocker. Never provide hidden chain-of-thought. Commercial conversion is outside this task.`;

const EXPERIENCE_PROMPT = `Extract grounded traveler Experience Blocks from the captured source after Claim extraction.
- An Experience Block preserves useful sequence, decision logic, conditions, trade-offs, warnings, alternatives or field-observation context that atomic Claims alone lose.
- Use only supplied segments, Claims and evidence spans. Every block must cite at least one supplied segment and at least one supplied Claim or evidence span. Copy IDs exactly.
- Never invent a first-person experience, route step, condition or preference. Do not turn generic descriptions into anecdotes.
- Keep Claims as factual atoms and Experience Blocks as a separate semantic layer. Empty blocks is correct when no grounded experience exists.
- Media durability may be degraded; use text and available evidence and report no unavailable visual detail.`;

const ASSEMBLY_PROMPT = `Act as an editorial commissioning desk. Select the smallest coherent evidence set for the approved opportunity before outlining.
- Choose exact supplied IDs only. Preserve the approved reader promise and production mode.
- Select facts for accuracy, Experience Blocks for route/decision/trade-off texture, and blueprints only for reusable structural lessons.
- Prefer independent source families for multi-source synthesis. Do not require several sources for a bounded source adaptation.
- Exclude tangential, duplicate, conflicted, stale, failed-before, or unsupported material and explain exclusions briefly.
- Failure lessons and editorial lessons are constraints, not content to quote. Return selection decisions, not an article.`;

const NARRATIVE_PROMPT = `Design the article's narrative logic from the approved brief and editorial assembly.
- Decide the opening's practical job, the throughline, route or decision sequence, experience placements, conditional branches, trade-offs, exclusions, and closing decision.
- Use exact supplied fact keys, section IDs and Experience Block IDs. Never invent lived experience or first-person narration.
- Avoid encyclopedia/database structure, repetitive section templates, generic travel prose and artificial comprehensiveness.
- Preserve conditions and uncertainty. The result is a plan for the writer, not reader-facing copy.`;

const briefPrompt = (strategyVersion) => `Create an evidence-backed English content plan and Canonical Travel Content object for SoloToChina Content Production Strategy ${strategyVersion}.
- approved_proposal is the operator-approved scope. Preserve its readerPromise, destination, production mode and evidenceBoundary. Do not expand a narrow proposal into a whole-city guide. Cover each promised section with exact supplied claim keys; if support is absent, disclose the gap rather than invent facts.
- Audience: independent international visitors, especially solo travelers, first-time China visitors, and people who cannot read Chinese.
- Use only the supplied knowledge facts. Claim keys in the outline must exactly match supplied keys.
- Select only the evidence needed to fulfill the approved reader promise: at most 48 unique claim keys for the whole plan and at most 12 per section. The remaining destination knowledge stays available for other articles; it is not mandatory coverage for this draft.
- Evidence marked partial_usable is valid only for the supplied Claim. Treat its coverage_limitations as explicit boundaries: narrow the reader promise, omit unsupported details, and never describe the source or topic as complete. Unrelated source gaps are already removed from this topic package.
- Unresolved strict safety/semantic conflicts require explicit handling instructions; never silently choose a side.
- The operator explicitly selected these sources. Prices, hours, reservations, schedules and access details are usable as supplied and do not require another official-page check or a fabricated publication-date gate. Preserve genuine mutually-exclusive conflicts for one grouped human decision; do not invent a conflict merely because dates are missing.
- Follow the selected production_mode for this one plan, without treating the other parallel routes as disabled. For source_adaptation, preserve the authorized source's useful itinerary, selection, sequence and practical intent while writing original English copy; do not copy wording or claim facts outside that source package. For topic_feature, fulfill only the bounded topic promise. For multi_source_synthesis, deliberately combine compatible perspectives across sources; it is a creative format, not a completeness repair step.
- Include practical adaptation for language, booking, payment, navigation, safety, and solo logistics where evidence permits.
- Canonical fields are structured source data for the writer and renderer. Use empty arrays or empty strings for unknown information rather than guessing.
- Include direct answer blocks only where the supplied facts support them. The image plan must distinguish real_world_photo, infographic, map_or_route, and illustration; only illustration is eligible for image-model generation.
- Affiliate inventory and commercial conversion are outside this task and must not appear.`;

const draftPrompt = (policy) => `Write an original, publication-quality English China travel guide from the supplied brief and evidence package.
- Treat writing_packet.text as the commissioned writing input. Use its narrative sequence and evidence ledger; do not expand the full destination Knowledge store into an encyclopedic fact dump.
- Never invent first-person experience. Ground traveler situations in supplied Experience Blocks and describe them in transparent third person.
- Never invent a price, opening hour, policy, route, booking rule, safety guarantee, or other fact.
- Use only supplied claim keys; report strict conflicts and temporal uncertainty transparently.
- Write for solo, first-time, non-Chinese-speaking travelers without stereotyping or alarmism.
- Do not mention Xiaohongshu, source authors, internal claim keys, evidence ledgers, affiliate products, Trip.com, or commercial calls to action in body_markdown.
- Follow the production_mode selected for this article. A rights-authorized source_adaptation may faithfully preserve one source's itinerary, selections and practical structure in original English wording. topic_feature should stay narrow. multi_source_synthesis deliberately combines compatible perspectives, while the other routes remain valid future opportunities from the same evidence.
- Return a separate evidence ledger mapping each article section to exact claim keys and source IDs.
- Preserve any explicit dates and validity ranges supplied by a source, but do not invent an “as of” date or force repetitive change-risk disclaimers when a source did not provide one.
- The article should be useful even with no commercial module. Follow this evidence-scaled content policy: ${JSON.stringify(policy)}. Never pad thin evidence to reach a word target.
- Make the body easy to understand: answer the confirmed reader promise directly, then use descriptive headings or concise lists only where the material benefits from them. No fixed heading or summary module is mandatory. Do not make unsupported claims just for SEO.
- FAQ is optional. Include it only when content_policy.faq.allowed is true and the supplied evidence answers real reader questions. When present, include the exact same questions and answers in a visible "Frequently asked questions" section of body_markdown; otherwise return an empty faqs array and omit that section.
- Return SEO metadata integrated with this draft: a natural meta title, one focus phrase, and only useful reader-facing takeaways. The configured title/description lengths are editing hints, not ranking thresholds; preserve names, amounts and qualifiers when shortening. The meta description remains the top-level meta_description field.
- Return SEO metadata with secondary keywords and search intent. Use internal links only from internal_link_inventory and preserve their exact URL. Do not invent canonical URLs.
- Preserve the internal evidence ledger for every factual section. A visible Sources section is optional unless the confirmed brief requests one; if used, show human-readable titles, real URLs and supplied dates without internal IDs.
- If the evidence package includes a frontend_page_plan, honor its semantic section order and writer guidance in the reader-facing article. It is a composition plan, not permission to invent components, props, or visual styling.
- Return only evidence-supported, rights-safe image plans, never filler to meet a count. Every included item needs accurate alt text, a useful placement, caption, image type, role, subject, factual_image_required, and aspect ratio. When a factual real-world visual supports the evidence, plan REAL_WORLD_PHOTO: the pipeline will prioritize an explicitly saved, user-authorized source image that is linked to the article evidence. Use ILLUSTRATION only for original no-text/no-logo generation prompts. A real venue, street, landmark, hotel, meal, ticket, or route must be REAL_WORLD_PHOTO / factual_image_required and must never ask an image model to fabricate a documentary-looking photo. Use INFOGRAPHIC only when structured facts support it; use MAP_OR_ROUTE only when validated coordinates or route data are supplied.
- Select real-world photo subjects from authorized_source_assets before writing when a saved asset actually matches the subject. These entries describe local retained files; do not copy or expose preview URLs in body_markdown.
- Use a concise, practical guide voice. Prefer direct instructions and short useful paragraphs; avoid literary scene-setting, generic enthusiasm, and padding.
- If revision_feedback exists, fix every blocker without adding unsupported facts.`;

const DRAFT_REPAIR_PROMPT = `Repair only the failed fields or H2 sections named by the supplied QA issues.
- The confirmed topic, brief, evidence set, claim keys and unaffected prose are immutable.
- Return the exact base_content_hash supplied by the caller.
- replacement_sections may contain at most three existing H2 headings. Supply body content only; do not add or rename headings.
- Change metadata only when a QA issue explicitly identifies title, meta, keyword, slug or SEO metadata.
- Change evidence_ledger or verification_notes only for evidence, coverage, conflict or temporal-disclosure failures. Remove invalid or unused keys instead of forcing every available fact into the prose; keep at most 12 claim keys per section and 48 total.
- Preserve specific names, amounts, dates, conditions, exceptions and audience qualifiers. Do not add facts or experiences.
- Keep replacement text concise and do not expand the article merely to reach a word target.
- Return JSON only. The caller will reject stale hashes and out-of-scope patches, re-hash the assembled draft and run QA again.`;

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
Give every block a stable content_node_id. Explicitly list source_section_ids and claim_keys for factual blocks; decorative or structural blocks must use factuality=non_factual with empty evidence references. One section may feed several nodes and one node may cite several sections.
Current capability candidates (machine-derived):\n${JSON.stringify(promptCapabilities(capabilities))}`;

const pagePayloadPrompt = (strategyVersion, capabilities) => `Produce a Frontend page payload for SoloToChina Content Production Strategy ${strategyVersion}.
Follow the supplied Page Schema exactly. The blocks array order is final render order.
Use only component IDs, variants, fields, and data schemas published by the current Frontend Component Registry candidates below. Never invent components, variants, props, CSS, styling tokens, or visual instructions.
Use the page plan as an editorial ordering guide. Use only information contained in the supplied canonical content and draft. Preserve uncertainty instead of fabricating facts. Do not use deprecated components in a new payload.
For each block copy exactly one content_node_id from the supplied page plan into _cms_content_node_id. Also return _cms_source_section_ids, _cms_claim_keys and _cms_factuality from that same plan node. These fields are removed into the CMS provenance sidecar before Frontend validation and are never public component props.
When the Registry publishes an image component, use it only for supplied visuals that already include a positive wordpress_media_id. Copy that ID to media_id and preserve the supplied alt text and caption. Place each selected image explicitly in blocks[]; never invent a media ID or an image URL.
Current capability candidates (machine-derived):\n${JSON.stringify(promptCapabilities(capabilities))}`;

const REVIEW_PROMPT = `Act as an independent senior editor. Audit the English draft against its evidence package and brief.
Grade reader-facing prose and factual support only. Missing image downloads, renderers, page composition or provider errors are separate deterministic delivery checks, not reasons to lower this editorial score. Never relax factual support or evidence scope.
Fail the draft for any unsupported factual assertion, hidden conflict, misleading certainty, source-key leakage, affiliate contamination, or unsafe advice.
Also check originality, usefulness for solo/first-time/non-Chinese-speaking visitors, SEO/GEO structure, clarity, and whether the evidence ledger honestly covers factual sections.
Use these editorial issue codes when applicable: DATABASE_DUMP, GENERIC_AI_TRANSITIONS, REPETITIVE_EXPLANATION, UNIFORM_SECTION_RHYTHM, EXCESSIVE_HEDGING, NO_TRAVELER_DECISION, NO_CAUSAL_FLOW, FAKE_FIRST_PERSON.
Do not rewrite the article. Return actionable blockers and warnings.`;

export function applyDeterministicGates(review, contentPackage) {
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
  const addWarning = (name, passed, detail, code) => {
    checks.push({ name, passed, detail });
    if (!passed) issues.push({ code, severity: "warning", message: detail });
  };

  const invalidKeys = [...ledgerKeys].filter((key) => !validKeys.has(key));
  addGate("evidence-key-integrity", invalidKeys.length === 0, invalidKeys.length ? `Unknown claim keys: ${invalidKeys.join(", ")}` : "All ledger keys exist in the research package.", "invalid_evidence_key");
  const plannedSections = contentPackage.brief?.plan?.outline || contentPackage.brief?.outline || [];
  const draftSections = draft.evidence_ledger || [];
  const uncoveredSections = plannedSections.filter((section) => (section.claim_keys || []).length
    && !draftSections.some((entry) => entry.section_id === section.section_id && (entry.claim_keys || []).some((key) => (section.claim_keys || []).includes(key))));
  addGate("confirmed-topic-coverage", uncoveredSections.length === 0,
    uncoveredSections.length ? `Planned sections without any supported evidence in the draft ledger: ${uncoveredSections.map((section) => section.heading || section.section_id).join(", ")}`
      : "Every evidence-bearing planned section uses at least one selected fact; unused background facts are not mandatory coverage.", "confirmed_topic_coverage_missing");
  const protectedMismatches = [];
  let semanticUnverified = 0;
  for (const key of ledgerKeys) {
    const fact = facts.find((item) => item.normalized_key === key);
    if (!fact) continue;
    const tokens = protectedFactTokens(fact);
    if (!tokens.length) semanticUnverified += 1;
    for (const token of tokens) if (!containsProtectedToken(draft.body_markdown, token)) protectedMismatches.push({ key, token });
  }
  addGate("protected-evidence-values", protectedMismatches.length === 0,
    protectedMismatches.length ? `Amount, date, negation, audience, or exception changed/omitted: ${protectedMismatches.map((item) => `${item.key}=${item.token}`).join(", ")}`
      : "Deterministically checkable evidence values and qualifiers are preserved.", "protected_evidence_mismatch");
  checks.push({ name: "semantic-evidence-sampling", passed: null,
    detail: semanticUnverified ? `${semanticUnverified} used fact(s) need semantic sampling because no deterministic protected token was available.`
      : "All used facts contained at least one deterministically checkable protected token." });
  const affiliateLeak = /trip\.com|affiliate|commission|booking link/i.test(draft.body_markdown);
  addGate("commercial-isolation", !affiliateLeak, affiliateLeak ? "Commercial or affiliate language leaked into the Research Draft." : "No commercial language detected.", "commercial_contamination");
  const internalLeak = /\bclaim[_ .-]?key\b|\bevidence ledger\b|\bsrc_[a-f0-9]+\b/i.test(draft.body_markdown);
  addGate("internal-metadata", !internalLeak, internalLeak ? "Internal research metadata appears in reader-facing copy." : "No internal identifiers detected.", "internal_metadata_leak");
  const promptInjectionLeak = /ignore (?:all |the )?(?:previous |prior )?instructions|system prompt|developer message|reveal (?:the )?(?:secret|token|credentials)/i.test(draft.body_markdown);
  addGate("prompt-injection-isolation", !promptInjectionLeak,
    promptInjectionLeak ? "Source-borne prompt instructions leaked into reader-facing copy." : "No source-borne instruction pattern appears in reader-facing copy.",
    "prompt_injection_leak");
  const fakeFirstPerson = /(?:^|[.!?]\s+)I\s+(?:arrived|visited|booked|paid|took|walked|found|noticed|recommend|stayed|ate)\b|\bmy (?:trip|visit|experience|hotel|route)\b/i.test(draft.body_markdown);
  addGate("experience-authenticity", !fakeFirstPerson,
    fakeFirstPerson ? "The draft invents a first-person travel experience that is not an attributed source quote." : "No fabricated first-person experience detected.",
    "FAKE_FIRST_PERSON");
  const genericIntro = /^(?:China|This (?:guide|article)|Whether you(?:'re| are)|Planning a trip)[^\n]{80,}/i.test(String(draft.body_markdown || "").trim());
  addWarning("specific-opening", !genericIntro,
    genericIntro ? "Opening is generic instead of performing the practical job in the Narrative Plan." : "Opening begins with a specific reader job.",
    "GENERIC_AI_TRANSITIONS");
  const listLines = (String(draft.body_markdown || "").match(/^(?:[-*]|\d+\.)\s+/gm) || []).length;
  const databaseDump = listLines >= 18 && listLines > wordCount(draft.body_markdown) / 18;
  addGate("editorial-synthesis", !databaseDump,
    databaseDump ? "The article reads like a database export: too many disconnected fact-list rows without narrative decisions." : "Facts are synthesized into reader decisions.",
    "DATABASE_DUMP");
  const bodyText = String(draft.body_markdown || "");
  const genericTransitions = (bodyText.match(/\b(?:moreover|furthermore|in conclusion|it is worth noting|delve into|embark on|tapestry|bustling metropolis)\b/giu) || []).length;
  addWarning("ai-transition-quality", genericTransitions < 3,
    genericTransitions < 3 ? "No repeated generic AI transition pattern detected." : "Generic transitions repeatedly replace specific causal or traveler-focused links.",
    "GENERIC_AI_TRANSITIONS");
  const sectionLengths = markdownH2Sections(bodyText).map((section) => wordCount(bodyText.slice(section.contentStart,section.end))).filter((value) => value > 0);
  const uniformRhythm = sectionLengths.length >= 4 && Math.max(...sectionLengths) - Math.min(...sectionLengths) <= Math.max(20,Math.round(sectionLengths.reduce((a,b) => a+b,0) / sectionLengths.length * 0.15));
  addWarning("section-rhythm", !uniformRhythm,
    uniformRhythm ? "Sections follow an unnaturally uniform length and rhythm instead of the needs of each decision." : "Section depth varies with the reader's decision needs.",
    "UNIFORM_SECTION_RHYTHM");
  const hedgeCount = (bodyText.match(/\b(?:perhaps|possibly|might|may|could|generally|typically|usually|in many cases|it seems)\b/giu) || []).length;
  const excessiveHedging = hedgeCount >= Math.max(5,Math.ceil(wordCount(bodyText) / 80));
  addWarning("editorial-confidence", !excessiveHedging,
    excessiveHedging ? "The prose overuses hedging instead of preserving uncertainty only where the evidence requires it." : "Uncertainty is expressed without excessive hedging.",
    "EXCESSIVE_HEDGING");
  const hasTravelerDecision = /\b(?:choose|use|book|reserve|take|avoid|plan|decide|prefer|start|go|walk|allow|bring|carry|switch|skip)\b/iu.test(bodyText);
  addWarning("traveler-decision", hasTravelerDecision,
    hasTravelerDecision ? "The article helps the traveler take or choose a concrete next step." : "The article presents information without helping the traveler make a decision.",
    "NO_TRAVELER_DECISION");
  const hasCausalFlow = wordCount(bodyText) < 120 || /\b(?:because|so that|which means|therefore|if|when|before|after|but|instead|otherwise|trade-?off)\b/iu.test(bodyText);
  addWarning("causal-flow", hasCausalFlow,
    hasCausalFlow ? "The prose links facts to conditions, consequences, or trade-offs." : "The article lacks causal flow between facts and traveler decisions.",
    "NO_CAUSAL_FLOW");
  const conflictedKeys = facts.filter((fact) => fact.consensus_status === "conflicted").map((fact) => fact.normalized_key);
  const acknowledged = new Set(draft.unresolved_conflicts || []);
  const hiddenConflicts = conflictedKeys.filter((key) => ledgerKeys.has(key) && !acknowledged.has(key));
  addGate("conflict-disclosure", hiddenConflicts.length === 0, hiddenConflicts.length ? `Used conflicted facts without ledger disclosure: ${hiddenConflicts.join(", ")}` : "Used conflicts are disclosed or avoided.", "hidden_conflict");
  const policy = contentPackage.content_policy || { minimum_words: 800, faq: { required: true, allowed: true }, visuals: { minimum: 2, maximum: 5 } };
  addWarning("suggested-depth", wordCount(draft.body_markdown) >= policy.minimum_words,
    `Draft has ${wordCount(draft.body_markdown)} words; ${policy.minimum_words} is an evidence-scaled editorial suggestion, not a pass/fail threshold.`, "draft_below_suggested_length");
  const seo = draft.seo || {};
  addGate("seo-metadata", Boolean(seo.meta_title && seo.focus_keyword && draft.meta_description),
    "SEO title, focus keyword, and meta description are present.", "seo_metadata_missing");
  const promiseRisks = titlePromiseRisks(draft.title, contentPackage.brief, facts);
  addGate("title-reader-promise", promiseRisks.length === 0,
    promiseRisks.length ? `Title adds unsupported scope promises: ${promiseRisks.join(", ")}.` : "Title remains within the confirmed brief and evidence scope.",
    "unsupported_title_promise");
  const distinctDescription = normalizeComparable(seo.meta_title) !== normalizeComparable(draft.meta_description);
  addGate("seo-title-description-independence", distinctDescription,
    distinctDescription ? "Meta description adds an article-specific summary instead of repeating the title." : "Meta description must not duplicate the title.",
    "seo_title_description_duplicate");
  const repeatedSeoPhrase = Math.max(...[seo.focus_keyword, "solo travel"].filter(Boolean)
    .map((phrase) => (String(`${seo.meta_title} ${draft.meta_description}`).toLowerCase().match(new RegExp(escapeRegex(String(phrase).toLowerCase()), "g")) || []).length), 0);
  addWarning("seo-natural-language", repeatedSeoPhrase <= 2,
    repeatedSeoPhrase <= 2 ? "SEO metadata uses natural language." : "SEO metadata mechanically repeats a keyword phrase.", "seo_keyword_repetition");
  addWarning("seo-length-guidance", String(seo.meta_title || "").length <= (policy.seo?.title_suggested_max || 60)
      && String(draft.meta_description || "").length <= (policy.seo?.description_suggested_max || 160),
    "SEO title/description exceed the configurable editorial display guidance; there is no ranking hard limit.", "seo_length_suggestion");
  const hasTakeaways = /(?:^|\n)#{2,3}\s+key takeaways\b/im.test(draft.body_markdown);
  const hasVisibleFaq = /(?:^|\n)#{2,3}\s+frequently asked questions\b/im.test(draft.body_markdown);
  const faqCount = Array.isArray(draft.seo?.faqs) ? draft.seo.faqs.length : 0;
  addWarning("answer-structure", hasTakeaways || Boolean(contentPackage.brief?.canonical?.quick_answer),
    "No fixed heading is required, but the confirmed reader question should receive a clear direct answer.", "answer_structure_suggestion");
  addGate("faq-consistency", policy.faq?.allowed ? (faqCount === 0 ? !hasVisibleFaq : hasVisibleFaq) : faqCount === 0 && !hasVisibleFaq,
    "FAQ exists only when the task policy and visible article support it.", "faq_policy_mismatch");
  const readerSources = contentPackage.reader_sources || [];
  const hasVisibleSources = !readerSources.length || (/(?:^|\n)#{2,3}\s+sources\b/im.test(draft.body_markdown)
    && readerSources.some((source) => String(draft.body_markdown).includes(source.url)));
  addWarning("reader-source-presentation", hasVisibleSources,
    "Reader-facing source presentation is optional; internal Claim-to-Source traceability remains mandatory.", "reader_sources_presentation_suggestion");
  const visualCount = Array.isArray(draft.visuals) ? draft.visuals.length : 0;
  addWarning("visual-plan-guidance", visualCount >= (policy.visuals?.minimum || 0) && visualCount <= (policy.visuals?.maximum || 5),
    `Draft visual plan count ${visualCount}; ${policy.visuals?.minimum || 0}-${policy.visuals?.maximum || 5} is a soft evidence/resource target.`, "visual_plan_suggestion");
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
      if (["use_authorized_source_image", "localize_source_image"].includes(visual.acquisition_strategy)) {
        return visual.factual_image_required && Boolean(visual.source_asset_id);
      }
      return visual.acquisition_strategy === "search_real_image" && visual.factual_image_required;
    }
    if (visual.image_type === "infographic") return visual.acquisition_strategy === "render_infographic";
    if (visual.image_type === "map_or_route") return visual.acquisition_strategy === "render_map";
    return visual.image_type === "illustration" && visual.acquisition_strategy === "generate_illustration" && !visual.factual_image_required;
  });
  addGate("image-strategy", visualStrategySafe,
    "Image plans must never use an image model to fabricate a factual real-world photo or route.", "image_strategy_invalid");
  const page = contentPackage.frontend_page;
  if (page) {
    const payload = page?.payload || {};
    const pageText = visiblePageText(payload);
    const criticalHeadings = [...String(draft.body_markdown || "").matchAll(/^##\s+(.+)$/gm)].map((match) => normalizeComparable(match[1]));
    const missingHeadings = criticalHeadings.filter((heading) => !pageText.includes(heading));
    addGate("final-page-valid", Boolean(page?.current && page.status === "valid" && page.validation?.valid && payload.blocks?.length),
      "The QA artifact must be the current, schema-valid, non-empty final editorial Page Payload.", "final_page_invalid");
    addGate("final-page-content", normalizeComparable(payload.metadata?.title) === normalizeComparable(draft.title) && missingHeadings.length === 0,
      missingHeadings.length ? `Final page omits critical headings: ${missingHeadings.join(", ")}` : "Final page title and critical section headings match the draft.",
      "final_page_content_missing");
    const evidenceValidation = validatePageEvidence(payload, contentPackage);
    addGate("final-page-evidence", evidenceValidation.valid,
      evidenceValidation.valid ? "Every factual semantic node retains its evidence values, conditions, source relation and visible date disclosure."
        : `Final page evidence mismatch: ${[...new Set(evidenceValidation.errors.map((item) => `${item.code} at ${item.path}${item.claimKey ? ` (${item.claimKey})` : ""}${item.expected ? ` expected: ${item.expected}` : ""}`))].join("; ")}`,
      "final_page_evidence_invalid");
  }
  const graph = draft.schema_jsonld?.["@graph"] || [];
  addGate("schema-consistency", graph.some((item) => item["@type"] === "Article") && graph.every((item) => !/undefined|null/.test(JSON.stringify(item))),
    "Deterministic schema must contain an Article and no placeholder values.", "schema_inconsistent");

  const repeatedParagraphs = duplicateParagraphs(draft.body_markdown);
  addWarning("repetitive-explanation", repeatedParagraphs.length === 0,
    repeatedParagraphs.length ? `${repeatedParagraphs.length} explanation pattern(s) repeat without adding a new decision or condition.` : "No repetitive explanation pattern found.",
    "REPETITIVE_EXPLANATION");
  addWarning("information-repetition", repeatedParagraphs.length === 0,
    repeatedParagraphs.length ? `${repeatedParagraphs.length} repeated paragraph pattern(s) need editing.` : "No mechanically repeated substantive paragraph found.",
    "repetitive_copy");
  const readability = readabilityWarnings(draft.body_markdown);
  addWarning("english-readability", readability.length === 0,
    readability.length ? readability.join(" ") : "English sentence and paragraph rhythm is within the configured editorial guidance.",
    "readability_suggestion");
  const finalIssues = uniqueBy(issues, (item) => `${item.code}:${item.message}`);
  return {
    ...review,
    ...separateQualityResults(review, finalIssues),
    checks: uniqueBy(checks, (item) => `${item.name}:${item.detail}`),
    issues: finalIssues,
    passed: review.passed && !finalIssues.some((item) => item.severity === "blocker"),
    score: Math.max(0, review.score - finalIssues.filter((item) => item.severity === "blocker").length * 10),
    deterministic_summary: { hardFailures: finalIssues.filter((item) => item.severity === "blocker").length,
      warnings: finalIssues.filter((item) => item.severity === "warning").length, semanticUnverified },
  };
}

function containsProtectedToken(text, token) {
  const haystack = String(text || "").normalize("NFKC").toLocaleLowerCase("en-US");
  const needle = String(token || "").normalize("NFKC").toLocaleLowerCase("en-US").trim();
  if (!needle) return true;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(haystack);
}

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function duplicateParagraphs(markdown) {
  const seen = new Set();
  const duplicates = new Set();
  for (const paragraph of String(markdown || "").split(/\n\s*\n/u)) {
    const normalized = paragraph.replace(/^#{1,6}\s+/gm, "").replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized.length < 50) continue;
    if (seen.has(normalized)) duplicates.add(normalized);
    seen.add(normalized);
  }
  return [...duplicates];
}

function readabilityWarnings(markdown) {
  const prose = String(markdown || "").replace(/^#{1,6}\s+.*$/gm, "").replace(/https?:\/\/\S+/g, "");
  const longSentences = prose.split(/(?<=[.!?])\s+/u).filter((sentence) => wordCount(sentence) > 45).length;
  const longParagraphs = prose.split(/\n\s*\n/u).filter((paragraph) => wordCount(paragraph) > 180).length;
  return [longSentences ? `${longSentences} sentence(s) exceed 45 words.` : "",
    longParagraphs ? `${longParagraphs} paragraph(s) exceed 180 words.` : ""].filter(Boolean);
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

function pageSchemaWithCmsProvenance(pageSchema) {
  const schema = structuredClone(pageSchema);
  const block = schema?.properties?.blocks?.items;
  const variants = block?.properties ? [block]
    : Array.isArray(block?.oneOf) ? block.oneOf.filter((item) => item?.properties) : [];
  for (const variant of variants) {
    variant.properties._cms_content_node_id = { type: "string" };
    variant.properties._cms_source_section_ids = { type: "array", items: { type: "string" } };
    variant.properties._cms_claim_keys = { type: "array", items: { type: "string" } };
    variant.properties._cms_factuality = { type: "string", enum: ["factual", "non_factual"] };
    variant.required = [...new Set([...(variant.required || []), "_cms_content_node_id", "_cms_source_section_ids", "_cms_claim_keys", "_cms_factuality"])];
  }
  return schema;
}

function separateCmsProvenance(output, plan) {
  const payload = structuredClone(output || {});
  const nodes = new Map((plan?.blocks || []).map((block) => [block.content_node_id, block]));
  const entries = [];
  const errors = [];
  for (const block of payload.blocks || []) {
    const nodeId = String(block._cms_content_node_id || "");
    const planned = nodes.get(nodeId);
    if (!planned) errors.push({ code: "UNKNOWN_CONTENT_NODE", contentNodeId: nodeId || null });
    const clean = { ...block };
    delete clean._cms_content_node_id;
    delete clean._cms_source_section_ids;
    delete clean._cms_claim_keys;
    delete clean._cms_factuality;
    Object.keys(block).forEach((key) => delete block[key]);
    Object.assign(block, clean);
    entries.push({
      contentNodeId: nodeId,
      blockSignature: pageBlockSignature(clean),
      sourceSectionIds: planned?.source_section_ids || [],
      claimKeys: planned?.claim_keys || [],
      factuality: planned?.factuality || "unknown",
    });
  }
  return { payload, provenance: { version: "2", valid: errors.length === 0, errors, entries } };
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
