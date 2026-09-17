# SoloToChina Content Production Strategy 3.7

Strategy 3.7 inherits Strategy 3.6 in full: evidence-consistent diagnostics, immutable visual QA checkpoints, revision-safe Affiliate Assets, article usage tracing, approved scope, frozen Writing Packets, finite retries, leases, stable production ownership, and draft-only WordPress delivery remain mandatory. This release changes model routing and its state boundaries; it does not authorize historical replay, automatic model canaries, API-key provisioning, or a second writing workflow.

## 不变的安全边界

事实保护、证据可追溯、商业更新隔离、联盟资产修订与文章使用追踪、有限重试、当前修订所有权、明确人工批准和仅写 WordPress 草稿的边界继续完整生效。模型路由变化不得绕过这些约束。

## Model role contract

New source capture and semantic extraction use a separately selected extraction role. DeepSeek-V4.1-Flash is the recommended candidate. GPT-5.6 Luna can be explicitly activated as the extraction primary. Luna dispute review is a separate operator action over a bounded, persisted evidence package; it is never scheduled automatically and its recommendation never resolves or rewrites Knowledge by itself.

Planning, editorial assembly, English writing, revision, article final review, and image understanding/quality review use Vertex Gemini 3.8 Flash. Necessary image generation and localization redraw use Gemini 3.1 Flash Image. Provider dispatch is explicit: an unknown provider fails closed and never falls back to another vendor.

Each new model-backed Job freezes `model_role`, provider, requested model, routing revision and policy version. Settings changes affect only Jobs enqueued afterwards. Queued, running and completed work retains its original profile; old results are not replayed, relabeled or deleted. Model call receipts record role, requested and returned model, HTTP/provider identity, dispatch evidence, tokens when reported, and an explicitly unknown cost when no current price source is configured.

## Credential and activation contract

DeepSeek and OpenAI credentials may be entered only through the authenticated administration API. Database credentials use AES-256-GCM under an independent deployment root key. Read APIs expose only configured/source/version/masked-suffix state, never plaintext, ciphertext, IV or authentication tag. Saving a candidate and activating it are distinct optimistic-revision operations. Activation requires a configured credential. Connection and capability checks are manual actions and do not activate routing or enqueue business work.

## Source and article isolation

Capture, durable media storage and queue admission do not require the writing provider to be available. Source semantic Jobs require only the provider frozen in their extraction profile. Conversely, an approved article with a complete frozen Knowledge/Writing Packet requires only the fixed Vertex production role and must not consult the current extraction provider or its credential.

Knowledge changes after a draft freezes create an idempotent `update_available` record. They do not clear quality reports, move the draft back to QA, rewrite prose, replace media or enqueue production automatically. Approved opportunities waiting for evidence remain durable; when deterministic readiness becomes true, reconciliation atomically creates or reuses the single production entry Job.

## Image and repair linkage

Strategy 3.6 visual rules remain unchanged. Every provider substep keeps its actual model, HTTP status and dispatch receipt. Once generated/transformed bytes are durably accepted, a later QA failure resumes QA only and cannot purchase the generation again unless the immutable candidate is missing, corrupted or stale.

## Verification boundary

Local validation must cover routing persistence across restart, credential redaction, optimistic conflicts, unavailable-provider isolation, immutable Job profiles, non-destructive Knowledge updates, approved-waiting idempotency, provider response failures and front-end mobile behavior. Real-provider canaries remain separately authorized and bounded. A production deployment may migrate schema and publish code without inserting API keys or activating a new provider.
