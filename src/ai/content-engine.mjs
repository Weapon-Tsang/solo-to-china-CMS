import { slugify, truncate } from "../utils.mjs";

const BRIEF_SCHEMA = objectSchema(
  ["title", "primary_keyword", "search_intent", "audience", "angle", "reader_promise", "outline", "adaptation_requirements", "conflict_instructions"],
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
  },
);

const DRAFT_SCHEMA = objectSchema(
  ["title", "slug", "meta_description", "body_markdown", "evidence_ledger", "unresolved_conflicts"],
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
    this.fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.config.apiKey);
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
    result.output.meta_description = truncate(result.output.meta_description, 170);
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
    if (!this.enabled) throw new Error("OPENAI_API_KEY is required for content production.");
    const response = await this.fetch(`${this.config.baseUrl}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        store: false,
        instructions,
        input,
        text: { format: { type: "json_schema", name, strict: true, schema } },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`Content AI failed (${response.status}): ${payload?.error?.message || response.statusText}`);
    const outputText = payload.output_text || findOutputText(payload.output);
    if (!outputText) throw new Error("Content AI returned no structured output.");
    return { output: JSON.parse(outputText), model: payload.model || this.config.model };
  }
}
const BRIEF_PROMPT = `Create an evidence-backed English content brief for SoloToChina.
- Audience: independent international visitors, especially solo travelers, first-time China visitors, and people who cannot read Chinese.
- Use only the supplied knowledge facts. Claim keys in the outline must exactly match supplied keys.
- Conflicted facts require explicit handling instructions; never silently choose a side.
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
- The article should be useful even with no commercial module. Aim for at least 1,200 words when evidence coverage supports it.
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
  addGate("minimum-depth", wordCount(draft.body_markdown) >= 800, `Draft has ${wordCount(draft.body_markdown)} words; minimum evidence-backed review threshold is 800.`, "draft_too_short");

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

function findOutputText(output) {
  for (const item of output || []) for (const content of item.content || []) if (content.type === "output_text") return content.text;
  return "";
}

function wordCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function uniqueBy(items, key) {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}
