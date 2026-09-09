# SoloToChina CMS audit execution log

## Run metadata

- requirementsVersion: `1.3`
- task source: `SoloToChina_CMS_Codex_Prompts_2026-09-10_v1.3.txt`
- started: `2026-09-10` (`Asia/Shanghai`)
- repository: `Weapon-Tsang/solo-to-china-CMS`
- branch: `codex/audit-v1.3`
- starting HEAD: `d642f0fe9168e22667aadfd193fb3f6894766639`
- application version: `1.17.23`
- active content strategy: `1.8`
- runtime: Node `v24.14.0`, npm `11.9.0`, Windows/PowerShell
- scope rule: the v1.3 TXT is the only task list. Missing legacy IDs are intentionally not recreated.

## Safety baseline

- The starting worktree was clean and `main` matched `origin/main`.
- No applicable `AGENTS.md` exists in the repository.
- Read in full: `docs/HANDOFF.md`, `config/content-strategy.json`,
  `docs/content-strategy/CONTENT_PRODUCTION_STRATEGY_1.8.md`, and
  `docs/FRONTEND_CONTRACT_INTEGRATION.md`.
- Local database snapshot:
  `backups/audit-v1.3-baseline/solo-to-china-2026-09-09T18-28-21-080Z.sqlite`
  (ignored by Git), SHA-256
  `af087ea3d921caad69e9c4a137af153b35f7617c05d8c7f867eab3a624471ca3`.
- Snapshot integrity passed at schema 35. The current restore drill passed after
  `openDatabase` migrated the isolated restored copy to schema 38. This proves
  SQLite recovery only; B10 must still cover files and a non-mutating/full-system
  restore manifest.
- No paid model, production WordPress, Search Console, or production database was
  contacted by the baseline.

## Baseline results

| Command | Result | Notes |
| --- | --- | --- |
| `npm test` | passed | 243 passed, 0 failed, 0 skipped; 6.95 s |
| `npm run check` | passed | Vite production build and configured syntax checks passed |
| `npm run release:check` | passed | 39 mandatory checks, 0 failures, 4 warnings |
| `npm run test:cross-repo` | passed | fixed local Frontend Contract fixture `1.3.0`; checksum `422778911aad4726d420886e70374f40f26601b641398166ceb7bed87639f8c5` |
| `node src/backup.mjs ...` | passed | isolated baseline SQLite snapshot created and verified |
| `node src/backup.mjs --drill ...` | passed | isolated SQLite restore drill; file-system recovery not yet covered |

Baseline limitations: real Chrome/Xiaohongshu, real model providers, production
WordPress, production Search Console, deployed Frontend/theme HTML, crawler/CDN/WAF
configuration, ranking, indexing, traffic, and AI citation behavior were not tested.

## Task status

Every task follows `review -> test -> minimum change -> verify -> record`.

| taskId | requirementsVersion | status | HEAD reviewed | Dependencies / next evidence |
| --- | --- | --- | --- | --- |
| A01 | 1.3 | completed | `d642f0f` | Migration 39 and manifest-backed modality coverage verified |
| A02 | 1.3 | completed | `d642f0f` | Migration 40 and resumable read/ingest/cleanup lifecycle verified |
| A03 | 1.3 | completed | `d642f0f` | Migration 41, Vertex keyField correlation, anomaly isolation and per-item output-limit fallback verified |
| A04 | 1.3 | completed | `d357d59` | Migration 42; durable failure routing/budget/cooldown verified |
| A05 | 1.3 | completed | `d357d59` | Migration 43; immutable run config and old-provider adapter recovery verified |
| A06 | 1.3 | completed | `d357d59` | Migration 44; lease generation, cancellation and preparation recovery verified |
| A07 | 1.3 | completed | `d357d59` | Migration 45; explicit date semantics, validity filtering and reader-safe capture labels verified |
| A08 | 1.3 | completed | `d357d59` | Migration 46; submitter/author/source identity and real reader URLs verified |
| A09 | 1.3 | completed | `d357d59` | Deterministic family/author/identity components and dry-run impact verified |
| A10 | 1.3 | completed | `e7cc358` | Stable section/node provenance, span traces and explicit legacy-unknown compatibility verified |
| A11 | 1.3 | completed | `e7cc358` | Deterministic visible final-artifact evidence gate verified |
| A12 | 1.3 | completed | `e7cc358` | Migration 47; transport/coverage/usability dimensions and topic-scoped gaps verified |
| A13 | 1.3 | completed | `36a2ec0` | Migration 48; entity/predicate-scoped selection and explainable classification verified |
| A14 | 1.3 | completed | `36a2ec0` | Abortable latest-detail requests and truthful refresh outcomes verified |
| A16 | 1.3 | completed | `36a2ec0` | Bounded adaptive account/source login throttle and trusted-proxy policy verified |
| B10 | 1.3 | completed | `8005821` | Hashed v2 database/content snapshot and side-effect-free restore drill verified |
| B11 | 1.3 | completed | `8005821` | Consolidated Node 24/fixed-SHA/version/backup gate and CI verified |
| B03 | 1.3 | completed | `8005821` | Media-aware preflight and mixed PDF evidence verified |
| B04 | 1.3 | completed | `90e2daf` | Versioned held-out quality set and deterministic evidence/English gates verified |
| B05 | 1.3 | completed | `90e2daf` | Frozen stage policy, bounded repair, every-attempt cost ledger verified |
| B06 | 1.3 | completed | `90e2daf` | Durable artifact reuse/invalidation, cursored processing and fair scheduling verified |
| C01 | 1.3 | pending | `d642f0f` | Depends on A10, A11, B04 |
| C02 | 1.3 | pending | `d642f0f` | Depends on A07, A10, A11, B04, C01 |
| C03 | 1.3 | pending | `d642f0f` | Depends on A13, C01 |
| C04 | 1.3 | pending | `d642f0f` | Depends on A01, A11, B03, B06 |
| C05 | 1.3 | pending | `d642f0f` | Depends on A11, B11, C01-C04 |
| B07 | 1.3 | pending | `d642f0f` | Content AST compatibility migration; rerun C01-C05 afterward |
| B08 | 1.3 | pending | `d642f0f` | Existing action-oriented admin workspaces only |
| B09 | 1.3 | pending | `d642f0f` | Existing commercial event/revision consistency only |
| B12 | 1.3 | pending | `d642f0f` | Incremental service/view extraction; rerun C01-C05 afterward |

## Current checkpoint

- Completed A01: added a versioned input manifest with expected/received modality,
  provider capability, stable asset ID/hash, request-reference type and per-asset
  failure detail. Batch preparation persists it before submission; coverage no
  longer infers media input from `method`. Migration 39 leaves legacy records
  `unknown`. Modified `src/ai/kimi-client.mjs`, `src/ai/kimi.mjs`,
  `src/ai/vertex-gemini-client.mjs`, `src/db.mjs`, `src/pipeline.mjs`,
  `src/repository.mjs`, and related tests. Failing counterexample before repair:
  `node --test test/pipeline.test.mjs --test-name-pattern="coverage trusts the persisted input manifest"`
  reported `text !== image`. Verification: 17 focused tests passed.
- Completed A02: migration 40 separates inference, output reading, ingestion,
  quarantine, cleanup eligibility and cleaned state. Output rows carry object,
  line and checksum; per-item extraction/job completion is one SQLite transaction.
  Read failures defer only download, committed rows are skipped on restart, and
  partial/missing results are retained in quarantine. Modified `src/db.mjs`,
  `src/ai/vertex-gemini-client.mjs`, `src/pipeline.mjs`, `src/repository.mjs`, and
  related tests. Failing counterexample before repair returned `true` and cleaned
  after a simulated 503. Verification: 18 focused tests passed.
- Completed A03: uses the official BatchPredictionJob `instanceConfig.keyField`
  transport key, persists request fingerprints, preserves provider status,
  `finishReason` and row location, and quarantines unknown/duplicate correlation.
  Model-generated IDs are warnings only. `MAX_TOKENS` returns only that item to
  the realtime route. Modified `src/ai/vertex-gemini-client.mjs`, `src/db.mjs`,
  `src/pipeline.mjs`, `src/repository.mjs`, and related tests. Verification:
  22 focused tests passed, including out-of-order/fingerprint recovery, repeated
  model IDs, duplicate transport rows, invalid inner JSON, provider errors and
  `MAX_TOKENS`.
- First-batch regression checkpoint: `node --test --test-reporter=dot` passed
  254 tests; `npm run check` passed; `npm run release:check` passed 39 mandatory
  checks with 0 failures and 4 documented environment warnings. Legacy migration
  fixtures were extended through schema 41, and the release gate now verifies the
  complete 1-41 migration chain.
- Completed A04: migration 42 adds `execution_route`, `failure_class`,
  `batch_attempts`, `next_eligible_at`, and operator-visible failure codes. Twenty
  permanent preparation failures terminate without cycling; 429 uses Retry-After
  plus bounded jitter/backoff and falls back after two Batch attempts; oversized
  input uses realtime; local capacity remains Batch-eligible after cooldown and
  consumes no Batch attempt. Verification: 25 focused tests passed.
- Completed A05: migration 43 freezes provider/model/location/project plus schema,
  prompt and configuration hashes on each run. Batch dispatch resolves the stored
  Vertex adapter even while Kimi is the current default. Missing historical-run
  credentials persist `CREDENTIALS_UNAVAILABLE` and resume the same run after
  restoration. Verification: 40 focused tests passed.
- Completed A06: migration 44 adds a monotonic job lease generation and a separate
  Batch-preparation lease. Completion and failure are owner+generation CAS writes;
  a stale failure cannot mutate source/brief/draft state. Guarded calls propagate
  AbortSignal and WordPress idempotency keys. Startup leaves live preparations
  alone and reclaims only expired ones. Verification: 69 focused tests passed.
- Second-batch regression checkpoint: 266 tests passed; `npm run check` passed;
  `npm run release:check` passed 39 mandatory checks with 0 failures and the same
  4 documented environment warnings. The clean schema chain is now 1-44.
- Unverified conditions: all production/deployed services listed under baseline
  limitations.
- Completed A07: migration 45 separates observed, published, captured, verified,
  valid-from and valid-to semantics. Capture-only timestamps remain low-confidence
  archive clues and never populate `latest_evidence_at`; scheduled and historical
  evidence remains auditable but cannot enter current topic/writing packages.
  Explicit Claim validity dates and qualifiers are preserved. Verification: 11
  focused temporal/migration/content-pipeline tests passed.
- Completed A08: migration 46 separates `submitted_by`, author, publisher,
  original/canonical/final URL, stable source identity and version identity.
  Manual URL identity uses the public canonical URL; local file identity uses its
  content hash. Repeated originals update one Source; reader Sources prefer the
  real final URL and omit internal/file URIs. Legacy `人工提交` becomes unknown,
  without guessing an author. Verification: 22 focused tests passed.
- Completed A09: evidence independence now computes deterministic connected
  components across overlapping trusted families, stable identities and stable
  author identity. Consensus audit data names merge reasons, selected observation
  and folded Sources; input order cannot change the result. Repository dry-run
  reports affected facts and vote-count/key changes before applying a scoped
  Knowledge rebuild. Verification: 53 focused consensus/Knowledge tests passed.
- Third-batch regression checkpoint: 279 tests passed; `npm run check` passed;
  `npm run release:check` passed 39 mandatory checks with 0 failures and 4
  documented environment warnings. The clean schema chain is now 1-46.
- Completed A10: brief sections, draft-ledger nodes and Frontend page-plan blocks
  now have stable semantic IDs. Page payloads remain Contract-compatible while a
  stored sidecar maps each factual block to its section, Claim, Source and exact
  evidence spans. Decorative insertion, section splitting and block reordering do
  not change identity. Historical rows without the sidecar hydrate as
  `legacy_unknown`; they never inherit an array position as exact provenance.
  Verification: 2 dedicated provenance tests plus the content pipeline passed.
- Completed A11: deterministic QA reads the final visible Page Payload after
  composition/overlay and rejects empty factual ledgers, missing answers, changed
  protected values or qualifiers, missing visible as-of dates, forged Sources and
  invalid Claim-to-Source traces. Non-factual layout variants remain allowed.
  The same validator runs during AI review and final Publish Package creation.
  Verification: 4 dedicated validator tests plus Publish/content integration passed.
- Completed A12: migration 47 separates transport success, evidence coverage,
  publication usability and materiality. A targeted retry with one supported Claim
  and nine material gaps becomes `partial_usable/partial`, not complete, while the
  supported Claim remains eligible for a bounded topic. Local explainable rules
  classify clear decoration without a model call; meaningful zero-Claim media
  retries then requires review. Knowledge evidence retains coverage limitations,
  and writing packages remove gaps unrelated to the selected narrow topic while
  keeping relevant limitations as reader-promise boundaries. Verification: 3 new
  acceptance tests and all coverage/pipeline tests passed.
- Fourth-batch regression checkpoint: 289 tests passed; `npm run check` passed;
  `npm run release:check` passed 39 mandatory checks with 0 failures and 4
  documented environment warnings. The clean schema chain is now 1-47.
- Completed A13: migration 48 records whether an assignment type came from the
  operator or automatic classification and retains ranked candidates/confidence.
  Explicit target Entity IDs/names now fence selection; a route fact must match a
  target or have an Entity Relation to it, so unrelated same-city transport no
  longer enters an A-B route. Typed predicates and Entity types drive ranking.
  Weak street/station words fall back to `custom`; food/accommodation intent wins
  over a street name, while the UI keeps an explicit manual type override. Every
  evaluated fact stores its include/exclude score and reason and the dashboard
  renders the full decision list. Verification: 5 assignment/API tests passed.
- Completed A14: detail requests use a dedicated latest-request coordinator and
  AbortController. Opening B aborts A; closing or switching invalidates late data.
  List loads return explicit outcomes, and refresh classifies full success,
  partial success and failure instead of swallowing a list error. Quiet polling
  retains the existing sequence guard and does not remount view-local forms.
  Verification: 3 deterministic coordinator tests plus the production build passed.
- Completed A16: deployment review found Cloudflare Tunnel but no checked-in or
  otherwise verifiable edge rate-limit rule, so no edge protection was assumed.
  The application now applies bounded TTL account/source throttles with adaptive
  cooldown, a higher shared-source allowance, generic 401/429 responses and
  password-free audit events. Unknown accounts perform the same asynchronous
  scrypt path until throttled. Forwarded addresses are ignored unless both a
  header and proxy IP/CIDR are explicitly configured. Existing persisted-session,
  password/username change and logout revocation remain unchanged and passing.
  Verification: 13 login/server tests passed.
- Fifth-batch regression checkpoint: 297 tests passed; `npm run check` passed;
  `npm run release:check` passed 39 mandatory checks with 0 failures and 4
  documented environment warnings. The clean schema chain is now 1-48.
- Completed B10: backups are atomic v2 snapshot directories containing a
  `VACUUM INTO` database image, all source-upload/generated-media files and any
  additional locally referenced file. The manifest records every size/hash and
  DB row/column mapping, consistency window, app/schema/strategy/code rollback
  identity, Secret Manager key names without values, and local/offsite retention
  policy. Verification recomputes hashes; the isolated drill copies the whole
  snapshot, opens every evidence/draft-media reference and advances a recovered
  draft to `ready_for_wordpress` through a local mock with zero model/WordPress
  calls. Deletion and same-size corruption fixtures both fail. Deployment now
  creates a `pre-upgrade` snapshot before container replacement. Verification:
  4 backup/maintenance tests and `npm run check` passed. A real ignored local
  snapshot at `backups/solo-to-china-2026-09-09T21-24-07-713Z.snapshot` also
  verified/drilled; its source DB is schema 35 with 3 Sources, 26 Claims, no
  local file references and no draft, so its delivery probe correctly reported
  `not_applicable` rather than inventing content.
- Completed B11: `config/release-gate.json` records the Node floor, initial
  243-test/6.95-second Windows baseline and warning/failure budgets, quality
  dimensions and fixed Frontend revision. The adjacent Frontend working tree was
  not modified: the gate reads Contract files from the Git object at the fixed
  SHA. The previous deployed SHA was rejected because it exposed Contract 1.1.0;
  deployment, CI and the gate now agree on verified Contract 1.3.0 commit
  `f44ce1092ced93dfb47d9b3eae83d0d5e4b97086`. Git-normalized terminal newline
  reconstruction is accepted only when it matches the Contract-declared exact
  Registry checksum. Release metadata now blocks version drift across package,
  source version, extension, migration, strategy, handoff, changelog, deployment
  and CI. `npm run release:check` passed 44 mandatory checks with 0 failures,
  4 warnings and 4 explicitly untested/unconfigured conclusions; real services
  were not called and final theme HTML/search outcomes were not claimed.
- Completed B03: intake now evaluates usable evidence rather than a text-length
  proxy, so a short selected note with a complete image can enter the media path
  while empty captures remain rejected. A deterministic technical estimate names
  text segments, media inputs, PDF pages, bytes and expected extraction calls;
  high-cost captures are stored without queueing until the operator uses the
  Source-detail `开始提取` action. Exact duplicates remain idempotent. PDF parsing
  records every page's embedded-text/visual state, retains form-feed page
  boundaries, and creates one existing Vertex document input plus a page-located
  `pdf_page` segment for chart/scanned pages instead of launching blanket OCR or
  asking for re-export. Preflight verifies configured-root file existence, size,
  MIME and provider modality before any model call. Existing Editorial Assignment
  acquisition requests remain bounded to its selected destination, target Entities
  and missing field/time/route evidence; no demand discovery or topic generation
  was added. Verification: 4 dedicated counterexamples plus 31 capture/manual/
  pipeline regressions passed; `npm run check` passed.
- Sixth-batch regression checkpoint: 303 tests passed; `npm run check` passed;
  `npm run release:check` passed 44 mandatory checks with 0 failures, 4 warnings
  and 4 explicit offline/unconfigured conclusions. The clean schema chain remains
  1-48; B10/B11/B03 did not require a database migration.
- Completed B04: `config/quality-evaluation-set.json` provides a versioned 12-case
  evaluation set with three held-out cases covering concise and long-form work,
  single/multiple/no-image/old/multimodal evidence, names/translations,
  exceptions, title/body mismatch and prompt injection. Deterministic QA makes
  unsupported ledger facts, protected amounts/dates/negation/audience conditions,
  FAQ mismatch and instruction leakage blockers; word count, repetition,
  readability, metadata length, visible Sources and image count are warnings.
  Semantic judgment not deterministically provable is reported as unverified.
  Verification: 5 dedicated quality-set tests and content-engine regressions passed;
  no real-model quality improvement, ranking, indexing or citation result is claimed.
- Completed B05: `config/model-stage-policy.json` freezes each extraction,
  diagnosis, writing, composition, QA and repair stage's capabilities, thinking,
  output-token budget, timeout and total attempts. Realtime calls, JSON/schema
  retries, timeouts, truncation, cancellation, Batch outcomes and cache hits each
  produce their own run/entity-linked ledger row with provider usage when present.
  `config/model-pricing.json` has dated provenance and intentionally no guessed
  price rows, so unknown costs remain null. Runtime reporting includes first-pass
  QA, calls, cache, repairs, tokens, costs and unique-qualified-draft denominator.
  Draft revision is a current-hash patch limited to failed metadata or three
  existing H2 sections, followed by normal re-hash/page/QA invalidation. Verification:
  4 dedicated policy/telemetry/repair tests passed; paid savings remain unmeasured.
- Completed B06: migration 50 stores stage/entity/input/config/output artifact
  identities and reuses only a matching live output, preventing duplicate paid
  generation after retry/restart. Fact changes invalidate only briefs whose
  evidence ledger uses the changed keys and never edit published body text;
  title/meta edits preserve body/evidence and regenerate dependent SEO/schema/QA.
  Coverage is rebuilt once, Entity resolution pages all Claims with a 300-item
  cursor, Batch input stays byte/item bounded, downstream/realtime work has
  priority, and jobs older than 15 minutes receive a fairness boost. Queue age and
  same-environment duration/latency/count/memory reports are exposed; p95 is null
  below 20 samples and uninstrumented DB query count is explicitly null.
  Verification: 3 dedicated artifact/cursor/scheduling tests passed.
- Seventh-batch regression checkpoint: 315 tests passed; `npm run check`
  passed; `npm run release:check` passed 44 mandatory checks with 0 failures,
  4 warnings and 4 explicit offline/unconfigured conclusions. The clean schema
  chain is now 1-50. No paid model or production service was called.
- Completed C01: title scope promises now hard-fail against the confirmed Brief
  and evidence, while 60/160 characters remain admin guidance rather than a
  rewrite or truncation rule. Canonical generation accepts only a configured
  public route or confirmed published URL. Migration 51 versions final page and
  SEO/schema hashes; metadata editing preserves body/evidence and queues only QA.
  The admin shows editable title/description previews, character guidance and an
  explicit no-display/no-CTR disclaimer. A deterministic synchronizer prevents
  conflicting visible title, description, canonical and structured-data values,
  with compatibility filtering for older Frontend Page Schemas.
- Completed C02: Article/WebPage/Breadcrumb identifiers share the validated
  canonical; author/editor identity is emitted only from explicit configuration,
  draft publication dates are rejected, private/signed media is excluded and
  Product/QAPage are rejected. FAQ is optional; when present its visible question
  and answer pairs must exactly match FAQPage. These checks reuse normal QA and
  do not add a GEO model call, forced FAQ, fixed section length or AI-crawler claim.
- Completed C03: Briefs receive a relevance-filtered, versioned inventory of only
  published same-origin WordPress targets. Final HTML anchors must resolve to that
  inventory and naturally match the target; generic/mismatched/repeated anchors,
  previews and missing targets fail. Empty/all-draft inventories yield no links
  without blocking content. Similar existing articles produce review-only risk
  records and never automatic merge/delete/canonical actions. A target route or
  status change records only referencing block indexes as stale and queues page
  recomposition, leaving evidence research and published body text untouched.
- C01-C03 focused verification: 10 SEO/GEO and full content-pipeline cases passed;
  the Vite production build and syntax checks passed. Full suite/release results
  are recorded in the next checkpoint.
- Eighth-batch regression checkpoint: 324 tests passed; `npm run check` passed;
  `npm run release:check` passed 44 mandatory checks with 0 failures, 4 warnings
  and 4 explicitly untested external/final-HTML conclusions. The clean schema
  chain is now 1-51 and no production service or paid model was called.
- Completed C04: migration 52 persists each uploaded WordPress media item's final
  public URL, intrinsic dimensions, MIME, bytes, SHA-256 and responsive derivative
  inventory. Repeated use of one source asset reuses one Media ID and upload.
  Delivery rejects signed/private/data URLs, missing size/hash/dimensions, invalid
  derivatives, alt-role mismatch, alt keyword stuffing, duplicate uploads and a
  fabricated illustration for a factual scene. The Legacy renderer emits `<img>`
  with dimensions/srcset/sizes, high priority only on the first image and lazy
  loading thereafter. No-image content remains valid. The structural baseline/
  after record is documented without inventing CWV improvement.
- Completed C05 on the CMS boundary: a final-HTML validator and separate published/
  draft fixtures check HTTP/publication state, initial visible article body, one
  H1, title/description/canonical, links/media, JSON-LD, noindex, robots.txt,
  sitemap, authentication separation and mobile/desktop factual equality. Reports
  use the six required dimensions and leave production cost, indexing, ranking,
  traffic, CWV and AI citations untested. The release gate now registers the fixed
  fixture and keeps production WordPress/theme HTML as NOT TESTED.
- C05 real-environment observation: an isolated exact Frontend
  `f44ce1092ced93dfb47d9b3eae83d0d5e4b97086` worktree ran Playground CLI 3.1.52,
  PHP 8.3 and WordPress 7.0.4. Its published page passed body/H1/canonical/robots/
  sitemap and mobile/desktop equality, but failed meta description, Article JSON-LD
  and first-image non-lazy checks. Its own CMS draft Blueprint also failed the
  Contract checksum. These are recorded as Frontend handoff failures; no Frontend
  source was edited and the runtime/worktree were removed.
- Completed B07 compatibility slice: migration 53 freezes a first-time-guide
  semantic tree containing stable nodes, roles, visible text, Fact/Source-section
  references, FAQ, SEO summary and media references. Markdown and deterministic
  `articleSection`/`faqList` payloads derive from that one tree; Registry variant
  changes preserve visible facts. Unsupported content types or missing components
  keep the existing validated Composer/capability-request path. Internal node
  fields remain provenance only and no SEO/GEO model call was added. Three AST
  counterexamples passed. C01-C05 focused tests were rerun after the migration:
  21/21 passed, so no pre-migration C05 label was reused.
- Ninth-batch regression checkpoint: 335 tests passed; `npm run check` passed;
  `npm run release:check` passed 50 mandatory checks with 0 failures, 4 warnings
  and 5 explicitly untested external/outcome conclusions. The clean schema chain
  is now 1-53. No paid model or production service was called by these gates.
- Current task: B08.
- Next action: complete B08, B09 and B12 as the final bounded implementation batch,
  then rerun every affected C01-C05 acceptance and the full delivery gates.
