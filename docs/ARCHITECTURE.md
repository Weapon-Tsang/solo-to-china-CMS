# Architecture

## Design target

长期人工操作必须尽可能只剩：决定 Source 是否值得保存、决定最终 Draft 是否发布、处理少量异常/冲突。任何需要维护 Excel、Source Card、Research Pack、手工标签或手工 Knowledge Base 的流程，都视为产品缺陷。

## Runtime shape

V1 是一个单进程模块化单体：

```text
Chrome Extension (explicit click)
         │ POST /api/captures
         ▼
┌──────────────────────────────────────────────┐
│ Node process                                 │
│  HTTP API + React dashboard                  │
│  Xiaohongshu Adapter                         │
│  Persistent SQLite job runner                │
│  AI Provider Adapter                         │
│  Knowledge + Editorial aggregators           │
└──────────────────────┬───────────────────────┘
                       ▼
                 SQLite database
```

The production dashboard is built by Vite into `dist/` and served by the same Node process as the API. React owns view state and interactions; Tailwind CSS, Lucide icons, and source-owned shadcn/ui primitives provide the visual system without adding a separate frontend service.

选择模块化单体是为了减少部署、监控、队列和数据库运维。`jobs` 表承担持久化队列：进程重启后保留任务，指数退避重试，超过最大次数才进入人工异常。未来负载增长时，可以把同一个 `Pipeline` 类移到独立 Worker，而不更改领域模型。

## Domain layers

### 1. Capture / raw evidence

- `sources`：canonical URL、原始文字、净化 DOM snapshot、内容 hash、版本和状态。
- `source_assets`：当前页面已经展示的图片 URL 与顺序。
- Raw 层只追加/版本化，不做“纠错”。它是所有派生数据的可追溯依据。

当前 V1 保存图片引用而不是携带登录态下载 CDN 原文件。这样不触碰 Cookie/Token，也避免把自动下载伪装成 Capture。后续只有在明确验证公开 URL 和授权边界后，才增加独立 Asset Archiver。

### 2. Source intelligence

- `structured_sources`：摘要、Destination、旅行者适配、实用提示与 warning。
- `claims`：原子事实断言。每条都有 stable key、原文 quote、qualifier、confidence、verification status。
- `source_blueprints`：内容结构、hook、angle、sections、strengths、gaps。它描述内容表达，不作为事实证据。

### 3. Aggregated intelligence

- `knowledge_facts`：同 Destination、同 Claim key 的多 Source 聚合。
- 值一致且证据 > 1 → `corroborated`。
- 只有一个 Source → `single_source`。
- 出现不同值 → `conflicted`，保留全部 evidence，不自动覆盖。
- `editorial_blueprints`：跨 Source 聚合表达模式，与 KB 分开。

### 4. Content production

- `topic_candidates`：从 Destination KB 覆盖率生成，不读取 Commercial 数据。默认要求至少 5 个 Facts 和 2 条独立 Source。
- `content_briefs`：Outline 中的事实段落必须引用真实 Claim key。
- `article_drafts`：Reader-facing Markdown 与内部 Evidence Ledger 分开存储。
- `quality_reviews`：独立模型 Review，再叠加代码级 evidence/commercial/conflict/length gates。
- QA 失败时自动修订一次；仍失败才保留为异常供人工判断。
- `wordpress_publications`：保存内部 Draft 到 WordPress post ID 的幂等映射。

QA 通过并配置 WordPress 时会自动创建 `draft`。这不等于发布；最终 Publish 始终由用户在 WordPress 完成。

### 5. Commercial layer

`commercial_offers` 与 `commercial_compositions` 是独立表族。Research Extractor、Claim Aggregator、KB、Topic Candidate、Brief、Draft 和 QA Package 均不读取它。

Commercial Composer 仅在 Research Draft 通过 QA 后运行：

```text
Frozen Research Draft + destination-relevant active Offers
  → deterministic relevance and category dedupe
  → disclosure + typed end-resource slots
  → independent Publishable Overlay
```

每个分类最多一个 Offer；无相关 Offer 时 Overlay 与 Research Draft 完全一致。Research Draft、Evidence Ledger 和 Knowledge Base 从不被修改。Offer feed 更新只重组尚未同步到 WordPress 的 Draft。

### WordPress inventory guard

`wordpress_content_inventory` is a read-only mirror used before topic planning; it is not Research evidence and never enters prompts. `integration_sync_state` records inventory freshness and failures without a manual spreadsheet or checklist.

At startup, a stale inventory sync is queued before topic reconciliation. Candidate generation suppresses exact slug/title collisions and high-confidence title overlap. Suppression is reversible when a later inventory no longer contains the collision; candidates that already became briefs or drafts are never silently rolled back.

### Search Console strategy guard

`search_console_inventory` is a read-only query/page performance mirror. It belongs to Content Strategy, not Research: it never enters extraction, Claims, Knowledge aggregation, editorial blueprints, briefs, drafting prompts, QA evidence, or Commercial selection.

An optional service-account adapter synchronizes a bounded rolling window through the Search Console API. Topic planning suppresses high-overlap queries with meaningful impressions before a brief is created; the suppression is automatically reversed when later inventory no longer contains the overlap. Sync state and retries reuse `integration_sync_state` and the durable Job queue.

## Content state transitions

```text
candidate → brief_queued → brief_ready → drafted
                                      → qa_queued → qa_failed → automatic revision
                                                  → ready_for_wordpress
                                                  → commercial_ready
                                                  → wordpress_draft
```

WordPress 更新前先读取现有 post。只要它不再是 `draft`（例如用户已经发布），系统就拒绝覆盖。

启动时会自动 reconciliation：为既有 Destination 重建 Topic Candidate；如果后来才配置 AI Key，已有 Candidate 会继续生产；如果后来才配置 WordPress，已通过 QA 的 Draft 会进入 draft-only 同步队列。

## State transitions

```text
captured → processing → processed
                    └→ needs_ai (capture safe; provider not configured)
                    └→ exception (retries exhausted)
```

实际 V1 在 job running 期间保留 `captured`，完成后进入 `processed` / `needs_ai`。Dashboard 只把 `exception` 和 `conflicted` 暴露为需要人工关注的队列。

## V1 operational boundary

- Knowledge Facts carry `freshness_state`, `latest_evidence_at`, and `verification_priority` derived from captured evidence dates and volatile predicates.
- Deterministic QA blocks stale evidence and requires internal verification notes for used time-sensitive facts.
- The Exceptions projection derives the small human-attention queue from domain state; it does not create a second manual tracking system.
- SQLite backup uses `VACUUM INTO` for a consistent snapshot, then verifies integrity and writes a SHA-256 manifest.
- Capture and admin credentials are separated. A non-loopback bind is impossible without both tokens.

### Hands-off maintenance

`MaintenanceScheduler` is an in-process coordinator, not a second worker system. It stores durable task state in `maintenance_runs`, reuses the existing idempotent Job queue for Knowledge and WordPress work, calls the verified backup primitive, and removes only expired successful Job rows. It never discovers Sources, calls Xiaohongshu, generates content directly, or publishes WordPress posts.

### Operational visibility and alerts

Migration 7 adds durable first-start, completion, queue-latency, and end-to-end duration fields to `jobs`. Migration 8 adds isolated Search Console performance inventory. The Maintenance API/UI calculates a bounded rolling window (default 24 hours) with success rate and p50/p95 latency; it does not require a second metrics database.

HTTP and background work emit structured stdout events with request/job IDs. `GET /api/ready` is a database-backed deployment readiness probe. An optional HTTPS webhook sends only new, changed, or repeat-due Exceptions. Delivery fingerprints and outcomes live in `exception_notification_state`, so restarts do not create duplicate alerts and resolved exceptions are removed automatically.

## Security and compliance boundary

- Adapter 只接受 `xiaohongshu.com/explore/...`。
- Extension 只有 `activeTab`，没有 Xiaohongshu host permission。
- DOM 读取发生在用户二次明确点击 Save 后。
- 不访问 Cookie、localStorage、认证 Token 或私有 API。
- 不进行搜索、翻页、批量打开、重试风控页面、验证码或签名逆向。
- 默认只监听 `127.0.0.1`；若暴露到网络，必须在反向代理增加 TLS 和身份认证。
