# SoloToChina 全量修复进度

更新时间：2026-09-08

本文件记录 `docs/audit/handoff/01_问题清单.txt` 与 `02_完整修复提示词.txt` 对应问题的实施、验证和部署状态。附件中的提示词仅作为需求输入；实际变更以当前代码、测试和发布结果为准。

## 当前结论

- A01–A19、B01–B10 的代码修复与优化全部完成。
- CMS 生产版本为 `1.16.0`，数据库迁移为 1–33，内容生成策略版本为 `1.5`；当前对应关系修正版本为 `1.16.1`，包含迁移 34。
- 前端 Parent Theme 版本为 `0.28.0`，Component Registry 兼容版本为 `1.1.0`，Content Contract 版本为 `2.1.0`。
- 双仓库真实契约交叉验证、CMS 全量测试与 release check、WordPress Playground PHP 8.3 运行验证、前端发布包检查均已通过。
- CMS 与前端代码已经提交并推送；WordPress Parent Theme `0.28.0` 和 CMS `1.16.0` 均已部署并通过生产健康检查与契约同步验收。

## 问题状态

| 编号 | 状态 | 修复与验证证据 |
| --- | --- | --- |
| A01 | 已完成 | 重写 PowerShell JSON 组装，完整保留嵌套结构；发布前执行递归归一化与校验，并通过真实前端产物交叉验证。 |
| A02 | 已完成 | Vertex 请求使用原生 `responseJsonSchema`，保留 OpenAPI fallback；Vertex/Kimi 输出在保存前执行完整 Schema 校验和一次纠偏。 |
| A03 | 已完成 | Opportunity 仅使用本题主题与实体范围内的 Claim 和 `selectedFactKeys`，无关来源不再抬高 readiness。 |
| A04 | 已完成 | 多模态提取记录计划模态、实际模态和资产 ID；图片或视频缺失时生成明确的 coverage gap。 |
| A05 | 已完成 | QA 覆盖最终 Page Payload，并执行页面硬门禁：空页面、缺标题、Evidence Ledger 缺失和商业资产问题均会阻断。 |
| A06 | 已完成 | Draft、QA、Page、Commercial、Publish 均绑定精确 revision、content hash 与 evidence hash；上游变化会使旧产物失效。 |
| A07 | 已完成 | 必需视觉缺失时，希望地图、信息图等真实 renderer 未成功前保持 incomplete；画廊只能使用明确匹配的资产。 |
| A08 | 已完成 | 图片生成和 WordPress 上传均持久化幂等；slot + fingerprint 防止瞬时失败丢失结果，已成功项不重复生成。 |
| A09 | 已完成 | 证据区分 published、observed、verified、effective 时间；关键 Claim 要求可定位原文 offset 或视觉证据，伪引用不能进入 Knowledge。 |
| A10 | 已完成 | 真实照片必须达到目标实体和来源可信度阈值；无法授权的素材默认不采用，alt/caption 使用实体匹配结果。 |
| A11 | 已完成 | PHP 在 WordPress 最终标题、正文和修改时间确定后生成 canonical 与 JSON-LD，并兼容 Yoast、Rank Math、AIOSEO，避免重复 meta/schema；人工稿保留原 schema。 |
| A12 | 已完成 | CMS 与 PHP 对 blocks、HTML、URI 和可控字段执行双重校验；危险协议、凭证 URL、不安全 HTML 和无效内容均会拒绝。 |
| A13 | 已完成 | 长文本按自然边界切块，并保留页码、时间范围、模态和文件信息，取消会破坏语义的固定截断。 |
| A14 | 已完成 | 去重采用字符 n-gram；corroboration 只统计独立来源族，镜像、转载和聚合源不能冒充多源证据。 |
| A15 | 已完成 | 密码改用异步 `scrypt`；会话持久化到数据库，可按用户登出和撤销。删除用户或轮换密码时，旧 cookie 立即失效。 |
| A16 | 已完成 | Job 增加 owner、lease、heartbeat、CAS complete/fail 和过期回收；并发只领取有效容量，worker 退出时收敛。 |
| A17 | 已完成 | WordPress 首次写入使用跨 worker 原子锁；创建前后均按 CMS 标识查询并复用旧结果，防止重复发布或覆盖已发布文章。 |
| A18 | 已完成 | 增加官方证据人工确认 API、UI 和历史；authority/verified 变化触发 Knowledge 重建，系统只给建议，不自动确认。 |
| A19 | 已完成 | Registry 明确 `cmsUsable`、interface 与 renderMode；Page Block 与 Presentation 解耦，原文始终可用。 |
| B01 | 已完成 | 按内容类型、意图和证据动态计算字数、FAQ 与配图策略，移除固定 1200 字和固定数量要求。 |
| B02 | 已完成 | Prompt DTO 提供可读来源标题、域名、URL 与发布日期；正文生成面向读者可见的 Sources，内部 Claim/Source ID 不进入正文。 |
| B03 | 已完成 | FAQ 仅在用户意图与证据充足时生成；FAQPage 与可见 FAQ 严格一致，否则删除。策略 1.5 纳入 2026-09-08 官方政策复核。 |
| B04 | 已完成 | Opportunity 标注 create/update/merge/retire、目标 post 与影响；提供管理员生命周期 API，update/merge/retire 必须人工批准且不自动删除或下线。 |
| B05 | 已完成 | 页面区块使用稳定 blockId 和 semantic role，链接对应 Claim/Source provenance；内部链接只引用已同步且已发布的 WordPress inventory。 |
| B06 | 已完成 | Pipeline 使用 1–8 并发槽并受数据库 lease/heartbeat 控制；按 Retry-After 指示退避，重试不会造成重复执行。 |
| B07 | 已完成 | 模型调用记录 stage、provider、model、输入哈希、token、缓存 token、延迟、attempt/status/error；未知成本保持 null。 |
| B08 | 已完成 | Writer/Reviewer 使用版本化 DTO；日志仅保存 prompt、schema、input 的 SHA-256；加入 128 项 LRU 结果缓存和并发请求合并，不持久化原始提示词或来源正文。 |
| B09 | 已完成 | Provider 对限流和瞬时错误支持 Retry-After；Frontend snapshot 使用 Registry、Page、Publish 三份契约的组合 checksum，并保存前端 commit SHA、snapshot ID 和 checksum。 |
| B10 | 已完成 | `test:cross-repo` 读取 sibling 前端真实产物，在临时数据库验证真实 Publish Package，并已并入 `release:check`。 |

## 验证记录

- CMS `npm test`：129/129 通过。
- CMS `npm run check`：Vite production build 和全部 Node syntax check 通过。
- CMS `npm run release:check`（1.15.2）：39 项强制检查通过，0 失败，覆盖迁移 1–32、SQLite integrity、真实 HTTP/API/UI smoke、Extension 清单和跨仓库契约门禁。
- 跨仓库门禁：Contract `1.1.0`，组合 checksum `e81cf6bd8cf2ff6f6e6c6a6e233edfccdf46fb60633a2500a2ef8638a7d8dbe1`。
- 前端静态验证：project、page architecture、component registry、content contract 全部通过。
- WordPress Playground：CLI `3.1.52`、PHP `8.3` 下的主题 CMS Publish Adapter 集成通过，Child Theme Content Runtime 验证通过。
- 前端发布包已生成：`dist/solo-to-china-theme.zip`、`dist/solo-to-china-child-theme.zip`、`dist/solo-to-china-tools-plugin.zip` 和 `dist/release-manifest.txt`。
- 发布包 SHA-256：Parent Theme `BFFF90490C2331B9A8635EAA7BC1BA89A516DC719ACFF4D42CD51F586B6ADB91`；Child Theme `AA853767976F448FA7080922BC24F5425B80CBD0AD748CF3AD9F25844E1C2C41`；Tools Plugin `135F59BCF0F1A8410863C891385289CB5B182384CE3FCEB57A3F5D89358A652D`。
- release check 未调用真实 Kimi/Vertex 云服务、真实 Search Console 数据或生产 WordPress 写入；这些依赖运行时凭证，只在生产部署阶段验证连接状态和只读健康检查。

## 提交、部署与回滚记录

- CMS 主修复 commit：`de6a9ca`；生产热修复 commit：`97ce60d`，均已推送到 `origin/main`。
- Frontend commit：`fcd1cb0e936b666c888ade7ea8b648799e3fb3be`，已推送到 `origin/main`。
- Artifact Registry `engine:1.15.0`：`sha256:d53196d412ef48db42b47ea942c54e8815d5db2e12b6d96bb0e5cf8a07ce6b25`。
- Artifact Registry `engine:1.15.1`：`sha256:83a3bf7f547245a8308adef97a616a717d1fc485fb5c5176fc257be4e7e31aaf`，Cloud Build ID `56f4cc76-1e5f-4d63-bdd7-630344f4976b`。
- Artifact Registry `engine:1.15.2`：`sha256:f379eba4113503cbaa69949eba0f72bf49240b923bdb79180a2cdc6404c0a05f`，Cloud Build ID `644a4c95-2ce5-4dae-87a5-982388115665`。
- CMS `1.15.2` 修复 commit：`44f08a6ef04770cb8dd2f64d3c1c5c2b078bd085`，已推送到 `origin/main`。
- GCE `solo-to-china-engine` 已切换至 `1.15.2`；`https://engine.solotochina.com/api/health` 返回 `ok: true`、version `1.15.2`、strategy `1.5`、Frontend Contract `healthy`；`/api/ready` 返回 `ready: true`、database `ready`，WordPress 首页返回 HTTP 200。
- 迁移 32 移除旧表对 Registry checksum 的错误唯一约束，改为非空 artifact checksum 的部分唯一索引，解决同一 Registry 配合新版 Page/Publish 契约时被误判 stale 的问题。
- WordPress Parent Theme 已通过生产后台从 `0.27.0` 替换为 `0.28.0`。带版本参数的公开资源确认主题为 `0.28.0`；Registry、Page Schema、Publish Package Schema 与前端仓库产物逐字节一致，ETag 分别为 `2e8da42b4fa86f8e717b992d648cae222bbbbe59a2b9d78848f0181bb9415fd3`、`f44dc8bad0b15ec3c976e448b8d0e6e49a92afb4af80230aa36a736afa7c94c8`、`0a9b26f8aa01499320820214b398da17a517b042f2039dd6f216869d4ca52b62`。
- 生产验收发现 Cloudflare 的无查询 URL 仍可能命中部署前缓存。CMS `1.15.2` 为三份 HTTPS 契约 URL 自动附加精确的 `FRONTEND_CONTRACT_COMMIT_SHA`，保留原查询参数并发送 `Cache-Control: no-cache`；新增回归测试已覆盖三份资源。
- CMS 生产同步已激活新快照 `fcontract_e829b4d699df4aadb5755a1094111e28`，Registry checksum 为 `2e8da42b4fa86f8e717b992d648cae222bbbbe59a2b9d78848f0181bb9415fd3`，Frontend commit 为 `fcd1cb0e936b666c888ade7ea8b648799e3fb3be`，23 个组件全部可用且 `canCompose: true`。
- 回滚点：GCE 启动脚本部署前生成的 SQLite 备份；前端上一版本 Parent Theme `0.27.0`；CMS 上一稳定镜像 `1.15.0`（并保留 `1.14.1`）。

## Trip.com Affiliate Asset Setup Queue（2026-09-08，生产已发布）

- 状态：实现、本地验收、提交、推送和生产部署全部完成。
- 本地应用版本已更新为 `1.16.0`；内容生产策略仍为 `1.5`，未因实现型功能改动而抬升策略版本。
- 新增 Migration 33：`affiliate_asset_queue_tasks`，包含唯一 `task_key`、唯一且不可变的 `trip_sub1`、状态/Opportunity/Provider 索引，以及 Asset 完成关联。
- 新增显式 Seed 文件 `config/affiliate-queue-seeds.json`；初始范围仅为 Beijing/Shanghai 的 HOTEL/ATTRACTION 四项，不做城市、酒店、路线、机场或实体组合扩张。
- HIGH/VERY_HIGH 且达到 `AFFILIATE_OPPORTUNITY_THRESHOLD` 的 Affiliate Opportunity 会在缺少 exact Asset/等价任务时生成 Queue Task；broad fallback 不阻止更精确任务。
- 完成任务只接受 Trip.com allowlist 上无凭据 HTTPS URL，保持 URL 原文不改写，并在事务中创建 canonical Affiliate Asset、标记 COMPLETED、记录完成时间和 Asset ID；重试不会重复创建。
- SEARCH_BOX 复用 `normalizeEmbedConfig` 的结构化安全边界；PROMOTION 强制 `valid_from` 与 `valid_until`。
- 新增状态/类别/Scope 筛选、复制 `trip_sub1`/Source URL、URL 回填、跳过、CSV/JSON 导出、dry-run 预检和逐行导入 UI/API。
- 新增 `test/affiliate-queue.test.mjs` 的 32 个专项用例和 Migration 33 升级测试，覆盖稳定键、冲突、去重、exact/broad fallback、门槛、完成幂等、安全校验、Search Box、Promotion、CSV/JSON、部分失败、保护、筛选和 API 鉴权。
- 架构边界未改变：Research、Claim、Knowledge、Topic ranking、Brief、Research Draft 和 QA 不读取 Queue；新 Asset 复用既有 Commercial Composer 与 Event/Performance。
- 验收：`npm run check` 通过；`npm test` 162/162 通过；`npm run release:check` 39 项强制检查全部通过、0 失败；本地真实浏览器完成空状态、Seed、筛选、手工 URL 回填、Task 完成、Asset 生成和待办数刷新验证。
- 用户已在实现过程中更新授权：完工并通过验收后执行 git commit、push 与部署。
- 实现 commit：`3d63a08eb794a10a40ba1a52294db5b89deacd3d`，已推送到 `origin/main`。
- Artifact Registry `engine:1.16.0`：`sha256:c142cf12b66c3559ccaea39a7af9cd7aad48590289ca9efd7f62d03dcb94dad3`，Cloud Build ID `69d1ff56-3078-4610-9d32-9ebe3c12c57d`。
- GCE `solo-to-china-engine` 已切换至 `1.16.0`；`https://engine.solotochina.com/api/health` 返回 HTTP 200、`ok: true`、version `1.16.0`、strategy `1.5`、Frontend Contract `canCompose: true`；`/api/ready` 返回 HTTP 200、`ready: true`、database `ready`。
- 生产显式 Seed 已执行一次：创建 4 个任务、0 个重复、0 个因现有 Asset 被抑制；当前 4 个任务均为 `READY_FOR_MANUAL`，未生成任何额外城市、路线或实体组合。
- 本轮回滚点：启动脚本替换容器前生成的持久卷 SQLite 校验备份；上一稳定镜像 `engine:1.15.2`。

## Trip.com Affiliate Link builder 对应关系修正（2026-09-08，待生产部署）

- 根据用户提供的真实 Trip.com Affiliate Link builder 截图复核：目的地级 ATTRACTION/TOUR_ACTIVITY 不应打开 Custom Link，而应使用 `Attractions & Tours Page` 并填写 `Select a destination*`；Custom Link 保留给具体实体、门票、Tour 或已知精确 URL。
- 新增工具映射：`ATTRACTIONS_TOURS`、`FLIGHT_HOTEL`、`CAR_RENTALS`、`AIRPORT_TRANSFERS`、`HOMEPAGE`；新增 `trip_pickup_location`，并对 Hotels、Flights、Trains、Flight + Hotel、Attractions & Tours、Car Rentals 的后台必填字段执行生成前校验。
- Migration 34 会把未完成的目的地级 Attraction/Tour Custom Link 任务升级为 `ATTRACTIONS_TOURS`，保留已完成/已跳过任务的工具和既有 Asset，不改变 `task_key` 或 `trip_sub1`。
- Seed 同步现在会刷新未完成 Seed 的操作指引，同时保持任务身份和 Sub ID 不变；生产部署后会重新执行幂等 Seed，核对北京/上海任务的工具类型。
- 修正版本为 `1.16.1`；本地专项对应关系与迁移测试 36/36 通过，全量测试 166/166 通过，`npm run check` 与 `npm run release:check`（39 项强制检查）均通过，0 失败。
