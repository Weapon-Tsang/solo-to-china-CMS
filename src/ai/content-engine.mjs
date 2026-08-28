import { slugify, truncate } from "../utils.mjs";
import { KimiClient } from "./kimi-client.mjs";

const BRIEF_SCHEMA = objectSchema(
  ["title", "primary_keyword", "search_intent", "audience", "angle", "reader_promise", "outline", "adaptation_requirements", "conflict_instructions", "verification_instructions"],
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
    seo: objectSchema(["meta_title", "focus_keyword", "key_takeaways"], {
      meta_title: { type: "string" }, focus_keyword: { type: "string" },
      key_takeaways: { type: "array", items: { type: "string" } },
    }),
    faqs: { type: "array", items: objectSchema(["question", "answer"], { question: { type: "string" }, answer: { type: "string" } }) },
    visuals: { type: "array", items: objectSchema(["placement", "purpose", "alt_text", "caption", "generation_prompt", "aspect_ratio"], {
      placement: { type: "string", enum: ["hero", "after_intro", "mid_article", "before_faq", "closing"] },
      purpose: { type: "string" }, alt_text: { type: "string" }, caption: { type: "string" }, generation_prompt: { type: "string" },
      aspect_ratio: { type: "string", enum: ["16:9", "4:3", "1:1", "3:2", "9:16"] },
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

export class ContentEngine {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.client = new KimiClient(config, fetchImpl);
  }

  get enabled() {
    return this.client.enabled;
  }

  async plan(research) {
    return this.respond({
      name: "content_brief",
      schema: BRIEF_SCHEMA,
      instructions: BRIEF_PROMPT,
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
    result.output.meta_description = truncate(result.output.meta_description, 160);
    result.output.seo.meta_title = truncate(result.output.seo.meta_title || result.output.title, 70);
    result.output.seo.focus_keyword = truncate(result.output.seo.focus_keyword, 160);
    result.output.seo.key_takeaways = (result.output.seo.key_takeaways || []).slice(0, 6).map((item) => truncate(item, 240));
    result.output.faqs = (result.output.faqs || []).slice(0, 5).map((item) => ({ question: truncate(item.question, 220), answer: truncate(item.answer, 700) }));
    result.output.visuals = (result.output.visuals || []).slice(0, 5).map((item) => ({ ...item, purpose: truncate(item.purpose, 300), alt_text: truncate(item.alt_text, 220), caption: truncate(item.caption, 300), generation_prompt: truncate(item.generation_prompt, 2_000) }));
    return result;
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
const BRIEF_PROMPT = `Create an evidence-backed English content brief for SoloToChina.
- Audience: independent international visitors, especially solo travelers, first-time China visitors, and people who cannot read Chinese.
- Use only the supplied knowledge facts. Claim keys in the outline must exactly match supplied keys.
- Conflicted facts require explicit handling instructions; never silently choose a side.
- Facts marked time_sensitive or requires_official need explicit verification instructions. Exclude stale facts from the outline.
- Build an original synthesis, not a translation or imitation of any one UGC source.
- Include practical adaptation for language, booking, payment, navigation, safety, and solo logistics where evidence permits.
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
- Return a rights-safe visual plan for original illustrations, never copied UGC. Use 2 visuals for 800-1,299 words, 3 for 1,300-2,199 words, 4 for 2,200-3,199 words, and 5 above that. Each image needs an accurate alt text, a useful placement, a concise caption, an aspect ratio, and an original no-text/no-logo generation_prompt.
- If revision_feedback exists, fix every blocker without adding unsupported facts.`;

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

function uniqueBy(items, key) {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}
