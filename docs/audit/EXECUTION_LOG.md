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
| A10 | 1.3 | pending | `d642f0f` | After A09; stable semantic provenance IDs |
| A11 | 1.3 | pending | `d642f0f` | After A10; deterministic final artifact evidence gate |
| A12 | 1.3 | pending | `d642f0f` | After A11; coverage status dimensions |
| A13 | 1.3 | pending | `d642f0f` | After A12; scoped assignment evidence selection |
| A14 | 1.3 | pending | `d642f0f` | After A13; UI request races and refresh truthfulness |
| A16 | 1.3 | pending | `d642f0f` | After A14; login throttling and trusted proxy handling |
| B10 | 1.3 | pending | `d642f0f` | Full-system backup manifest and restore; safety principles already active |
| B11 | 1.3 | pending | `d642f0f` | Extend existing offline release gate; baseline captured above |
| B03 | 1.3 | pending | `d642f0f` | Media-aware preflight and mixed PDF evidence |
| B04 | 1.3 | pending | `d642f0f` | Evidence-bounded English quality fixtures and gates |
| B05 | 1.3 | pending | `d642f0f` | Frozen stage policy, bounded repair, full attempt cost ledger |
| B06 | 1.3 | pending | `d642f0f` | Durable artifact invalidation and fair scheduling |
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
- Current task: A10.
- Next action: replace page-block array-index provenance with stable section/node
  references and preserve legacy mappings without pretending they are exact.
