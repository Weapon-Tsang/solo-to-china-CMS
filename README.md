# SoloToChina Research & Content Engine

SoloToChina 的内部研究基础设施。V1 采用 **Human Discovery + Human Selection + Assisted Capture**：用户在 Chrome 中明确打开一篇小红书笔记并点击保存，系统再负责持久化、抽取、Claim 建模、冲突检测和 Editorial Blueprint 聚合。

后台“来源”页也支持管理员主动提交公开的小红书、微信公众号、视频和普通网页链接，以及 PDF、Word 和图片文件。提交内容会进入同一套 Source → Claims → Knowledge → Blueprint → 内容建议流程；链接读取失败会明确区分登录墙、反爬、限流、超时、空内容和不支持格式。参见 [Manual Source Ingestion](docs/MANUAL_SOURCE_INGESTION.md)。

这不是小红书爬虫。项目没有搜索、翻页、批量打开、验证码规避、Cookie/Token 读取、私有 API 或账号行为模拟。

## 当前可运行纵向切片

```text
Manually opened Xiaohongshu note
  → Chrome Extension: explicit Save
  → Raw Source + DOM snapshot + image references
  → Durable SQLite job queue
  → Multimodal structured extraction (optional Kimi provider)
  → Claims + Source Blueprint
  → Destination Knowledge Base + conflict state
  → Editorial Blueprint Library
  → Automatic Topic Candidate (evidence threshold)
  → Evidence-backed Brief → Original English Draft
  → Independent QA + one automatic revision
  → Commercial Overlay (optional, isolated, deterministic)
  → WordPress draft-only delivery (optional)
  → Minimal exception/review dashboard
```

- 单进程低运维部署：Node 24、内置 SQLite，React 前端在启动前构建为静态资源并由同一服务托管。
- Raw Capture 以 canonical URL 去重；同一 URL 内容改变时保留递增版本号。
- 未配置 AI Key 时 Capture 不会失败，Source 会进入 `needs_ai`，可稍后批量重跑。
- Research 聚合只读取 `sources` / `claims` / `structured_sources` 等研究表。
- Commercial 数据位于独立 Affiliate Provider / Asset / Intent / Composition / Event 表族，不进入任何 Research 查询或 Prompt；`commercial_offers` 仅作为旧同步 API 的兼容入口。
- 自动选题至少要求 `AUTO_CONTENT_MIN_FACTS` 个 KB Facts 和 2 条独立 Source；Affiliate inventory 不参与评分。
- QA 同时包含独立模型 Review 和不可绕过的代码检查；失败 Draft 最多自动修订一次。
- WordPress 只创建/更新 `draft`。用户发布后，系统会拒绝再次覆盖该文章。
- Commercial Composer 从不修改 Research Draft；它创建独立 Publishable Overlay。没有相关 Offer 时是严格 no-op。

## 本地启动

要求 Node.js 24+。

```powershell
Copy-Item .env.example .env
# 在当前 shell 设置变量，或使用你惯用的 env loader
$env:KIMI_API_KEY = "..." # 可选
npm install
npm start
```

打开 [http://127.0.0.1:4310](http://127.0.0.1:4310)。数据库首次启动时自动创建在 `data/solo-to-china.sqlite`。

The dashboard is a React + Vite application styled with Tailwind CSS and source-owned shadcn/ui components. `npm start` builds the production frontend before starting the single Node process; use `npm run dev` only when iterating on the UI locally (API requests are proxied to port 4310).

> Node 24 当前会为内置 `node:sqlite` 输出一条 ExperimentalWarning；不影响运行。若未来 Node 改变该 API，只需要替换 `src/db.mjs`，领域层无须变化。

## 安装 Chrome Extension

1. 打开 `chrome://extensions`。
2. 开启 Developer mode。
3. 点击 Load unpacked，选择仓库内的 `extension/` 目录。
4. 打开一篇 `https://www.xiaohongshu.com/explore/...` 笔记。
5. 点击扩展，再点击 **Save current note**。

扩展默认连接 `http://127.0.0.1:4310`。如设置了 `CAPTURE_TOKEN`，在扩展的 Connection settings 中填入相同值。

扩展只声明：

- `activeTab`：用户触发后读取当前标签页；
- `scripting`：注入一次性的 DOM 提取函数；
- `storage`：保存本地 Engine URL 和 Capture Token；
- localhost host permission：向本机 Engine 发送 Capture。

它没有小红书 host permission，无法在后台批量读取小红书页面。

## AI 配置

AI 是可替换适配器，核心数据库与队列不依赖模型供应商。当前适配器使用 Kimi Chat Completions 的图文输入和 JSON Schema Structured Outputs。设置：

```text
KIMI_API_KEY=...
AI_MODEL=vertex-gemini-3.8-flash
KIMI_MODEL=kimi-k3
KIMI_BASE_URL=https://api.moonshot.cn/v1
KIMI_MAX_IMAGES=8
KIMI_MAX_COMPLETION_TOKENS=16000
KIMI_REQUEST_TIMEOUT_MS=360000
KIMI_IMAGE_TIMEOUT_MS=20000
AUTO_CONTENT_MIN_FACTS=5
AUTO_CONTENT_MAX_PER_DESTINATION=1
```

对模型的每一个事实输出都必须落成带 `source_quote`、confidence 和 qualifiers 的 Claim。模型不会直接修改聚合事实；KB 根据独立 Source 证据数将状态标记为 `single_source`、`corroborated` 或 `conflicted`。

## Kimi AI configuration

## Frontend Capability Contract

The CMS consumes the Frontend's generated `contracts/component-registry.json` and `contracts/page-schema.json`; it never scans Frontend source code or maintains a copied component list. When a compatible Contract is synchronized, the CMS selects semantic components/variants and produces a validated `page.blocks[]` payload before the publish gate. Commercial/affiliate capabilities are excluded from pre-QA editorial composition and queried separately only by the post-QA Commercial Composer. See [Frontend Contract Integration](docs/FRONTEND_CONTRACT_INTEGRATION.md) for the audited source paths, cache behaviour, diagnostics, version compatibility, and capability-gap handling.

Kimi is the active AI provider. The engine calls Kimi Chat Completions with JSON Schema structured output and sends trusted Xiaohongshu image assets as base64 vision input. Keep the key on the server only: it is never sent to the Chrome Extension or written to SQLite.

```powershell
Copy-Item .env.example .env
# Edit .env and set KIMI_API_KEY=your-kimi-key, or use the temporary shell alternative below.
$env:KIMI_API_KEY = "your-kimi-key"
$env:AI_MODEL = "vertex-gemini-3.8-flash"
$env:KIMI_MODEL = "kimi-k3"
$env:KIMI_BASE_URL = "https://api.moonshot.cn/v1"
npm start
```

`gemini-3.8-flash` on Vertex AI is the default multimodal model for new installations; Kimi K3 and Kimi K2.7 Code remain available from Settings. Gemini 3.8 Flash uses the global Vertex AI endpoint for image understanding, structured extraction, writing, and review. The separate image-generation default remains `gemini-3.1-flash-image`. Image assets are fetched in parallel and unavailable assets are skipped rather than blocking the full note. Existing Sources can be re-run after a model change; no recapture is required.

### Model selection

After an administrator enters the dashboard token, open **Settings** and choose **Kimi K3** or **Kimi K2.7 Code**. The selected model is stored in SQLite, survives restarts, and applies to subsequently started extraction and content jobs. The server key remains server-side; selecting a model never exposes it to the Chrome Extension.

## SEO/GEO package and original visuals

Each generated English Draft includes a reader-facing SEO/GEO package: a concise meta title and description, focus keyword, key takeaways, visible FAQs, an `Article` JSON-LD graph, and an optional `FAQPage` graph. Schema uses the public site URL and publisher values below when configured; it does not put affiliate links or internal research fields into the article.

The engine plans 2--5 rights-safe, original editorial images according to article length. Visual plans are always saved alongside the Draft; they stay pending on a local machine. To create and serve original images in production, enable Vertex Imagen on the GCE VM:

```text
IMAGE_ENABLED=true
IMAGE_PROVIDER=vertex_gemini
VISUAL_MODEL=vertex-gemini-3.1-flash-image
IMAGE_MODEL=gemini-3.1-flash-image
GOOGLE_CLOUD_PROJECT=your-project-id
VERTEX_AI_LOCATION=global
VERTEX_IMAGEN_MODEL=imagen-4.0-generate-001
PUBLIC_BASE_URL=https://engine.example.com
PUBLIC_CONTENT_SITE_URL=https://www.solotochina.com
CONTENT_PUBLISHER_NAME=SoloToChina
CONTENT_PUBLISHER_LOGO_URL=https://www.solotochina.com/logo.png
```

Generated assets use original no-text/no-logo illustration prompts and are uploaded into WordPress as media when the Draft is delivered. Real-world photos, maps, and infographics remain acquisition/render tasks and are never fabricated by the image model. `WORDPRESS_SCHEMA_JSONLD_META_KEY` can write the graph to a REST-exposed custom SEO meta field when your WordPress theme or SEO plugin supports one.

## Content Production Strategy 1.3

The active strategy is defined in [`config/content-strategy.json`](config/content-strategy.json), documented in [`docs/content-strategy/CONTENT_PRODUCTION_STRATEGY_1.3.md`](docs/content-strategy/CONTENT_PRODUCTION_STRATEGY_1.3.md), and summarized by an append-only [evolution log](docs/content-strategy/CHANGELOG.md). The live operating path is:

```text
Capture → structured research → Kimi Intake Analysis → Recommendation → human decision
                                                       → Approve article only → planning → canonical content → QA → WordPress draft
```

The **Recommendations** tab is the only new recurring decision point. Choose **Approve article** only when a source-backed opportunity is worth turning into an English guide; choose the other actions when the material should enrich knowledge, join a cluster, wait for research, or be ignored. Every new downstream record carries Strategy `1.2`; historical records retain the strategy version that created them.

Every source image in an explicitly saved note is owner-confirmed as authorized for SoloToChina publication. The system traces article evidence back to those source assets, prioritizes matching real-world photos as WordPress draft media, and retains their provenance. Maps and infographics are rendered from validated data, while image generation is limited to non-factual original illustrations.

## Google Cloud + Cloudflare deployment

The production package uses a persistent Google Compute Engine VM, Docker Compose, Cloudflare Tunnel, and Cloudflare Access. This is deliberate: the current system has a persistent SQLite queue and in-process scheduler, so it should not be put directly on stateless Cloud Run. Follow the [GCE + Cloudflare deployment guide](deployment/gce/DEPLOY.md) to build the image, configure the two hostnames, package the cloud extension, and verify the result.

## WordPress inventory and topic protection

When WordPress credentials are configured, the engine reads published and in-progress posts into a local inventory before rebuilding topic candidates. Exact slug/title matches and high-overlap titles are marked `dismissed` with a `wordpress:` suppression reason, so they cannot enter automatic planning. The inventory request never edits WordPress content.

```text
WORDPRESS_INVENTORY_SYNC_HOURS=24
```

- `GET /api/wordpress/inventory` returns the read-only inventory and sync state.
- `POST /api/wordpress/inventory/sync` queues a protected, read-only refresh.

## Hands-off maintenance

`v1.1.0` keeps long-running installations current without requiring restarts. The durable scheduler checks WordPress inventory, recalculates Knowledge freshness, creates verified SQLite backups, and removes only expired successful Job history. Failed work is retained in Exceptions.

```text
MAINTENANCE_ENABLED=true
MAINTENANCE_INTERVAL_MINUTES=15
KNOWLEDGE_RECONCILE_HOURS=24
AUTO_BACKUP_HOURS=24
JOB_HISTORY_RETENTION_DAYS=30
```

Use the **Maintenance** view for last-run status or an exceptional admin-triggered run. Normal operation requires no action.

## Operational visibility and exception alerts

`v1.2.0` adds rolling Job performance telemetry, structured request/job logs, a database-backed readiness endpoint, and optional deduplicated exception webhooks. These features reuse SQLite and stdout, so no metrics database or manual alert register is required.

```text
TELEMETRY_WINDOW_HOURS=24
LOG_LEVEL=info
LOG_FORMAT=json
EXCEPTION_WEBHOOK_URL=https://automation.example/hooks/solo-to-china
EXCEPTION_NOTIFICATION_MIN_SEVERITY=blocker
EXCEPTION_NOTIFICATION_REPEAT_HOURS=24
```

The Maintenance view shows queue depth, success rate, and p95 queue/processing latency. `GET /api/ready` supports deployment readiness probes. Use `npm run backup:drill -- <backup.sqlite>` to exercise an isolated restore without touching the live database.

## V1 operational controls

- Volatile facts such as prices, opening hours, schedules, booking rules, and transport routes are classified as `time_sensitive`; old evidence becomes `stale` and cannot pass deterministic QA.
- The **Exceptions** view combines exhausted jobs, stale/conflicted facts, integration failures, draft failures, and WordPress delivery failures.
- `ADMIN_TOKEN` protects every admin mutation. Non-loopback binding requires both `ADMIN_TOKEN` and `CAPTURE_TOKEN`.
- `npm run backup` creates a consistent, checksummed SQLite snapshot; `npm run backup:verify -- <file>` verifies it independently.
- `npm run backup:drill -- <file>` restores into a temporary database, applies migrations, checks integrity, and reads critical table counts.
- Optional WordPress author/category/tag, featured-media, template, Gutenberg format, and REST-exposed SEO meta mappings keep every delivery in `draft`.
- Optional Search Console service-account sync automatically protects topic planning from query-level cannibalization; performance rows never enter Research prompts or the Knowledge Base.

See [V1 Operations](docs/OPERATIONS.md), [V1 Acceptance](docs/V1_ACCEPTANCE.md), and [Changelog](CHANGELOG.md).

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/system/info` | Application, Kimi, and active Content Strategy information |
| `GET` | `/api/recommendations` | Strategy-versioned intake recommendations and content opportunities |
| `POST` | `/api/recommendations/:id/decision` | Admin-only human decision; only `approved_article` may queue planning |
| `GET` | `/api/health` | Engine 与 AI 配置状态 |
| `GET` | `/api/ready` | 数据库支持的部署就绪探针 |
| `POST` | `/api/captures` | Extension 显式提交当前笔记 |
| `GET` | `/api/sources` | Source 列表 |
| `GET` | `/api/sources/:id` | Raw/Structured/Claims/Blueprint 详情 |
| `POST` | `/api/sources/:id/retry` | 重跑异常或 `needs_ai` Source |
| `POST` | `/api/manual-sources` | 管理员提交公开链接、PDF/Word 或图片并进入统一生产流程 |
| `GET` | `/api/knowledge` | Destination KB 与证据/冲突 |
| `GET` | `/api/editorial-blueprints` | 聚合 Editorial Pattern |
| `GET` | `/api/content` | Topic/Brief/Draft/QA/WordPress 状态 |
| `GET` | `/api/commercial` | Provider、Asset、Mapping、Opportunity 与 Performance 总览 |
| `GET/POST` | `/api/commercial/providers` | 管理 Affiliate Provider Account（V1 默认 MANUAL） |
| `GET/POST` | `/api/commercial/assets` | 管理安全、可复用的 Affiliate Asset Registry |
| `GET` | `/api/commercial/mappings` | 查看 Destination / Area / Route / Entity 映射 |
| `GET` | `/api/commercial/opportunities` | 只显示超过人工维护门槛的高价值精度缺口 |
| `POST` | `/api/commercial/events` | 记录 impression / click（预留 booking / commission） |
| `GET` | `/api/commercial/performance` | CTR、conversion、commission、EPC、RPM 聚合 |
| `GET/POST` | `/api/commercial/offers` | 旧 typed Offer API；写入时同步投影为 Affiliate Asset |
| `POST` | `/api/topics/:id/generate` | Backwards-compatible endpoint; returns `409` until an Intake Recommendation is approved |
| `POST` | `/api/topics/:id/retry` | 重试少量内容异常 |
| `GET` | `/api/drafts/:id` | Draft、Evidence Ledger 和 QA 详情 |
| `POST` | `/api/drafts/:id/wordpress` | 将 QA-passed Draft 补推到 WordPress |
| `GET` | `/api/dashboard` | 低运维状态指标 |
| `GET` | `/api/search-console` | 只读查询/页面表现库存与同步状态 |
| `POST` | `/api/search-console/sync` | 管理员触发只读 Search Console 同步 |

## WordPress draft-only 配置

```text
WORDPRESS_SITE_URL=https://example.com
WORDPRESS_USERNAME=solo-to-china-editor
WORDPRESS_APPLICATION_PASSWORD=xxxx xxxx xxxx xxxx
WORDPRESS_CONTENT_FORMAT=blocks
WORDPRESS_FEATURED_MEDIA_ID=
WORDPRESS_SEO_TITLE_META_KEY=
WORDPRESS_SEO_DESCRIPTION_META_KEY=
```

适配器使用 WordPress 官方建议的 HTTPS + Application Password Basic Auth，并调用 `POST /wp/v2/posts`。发送的 `status` 被代码固定为 `draft`；编辑权限账号应遵循最小权限原则。参考 WordPress 官方 [Authentication](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/) 与 [Posts endpoint](https://developer.wordpress.org/rest-api/reference/posts/) 文档。

## Search Console query protection

Search Console is an optional read-only strategy adapter, not a Research Source. It automatically synchronizes query/page performance through a service account, stores it in `search_console_inventory`, and reversibly suppresses new Topic Candidates that overlap a query already served by an existing page.

```text
SEARCH_CONSOLE_SITE_URL=sc-domain:example.com
GOOGLE_SERVICE_ACCOUNT_EMAIL=search-reader@project.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
SEARCH_CONSOLE_SYNC_HOURS=24
SEARCH_CONSOLE_MIN_IMPRESSIONS=10
```

The service account needs read access only. Credentials remain process-environment values: they are never written to SQLite, returned by APIs, or included in structured logs.

## Affiliate Provider 与 Asset Registry

V1 使用 MANUAL Provider：先在 Trip.com 官方 Affiliate Platform 创建官方链接或 Embed 配置，再把公开产物保存到 CMS。不要保存用户名、密码、Cookie 或登录态，不要自动登录/爬取后台，也不要猜测 Tracking 参数。

```json
{
  "providerAccountId": "provider_...",
  "provider": "Trip.com",
  "assetType": "CATEGORY_LINK",
  "productCategory": "HOTEL",
  "scopeType": "DESTINATION",
  "scopeKey": "beijing",
  "destinationSlug": "beijing",
  "title": "Browse Beijing hotels",
  "targetUrl": "https://official-trip-affiliate-link.example/",
  "ctaLabel": "Check hotel options",
  "description": "Compare available stays for your travel dates.",
  "priority": 10,
  "active": true
}
```

`assetType`（怎么展示）与 `productCategory`（卖什么）严格分开。Link 必须是无凭据 HTTPS；Search Box/Banner 只接受结构化、域名 allowlist 的配置，拒绝任意 HTML/script。Composer 仅在 QA 后解析 block-level intent，按用户决策精度选择 Entity/Route/Area/Destination/Category fallback，并限制为通常 1–2 个 contextual units 加 0–1 个 end-resource unit。无匹配 Asset 时严格 no-op。

## 验证

```powershell
npm test
npm run check
```

测试覆盖 Adapter 边界、URL 清洗、Capture 幂等/版本、持久化队列、Claim/KB/Blueprint、多类型自动选题、自动内容链、确定性 QA、typed Offer/Commercial 隔离、WordPress draft 强制状态与已发布文章保护。

## Release Check

```powershell
npm run release:check
```

This is the single local release gate. It builds the production frontend, runs static and unit/integration checks, starts an isolated server on a temporary loopback port with a temporary SQLite database, polls real HTTP readiness, smoke-tests core APIs and React assets, validates the Chrome Extension manifest/assets, then always stops the test server and removes its temporary data. It never calls AI, WordPress, Search Console, or the live database.

The final report uses `PASS`, `WARNING`, `FAIL`, and `NOT TESTED`. A zero exit code and `READY FOR EXTENSION INTEGRATION` mean all mandatory local checks passed; real Chrome loading and user-selected note capture remain explicit manual acceptance steps.

## 文档

- [Architecture](docs/ARCHITECTURE.md)
- [V1 roadmap](docs/ROADMAP.md)
- [Research and commercial boundary](docs/RESEARCH_BOUNDARY.md)
