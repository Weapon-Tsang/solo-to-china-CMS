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
| C01 | 1.3 | completed | `39cbd0f` | Versioned SEO artifacts, scope/canonical guards and targeted invalidation verified |
| C02 | 1.3 | completed | `39cbd0f` | Deterministic Article/WebPage/Breadcrumb/FAQ consistency verified |
| C03 | 1.3 | completed | `39cbd0f` | Published-target inventory, natural anchors and scoped invalidation verified |
| C04 | 1.3 | completed | `2d8719c` | Migration 52; public media identity, reuse and responsive delivery verified |
| C05 | 1.3 | completed | `2d8719c` | CMS final-HTML validator verified; three Frontend handoff failures recorded |
| B07 | 1.3 | completed | `2d8719c` | Migration 53; semantic content tree and compatibility renderers verified |
| B08 | 1.3 | completed | `9929fbb` | Migration 55; paged operational views, quality dimensions and safe actions verified |
| B09 | 1.3 | completed | `9929fbb` | Migration 54; version-bound Commercial attribution and unknown conversion semantics verified |
| B12 | 1.3 | completed | `9929fbb` | Seven enforceable boundaries and reversible module extraction verified |

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
- Completed B08: Editorial Assignment and operational-exception workspaces now
  expose cursor pagination, resumable search/status filters and filtered
  `totalCount` independently from the current page. Content rows and draft detail
  show content quality, SEO technical readiness, GEO content consistency and
  production cost as separate passed/warning/failed/not_tested conclusions with
  reason, target, repair, run version and bounded next call scope. A quality
  failure remains failed regardless of SEO completeness or numeric score; CMS
  artifacts never stand in for final HTML, rankings, traffic or AI citations.
  Migration 55 also retains draft revision snapshots and content-operation history;
  cancellation requires a recorded preview, removes only queued jobs and preserves
  evidence and artifacts, while the admin can compare the changed revision fields.
- Completed B09: migration 54 versions the Commercial overlay and adds nullable
  article revision/overlay plus explicit event source and conversion-data status
  to events. Provided associations are checked against the current draft, slot
  and asset before insertion. Clicks cannot carry monetary value; conversion and
  commission remain null when provider conversion data is unknown, while an
  explicitly confirmed zero-event fixture reports zero. Research Draft and no-
  inventory no-op behavior are unchanged.
- Completed B12 first reversible slice: the compatible Repository/SQLite/API
  facade remains in place while operations presentation/pagination, Commercial
  event SQL and the content-quality UI move to focused modules. A machine-readable
  seven-boundary map and dependency test prohibit Source/Evidence and Knowledge
  imports of Commercial. The fixed pre/post 250-item fixture kept its 181,950-byte
  response; observed duration was 28.01 ms before and 28.15 ms after. DB query
  count remains explicitly not instrumented, so no performance percentage is
  claimed. Responsibilities and rollback boundary are documented.
- Final-batch focused verification: 47 operations, Commercial, assignments,
  content-pipeline, C01-C05 and dependency cases passed. The full final
  delivery gates follow this checkpoint.
- Current task: final C01-C05 regression and deployment.
- Next action: run migration/quality/media/HTML regressions, full tests, static
  checks and release gate; then commit/push the final three items and deploy with
  the documented pre-upgrade snapshot and post-deploy verification.
- Tenth-batch and final implementation checkpoint: 344 tests passed; `npm run
  check` passed including the seven-boundary dependency gate; `npm run
  release:check` passed 50 mandatory checks with 0 failures, 4 warnings and 5
  explicitly untested external/outcome conclusions. The clean schema chain is
  now 1-55. C01-C05 affected acceptance tests passed after all Stage 5 changes.
  No paid model or production service was called by the verification gates.
- Deployment checkpoint: Cloud Build `fad51e58-51da-46ac-9dce-1fe620799a06`
  published application image digest
  `sha256:26f79920dfe76e26beb1c13fcd525c7b7926447f90814312e97b03162c1b8749`
  from commit `bc15f1e`. The GCE startup script created the verified pre-upgrade
  database-and-content snapshot before replacing the containers; because the
  script runs with `set -e`, its later successful completion also verifies the
  snapshot command returned successfully. Serial output then confirmed the exact
  application digest, `engine` and `cloudflared` running, and `Deployment
  completed successfully.`
- Post-deploy verification: `https://engine.solotochina.com/api/health` and
  `/api/ready` returned HTTP 200; the latter reported `database: ready` and the
  former reported application `1.17.23`, content strategy `1.8`, zero active
  Batch jobs, and a healthy Frontend Contract at fixed commit
  `f44ce1092ced93dfb47d9b3eae83d0d5e4b97086`. The Capture health route returned
  200 while its root returned 404, preserving the no-dashboard boundary. Schema
  55 was verified directly in clean local migration tests and indirectly in the
  deployed runtime by successful startup plus database readiness; no production
  endpoint exposes the numeric schema version, so a direct production schema-number
  read remains unavailable rather than inferred.
- Final status: all 30 v1.3 task IDs are completed. No task is marked
  `already_fixed`, `not_applicable` or `blocked`; no task remains pending. The
  separate Frontend handoff failures and external/outcome checks remain explicitly
  unverified and do not reduce the CMS acceptance standard.
- Current task: completed.
- Next action: address the documented Frontend C05 handoff in the Frontend
  repository, then rerun the real final-HTML check; production ranking, indexing,
  traffic, Core Web Vitals and AI citations require later observation and are not
  claimed by this audit.

## 2026-09-10 production exception follow-up

- Task ID: `INC01`; `requirementsVersion=1.3`; status: `completed`;
  baseline HEAD: `4960a0a7e6c49b65b44f5ffdcb3e19865f8b6036`;
  implementation commit: `cff6391e067b7b280f8fc354b7514dd4ba2ef808`.
- Read-only production inventory: all 13 Content rows and all 24 Exception rows
  were inspected with pagination exhausted. The Exception view contained 13 real
  failed jobs plus 11 draft-status projections: nine
  `compose_frontend_page` Vertex HTTP 400 records affecting eight Drafts, three
  authorized source-image HTTP 403 records affecting three Drafts, and one
  `plan_content` output-limit record affecting one Topic. The repeated Draft cards
  are projections of those failures, not additional provider requests.
- Confirmed causes: the deployed Page Schema is a 23-variant `oneOf` contract and
  the old deterministic compatibility path covered only `first_time_guide` plus
  legacy `articleSection`; generic Vertex 400 responses did not trigger the
  existing schema-transport fallback. Authorized Xiaohongshu CDN URLs had expired
  and the affected historical assets had neither retained bytes nor a local file.
  The output-limit Topic explicitly named Chongqing while it was scoped to
  `beijing-palace-museum`, allowing mixed destination evidence into planning.
  Exception/card retryability was hardcoded and recovered jobs could remain visible.
- Minimal implementation: `src/content-blocks.mjs`, `src/pipeline.mjs`,
  `src/ai/content-engine.mjs`, `src/ai/vertex-gemini-client.mjs`,
  `src/destination-consistency.mjs`, `src/evidence-validator.mjs`,
  `src/job-policy.mjs`, `src/repository.mjs`,
  `src/services/operations-workspace.mjs`, and `src/wordpress.mjs` now provide
  Contract-validated atomic deterministic composition for every Content AST type,
  `oneOf` provenance injection, one bounded generic HTTP 400 schema-transport
  fallback, destination mismatch blocking, stage-aware output-limit handling,
  retained authorized-media delivery, durable retry classification, recovered-job
  suppression, and ledger-section evidence validation. Associated regression tests,
  version files, release notes, deployment image reference and handoff were updated.
- Verification: `npm test` passed 358/358; `npm run check` passed the production
  build, syntax checks and seven service-boundary checks; `npm run release:check`
  passed all 50 mandatory checks with 0 failures, 4 warnings and 5 explicitly
  untested/unconfigured external conclusions. A separate read-only probe against
  the currently published Frontend Contract `1.3.0` / JSON Schema `2020-12`
  produced deterministic `heading`, `paragraph`, and `list` blocks with zero
  component or Page Schema errors.
- Deployment: Cloud Build `012650dd-8ad2-4afd-b3a0-7c9a56efef59` published
  `engine:1.17.24` with digest
  `sha256:a14f7388bfe02d4ec6df2b2f3e39cc8dd2dcc472fdb0489b610472b219f352bb`.
  The exact `solo-to-china-engine` instance startup log recorded the verified
  pre-upgrade snapshot step, both containers running, and `Deployment completed
  successfully.` Public health/readiness returned HTTP 200 with application
  `1.17.24`, Content Strategy `1.8`, Frontend Contract `1.3.0` healthy and database
  ready. Capture health remained 200 and its root remained 404.
- Post-deploy read-only verification: the full Exception workspace still contains
  the same 24 historical records with no next page; all 24 now report
  `retryable=false`. The Content workspace contains 13 rows; all 11 failed Draft
  cards expose `manual_correction` and none offers a retry. No record was deleted,
  requeued or otherwise rewritten by this verification.
- Dependencies and unverified conditions: no schema migration is required and
  Content Strategy remains `1.8`. No paid model, production database, job queue or
  WordPress content was mutated. Existing permanent records are deliberately not
  auto-retried: destination scope must be corrected before rebuilding its evidence,
  and the three historical expired source images require an authorized retained
  copy or operator recapture. The corrected paths are deployed, but no production
  Draft was rerun; real WordPress/theme HTML, rankings, indexing, traffic, Core Web
  Vitals and AI citations remain outside this verification.
- Next action: operators may correct the mismatched Topic destination and recapture
  or supply retained authorized copies for the three expired source images, then
  use the bounded retry only after those inputs change. The eight affected Drafts
  with the former Vertex 400 can use the deterministic atomic composer on their
  next explicitly initiated run. No automatic production retry is pending.

## 2026-09-10 — Recovery UX and intake-volume follow-up

- Task ID: incident-followup; requirementsVersion=1.3; status=in_progress;
  baseline HEAD=812ec76. See CONTENT_RECOVERY_2026-09-10.md for findings and exact breakpoint.
- Read-only production evidence: 74 source recommendations (66 article candidates),
  269 underlying opportunity paths, 237 marked ready; 16 recommendations approved.
  Recommendations are keyed by source; opportunity keys deliberately include source identity.
  This is not 74 independently qualified or approved article topics.
- Local changes: recovery service/policy and UI, explicit-stage actions, retained-source links,
  authorized asset binding, manual editorial correction, destination correction, revision-aware
  QA display, actual queue labels, temporal-note/exit-token fixes, media checkpointing and
  nested transaction rollback. No intake eligibility algorithm was changed.
- Tests: baseline npm test 358/358; targeted recovery 9/9; final npm test 367/367;
  npm run check passed (build/syntax/service boundaries); git diff --check passed.
- Not verified: browser end-to-end UI, full destination-correction and manual-stage pipeline
  integration, paid model execution, recapture and WordPress delivery. New code is local only;
  not committed, pushed or deployed. Production records were not rewritten or retried.
- Next: finish recovery integration/UI verification and release checks before deployment.
  The newer user question about 74 opportunities is answered from code and read-only live counts;
  do not interpret it as authorization to delete or reclassify existing suggestions.

## 2026-09-10 — Strategy-first workflow redesign, first bounded batch

- Task ID: strategy-workflow-followup; requirementsVersion=1.3; status=in_progress;
  HEAD=812ec76e9e53672569075338643ca106341d8e21; active strategy=1.8; app=1.17.24.
- User steering: reassess production strategy and lifecycle before version/release;
  do not bundle disconnected incident patches as a completed upgrade.
- Design: docs/content-strategy/CONTENT_PRODUCTION_STRATEGY_1.9_DRAFT.md (not active).
  Separates Source, source analysis, concrete editorial proposal, approval, stage jobs and delivery;
  preserves three production modes, manual topics, evidence/history, Research/Commercial and WP draft protections.
- Code-reviewed cause: dashboard mixed pendingRecommendations + contentPipelineItems under
  “topic discovery”; this was not a count of independently qualified article topics.
- First-batch files: src/services/recommendation-bulk.mjs, src/server.mjs,
  frontend/src/workspaces/recommendation-bulk.jsx, frontend/src/views.jsx,
  frontend/src/components/dashboard.jsx, test/recommendation-bulk.test.mjs.
- Implemented locally: common single/path/bulk decision command; ownership and stale-selection guards;
  repeat-safe approval; per-item rollback; explicit path preview; one batch request/one action refresh;
  separate source/proposal/approval totals; manual-topic role explanation.
- Actual commands: node --test test/recommendation-bulk.test.mjs (7/7 passed);
  npm test (374/374 passed, output/strategy-workflow-tests.txt);
  npm run check (passed, output/strategy-workflow-check.txt); git diff --check (passed).
  Initial new test failures were corrected invalid note-identity fixtures and tests counting extraction jobs
  as article-production jobs; no production quality criteria were relaxed to pass tests.
- Browser skill: local real UI/API/isolated SQLite at 127.0.0.1:4319, no loaded .env,
  no model/WordPress execution. Verified 3 sources/6 proposals; batch selected one alternate and two default
  paths; processed=3, failed=0, queued=0 for insufficient evidence; other paths retained.
  A later single explicit alternate approval changed approved directions from3 to4 without auto-approving the rest.
  Browser native confirm timed out; replaced new approval confirms with visible in-page preview lists,
  then repeated the successful flow. No browser console errors in checked batch page.
- No migration, backup restore, production writes, paid calls, commits, pushes, deployment or version activation
  performed by this batch. Existing user/earlier worktree edits preserved. No tasks marked already_fixed or
  not_applicable in this follow-up. Overall redesign remains in_progress, not completed.
- Dependencies/unverified: proposal scope identity stronger than recommendation updated_at; manual assignment
  approval parity; promise-level evidence gate; semantic grouping; separate textual/final QA; full recovery pipeline;
  mobile regression; release gate and production integration. Prior recovery edits remain local/unreleased.
- Next: phase2—review actual proposal/Brief evidence selection against the promised scope and integrate manual
  assignments, without inventing hard source-count thresholds or deleting historical proposals; then phase3 QA/recovery,
  full end-to-end/regression and only then version activation/release. No authorization question is needed to continue local work.

## 2026-09-10 Strategy 1.9 workflow release follow-up (pre-deploy)

- Task IDs: INC02 / FLOW01 / FLOW02; requirementsVersion=1.3; status=in_progress (implementation and offline validation completed; deployment pending).
- Baseline/current pre-commit HEAD: 812ec76e9e53672569075338643ca106341d8e21, codex/audit-v1.3; original working changes preserved. This is the user-requested production workflow follow-up, not a repeat of the 30 completed audit items.
- INC02: shared source-linked recovery UI/API, retained authorized asset binding, editorial body/ledger/date-note correction, pre-brief destination correction, exact stage retries, media checkpoints and no automatic paid stage chaining. Fixed stale revision/evidence QA display, invalid token boundaries and date-note matching; no lowering of final delivery gates.
- FLOW01: single/bulk approvals use common transactional commands, explicit direction selection, stale timestamp and semantic proposal fingerprint checks, per-row rollback/results, duplicate/ownership protection. Manual assignment approval freezes the same proposal record. Preserve approved scope and old proposals across coverage rebuild/reanalysis.
- FLOW02: distinguish recommendations/directions/approved production; remove fact-count coverage bonus; carry reader promise/boundary into planning and validate scoped non-conflicting fact references; exact normalized comparison groups only (not semantic dedup). Separate prose and media/page delivery subresults within the existing review call. Topics becomes 创作规划 without removing assignments or records.
- Upgrade safety: strategy version change does not enqueue historical-source reanalysis; older strategy candidates cannot bypass approval. Schema stays 55; no data migration or historical content mutation is required.
- Changed files: src/services/{content-recovery,content-recovery-policy,recommendation-bulk,editorial-proposal,operations-workspace}.mjs; src/{repository,pipeline,db,server,research-strategy,evidence-validator}.mjs; src/ai/content-engine.mjs; frontend/src/{App,views}.jsx and dashboard/quality/recovery/bulk/utils; three new test files; diagnostic scripts; version/strategy/changelog/handoff/deployment documentation.
- Verification: npm test before version switch 379/379 passed. First post-switch release gate caught the required strategy-download safety heading missing; restored that heading, did not relax test. Final npm run release:check passed 50 mandatory checks, 0 failures, 4 warnings, 5 explicitly untested conclusions; includes all 379 tests, production build/static/boundaries, fixed-SHA Frontend Contract, clean migrations, backup restore drill and isolated server/WP adapter smoke. git diff --check passed.
- Targeted tests: node --test test/content-recovery.test.mjs test/editorial-proposal.test.mjs test/recommendation-bulk.test.mjs: 21/21 passed. Normal approve/plan/draft/review/WP-draft mocked integration and bulk tests: 9/9 passed.
- Browser skill: real isolated desktop UI/API/SQLite on 127.0.0.1:4319 with production execution explicitly disabled. At 1.17.25/1.9, three source recommendations/six directions showed three named default articles in inline confirmation; execution returned success=3, skipped=0, failed=0, queued=0 (missing evidence). Exactly three directions approved, not all six. Earlier single alternate-direction approval also verified. Real mobile-device behavior remains unverified.
- Version alignment: App/Extension 1.17.25, Content Strategy 1.9, requirementsVersion=1.3, schema 55. Strategy document describes actual existing stage order; early prose QA and semantic dedup in the design draft are not claimed as implemented.
- External conditions: historical source-image 403 needs a legitimate original/recapture; factual copy and evidence gaps still require correction through the new entry. No model or production WP call made to clear incidents. Existing historical source/draft versions preserved, old scores not relabeled as new review passes.
- Next: commit and push the validated implementation, build the pinned image, create verified pre-upgrade system snapshot, deploy exact CMS instance and verify read-only health/content/recovery endpoints. Record actual build/digest/backup evidence before marking deployment complete.

## 2026-09-10 deployment and read-path performance follow-up

- Implementation c25afd6d36ad202acee5e706f2bcd380d97d1524 pushed to origin/codex/audit-v1.3. Cloud Build 4f48ef77-9fc6-469b-a5ff-414fde10620e succeeded; 1.17.25 digest sha256:456cedc9d468671fc4b8d972a54cb87000029d258d8385925fbd64beaf6d998d.
- SSH and IAP SSH were unavailable (remote closed connection); used the existing GCE startup script via instance metadata and graceful stop/start of solo-to-china-engine, asia-east1-b, same project and persistent volume. Serial log at 13:17:34 UTC recorded pre-upgrade verified database/content snapshot, then exact image and both containers running; deployment completed 13:17:52 UTC. Snapshot path is suppressed by existing startup logging, so no invented path. Rollback requires the paired snapshot/code described in DEPLOY.md.
- Live 1.17.25 health/readiness returned 200, database ready, Strategy 1.9, zero active queue/Batch. Capture health 200/root 404. Read-only inventory: 74 recommendations, pending 54, 269 directions, approved 16; 17 content records, 28 historical exception rows. No content was requeued/deleted/rewritten by probes.
- PERF01; requirementsVersion=1.3; status=in_progress (1.17.26 deployment pending). Full recovery probe succeeded for 16/17 records; last exceeded 45 seconds. Code inspection found getDraftPackage called listContent for the entire workspace, whose fresh-evidence checks rebuilt every reviewed Brief; recovery assets also loaded topic facts again. This is duplicate work, not a reason to relax freshness validation.
- Added a failing counterexample (reviewed draft detail loaded Brief twice in even a one-item fixture: 2 != 1); scoped operation lookup to candidate and reused only the hash computed in this request. Reused scoped package facts for recovery assets; no cross-request cache or stale-data shortcut.
- 1.17.26 retains Strategy 1.9/schema 55. Targeted recovery/proposal/bulk tests passed 22/22; consolidated release gate passed all 50 mandatory checks, all 380 tests, 0 failures, 4 warnings and 5 explicit untested conditions. Added a read-only timed release probe script.
- Next: commit/push 1.17.26, build/deploy with another verified snapshot, repeat all 17 recovery GETs and record actual timings. Do not mark full online recovery-entry verification passed based on the earlier 16 successes.
