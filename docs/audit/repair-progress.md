# SoloToChina 全量修复进度

## 人工异常减噪与决策说明（2026-09-09）

- 根据生产截图复现三类误报：酒店“一线江景”与“river and urban cityscape view”、洪崖洞夜间灯光的概括值与详细值、管家柜“只需要……0 打扰”与 contactless 标准化结果。
- 同一规范化事实键和兼容 Scope 下的正向 view、scenery、appearance、illumination、lighting、vegetation、amenity 描述统一判为 ENRICHMENT；正负相反、营业时间、价格、预约要求等真正互斥事实仍进入冲突审核。
- 提取检查不再把程序性便利表达“只需/只需要”当作唯一性限制；contactless 被识别为已保留“0 打扰/不打扰”语义。“only the east gate”这类真实限制丢失仍会拦截。
- Knowledge 重建会删除旧规则制造、而新规则已判兼容的 pending 误报；管理员已经关闭的误报决定继续保留。
- 人工介入卡片全面改为中文大白话：明确展示原文、系统整理结果、为什么被拦截，并逐项说明“重新提取 / 关闭误报 / 选择最终事实”会产生什么结果。
- 最终事实候选值统一标注“采用这条作为最终事实”，并明确保存后用于后续选题和写作，原始来源与证据不会删除。
- 验收：定向规则与异常界面回归 24/24 通过；npm run check 通过；npm test 206/206 通过；npm run release:check 的 39 项强制检查全部通过、0 失败。

## Claim / Knowledge 语义冲突误报修复（2026-09-09）

- 生产数据核查确认两条异常均为误报：洪崖洞夜间灯光的 `true` 与详细灯光描述表达同一正向特征；黄葛古道植被的中英文值来自同一句原始证据，语义等价。
- 版本 `1.17.6` 将未显式标型的 `feature` / `features_*` 归为上下文型 Claim；同一证据的跨语言特征值识别为复述，正向布尔特征与详细描述识别为补充，不再按单值硬事实制造冲突。
- Scope 比较统一规范化大小写；同等支持度下优先选择信息量更高的描述值，而不是 `true` / `false` 简写。
- 管理员选择“不是冲突（关闭误报）”后，后续 Knowledge 重建会保留该判断并按兼容关系聚合，不再反复出现同一异常。
- 回归验收：Claim 关系与异常队列组合测试 19/19 通过；`npm run check` 通过；加入多分段终态、人工覆盖决策和来源队列状态回归后，`npm test` 203/203 通过；`npm run release:check` 39 项强制检查通过、0 失败。

## 来源覆盖审计提前报错与人工闭环修复（2026-09-09）

- 生产只读核查确认来源 `src_896668b0096c41da8f43bba34095b69e` 共 40 个分段：9 个通过、1 个需要人工检查、30 个仍待处理。旧逻辑在首个分段完成定向重试后立刻把整个来源设为异常，造成“尚未处理完却已失败”的错误状态。
- 来源现在只有在全部分段均已通过或进入人工检查终态后才会显示覆盖异常；只要仍有待提取、待审计或待重试分段，就保持“处理中”，旧版提前写入的覆盖错误也会在后续审计时自动清除。
- 来源详情为单个覆盖异常分段提供“重试此分段”和“确认无需信息主张”两项人工操作。确认操作会记录操作员、时间和备注，只解除经人工确认的非实质内容；其余原始证据、分段和提取结果不删除。
- `Manual Review`、`Extracted`、定向重试状态及旧英文覆盖错误均已汉化。
- 新增多分段顺序回归，验证早期人工检查不会提前失败整个来源，全部分段终态后才进入异常，人工确认后才允许最终汇总。

## 来源处理队列可观测性与序号（2026-09-09）

- 来源 API 现在将来源直属任务和分段任务汇总到对应笔记，显示正在执行、可执行排队、模型限流/退避冷却和失败四种状态。
- 每条来源可查看当前或下一处理阶段、正在运行任务数、剩余排队任务数、来源级排队位置、前方笔记数、尝试次数、冷却截止时间及最近的提供商错误；冷却中的 Vertex 429 不再表现为不明原因卡死。
- 来源级顺序沿用 worker 的完成阶段优先级与任务创建顺序；队列变化时页面每 5 秒自动刷新。
- 桌面和手机来源标题前均加入当前列表连续序号，数据库身份、采集时间和来源排序规则不变。
- 新增运行中、可执行排队、冷却等待及列表序号回归测试。
- 验收：`npm run check` 通过；`npm test` 203/203 通过；`npm run release:check` 39 项强制检查通过、0 失败。

## 生产提取队列完成阶段饥饿修复（2026-09-09）

- 生产诊断确认队列仍在处理，但纯 FIFO 让 742 个 extract_segment_claims 排在 173 个 audit_segment_coverage 前；当时已有 230 个分段提取成功，而只有 14 个覆盖审计完成。Claim 只在最终来源汇总后写入，因此来源列表长期显示处理中 / 0。
- 版本 1.17.5 将最终来源汇总、定向补漏提取、分段覆盖审计设为完成链路优先级，同时继续严格遵守任务的 available_at、Vertex 429 共享冷却和自动并发退让，不通过突发调用换取表面速度。
- 来源列表现在直接显示“提取 x/y · 审计 x/y”；即使尚未完成最终 Claim 汇总，操作员也能看到真实处理进度。
- 新增回归测试，验证较新的完成阶段任务可越过旧提取积压，且尚在冷却期的高优先级任务不会提前执行。
- 验收：`npm run check` 通过；`npm test` 198/198 通过；`npm run release:check` 39 项强制检查通过、0 失败。
- 生产部署：提交 `d1e913b` 已推送至 `origin/main`；Cloud Build `53c807d3-97bc-4194-9a7b-aff2caada90c` 发布 `engine:1.17.5`，镜像摘要为 `sha256:3039af0edc711a82e6a75e0b5798b38e3474e4ccaded0f8bfee7b75f9633f4fe`。GCE `solo-to-china-engine` 返回 health version `1.17.5`、ready/database `ready`。
- 生产效果：活动队列由 916 降至 830；覆盖审计由部署前 14 个增至 109 个，最终来源汇总成功 4 个，4 个来源已生成合计 266 条 Claim，异常来源为 0。剩余任务继续按冷却和自适应并发规则处理。

更新时间：2026-09-08

本文件记录 `docs/audit/handoff/01_问题清单.txt` 与 `02_完整修复提示词.txt` 对应问题的实施、验证和部署状态。附件中的提示词仅作为需求输入；实际变更以当前代码、测试和发布结果为准。

## 当前结论

- A01–A19、B01–B10 的代码修复与优化全部完成。
- CMS 生产版本为 `1.17.2`，数据库迁移为 1–35，内容生成策略版本为 `1.5`。
- 前端 Parent Theme 版本为 `0.28.0`，Component Registry 兼容版本为 `1.1.0`，Content Contract 版本为 `2.1.0`。
- 双仓库真实契约交叉验证、CMS 全量测试与 release check、WordPress Playground PHP 8.3 运行验证、前端发布包检查均已通过。
- CMS 与前端代码已经提交并推送；WordPress Parent Theme `0.28.0` 和 CMS `1.16.1` 均已部署并通过生产健康检查与契约同步验收。

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

## Trip.com Affiliate Link builder 对应关系修正（2026-09-08，生产已发布）

- 根据用户提供的真实 Trip.com Affiliate Link builder 截图复核：目的地级 ATTRACTION/TOUR_ACTIVITY 不应打开 Custom Link，而应使用 `Attractions & Tours Page` 并填写 `Select a destination*`；Custom Link 保留给具体实体、门票、Tour 或已知精确 URL。
- 新增工具映射：`ATTRACTIONS_TOURS`、`FLIGHT_HOTEL`、`CAR_RENTALS`、`AIRPORT_TRANSFERS`、`HOMEPAGE`；新增 `trip_pickup_location`，并对 Hotels、Flights、Trains、Flight + Hotel、Attractions & Tours、Car Rentals 的后台必填字段执行生成前校验。
- Migration 34 会把未完成的目的地级 Attraction/Tour Custom Link 任务升级为 `ATTRACTIONS_TOURS`，保留已完成/已跳过任务的工具和既有 Asset，不改变 `task_key` 或 `trip_sub1`。
- Seed 同步现在会刷新未完成 Seed 的操作指引，同时保持任务身份和 Sub ID 不变；生产部署后会重新执行幂等 Seed，核对北京/上海任务的工具类型。
- 修正版本为 `1.16.1`；本地专项对应关系与迁移测试 36/36 通过，全量测试 166/166 通过，`npm run check` 与 `npm run release:check`（39 项强制检查）均通过，0 失败。
- 修正 commit：`cfe5a5c`，已推送到 `origin/main`。
- Artifact Registry `engine:1.16.1`：`sha256:613ad3e129a1b5aaed6c383595e80f1062944ace0b365caf883def5606c0cfd5`，Cloud Build ID `5897af0e-6fcf-47c8-9b3a-daec834d3ffa`。
- GCE `solo-to-china-engine` 已切换至 `1.16.1`；`/api/health` 返回 HTTP 200、Frontend Contract `healthy` 且 `canCompose: true`；`/api/ready` 返回 `ready: true`、database `ready`。
- 生产幂等 Seed 验收：0 创建、0 更新、4 个既有任务；Hotels in Beijing/Shanghai 均为 `HOTELS`，Tickets and attractions in Beijing/Shanghai 均为 `ATTRACTIONS_TOURS`，Destination 与既有 `trip_sub1` 保持不变。
- 本轮回滚点：启动脚本替换容器前生成的持久卷 SQLite 校验备份；上一稳定镜像 `engine:1.16.0`。

## Xiaohongshu Favorites Sync vNext（2026-09-08）

- 真实采集修复：Chrome 实测确认专辑卡片同时包含隐藏无访问参数链接与可见详情链接；Extension 现在使用可见卡片的临时 `xsec` 导航地址打开详情，仅将去令牌 canonical identity 发送/保存到 CMS，并在任务终态清除临时地址。旧版未完成队列会回到专辑重新发现，临时完整度不足自动重试且不会阻断整批。
- Scope 边界修正：个人收藏页的 `subTab=board` 是专辑卡片总览，不再被误判为可同步 Scope；总览页会提示切换到“笔记”同步全部收藏，或进入具体 `/board/{id}` 专辑只同步该专辑，并在选择前禁用批量同步按钮。
- Extension 交互优化：弹窗、按钮、统计项和全部连接参数已汉化；状态栏会实时显示收藏夹已识别、扫描、采集、重试、暂停、恢复、完成和错误指引，并每秒刷新进度。
- 真实页面兼容修复：支持小红书新版 `/board/{id}` 收藏夹路由，弹窗会直接读取当前活动标签并显示 Scope；首页和单篇笔记不再被误判为收藏夹。
- 最终加固：历史全量同步必须连续两次确认收藏列表到底，避免懒加载短暂空窗导致提前结束；对应核心专项测试、全量测试与发布门禁均已复验通过。
- 状态：实现与专项自动化验收已完成，应用/Extension 版本更新为 `1.17.2`，数据库迁移更新为 `35`，Content Strategy 保持 `1.5`。
- 已完成 MV3 background service worker、持久化 Scope/checkpoint/queue、批量 identity、连续已知安全停止、无 Session 总量上限的完整历史流式回填、4–12 自适应浏览器并发、标签复用、暂停/恢复/取消/重启恢复和可选 Auto Sync。
- 已保留 Manual Save；登录墙和验证页只会暂停，不读取或上传账号、密码、Cookie、LocalStorage Token，也不绕过验证码或调用未授权私有 API。
- 已完成零损失链路：完整 raw text/DOM、全部图片和视频、完整内容 hash、Capture Version、completeness manifest、大 JSON 分片校验、AI 图片分批、多视频处理、大图原始 provenance + derivative、模型输出超限自动再分段，partial Source 禁止进入 extraction。
- Migration 35 已加入 Source/Asset rights/provenance/completeness、immutable capture_versions、Source Version-aware segments、XHS identity 唯一约束、active Job dedupe key 和 favorites_sync_runs 聚合遥测。
- Favorites Sync 与 Extension Manual Save 统一为 owner-confirmed commercial-use/editing/redistribution/publishable 权利语义，且保留完整 provenance；Recommendation 人工批准边界没有改变。
- 已更新 README、Architecture、Manual Source Ingestion、Research Boundary、Operations、Content Strategy interpretation/changelog、Handoff、`.env.example`、Changelog、release check 和审计记录。
- 最终验收：`npm run check` 通过；`npm test` 194/194 通过；`npm run release:check` 39 项强制检查通过、0 失败，结果为 `READY FOR EXTENSION INTEGRATION`。Release gate 同时通过真实 sibling Frontend Contract、迁移 1–35、SQLite integrity、隔离 HTTP/API/UI smoke 与 Extension 静态清单/资产验证。
- 自动化验收明确未冒充真实账号测试：真实 Chrome Load Unpacked 与已登录小红书收藏页采集仍需在用户 Chrome profile 中执行；Kimi、WordPress、Search Console 外部服务未在隔离 gate 中调用。

- Production failure diagnosis: extension 1.17.0 received HTTP 404 from the 1.16.1 Engine at /api/captures/identity-check, which the old client mislabeled as incomplete note content. Start and resume now preflight the Favorites Sync API, distinguish backend version, authentication, availability, and content errors, and clear stale errors before recovery.

- Production deployment: commit 4b547fe was pushed to origin/main; Cloud Build 59794bf1-fc3a-4f70-acb1-046669525756 published engine:1.17.0 at sha256:ef0e2e67cb2602bdce94ca671a4cf85fbdd356a170f5c03e3887a15b47e38254. GCE solo-to-china-engine now reports health version 1.17.0 and ready database; the capture identity route returns 401 without a token and the capture-only host keeps /api/dashboard at 404. The startup deployment created a verified SQLite backup before replacement; rollback image is engine:1.16.1.

- Xiaohongshu verification recovery: production run 928db209-ac11-49b8-87f6-db9ab04034ab captured 51 of 74 notes, but 23 verification-redirected tabs were misclassified as terminal SELECTOR_MISMATCH failures and the run was incorrectly completed. Version 1.17.1 pauses on interrupted navigation, reduces concurrency to one, retains failed work, blocks completion while failures remain, and reopens the existing 1.17.0 partial run without duplicating its 51 successful captures. Validation passed 191/191 tests, check, and all 39 mandatory release gates.
- Production deployment: commit f7cda1d was pushed to origin/main; Cloud Build e1a239ac-5931-4d5e-94b4-f67cb6f7bf8c published engine:1.17.1 at sha256:89eff92b53057f1883fa1a4df686688eb048e5d73c5bab5cdfa91eac02f469a7. GCE solo-to-china-engine reports health version 1.17.1 and ready database. The previous production rollback image is engine:1.17.0.

- Vertex/XHS extraction recovery: version 1.17.2 downloads owner-authorized Xiaohongshu CDN video evidence through an HTTPS hostname allowlist with redirect, MIME, byte-limit, and timeout enforcement. Vertex 429 quota errors remain durably queued beyond the normal attempt limit, use one-minute-to-one-hour exponential backoff, and apply a shared cooldown to queued AI work.
- Validation: `npm test` passed 194/194; `npm run check` passed; `npm run release:check` passed all 39 mandatory checks with zero failures. The focused Vertex and operations suite passed 17/17.
- Production deployment: commit `0d211f1` was pushed to `origin/main`; Cloud Build `11c73f06-760f-4712-aaca-e768e5558eb3` published `engine:1.17.2` at `sha256:102d5c52b4f3142de1c94916924530046c4d09414a29e7c3c08ff663eef31ddd`. GCE `solo-to-china-engine` reports health version `1.17.2`, application ready, and database ready; the startup deployment created a verified SQLite backup before replacement. The previous production rollback image is `engine:1.17.1`.
- Production incident acceptance: both `extract_segment_claims` blockers (`segment_ef3cce445ea45388cfcb82e5` and `segment_94ed3853f3c4cf3ca3c7a5fe`) were retried after deployment. The operational exception queue fell from two items to zero; quota-constrained work remains automatically queued instead of requiring manual retry. Runtime configuration and the Vertex request path both use Google Cloud project `project-4bcb9146-c37b-43b0-b11` in location `global`.

## CMS 子页面汉化（2026-09-09）

- 已完成来源详情、文章草稿详情、配置说明、前端能力契约、目的地知识地图、实体与信息主张审核、商品与联盟建链、维护页面及登录/密码页面的固定界面文本汉化；模型生成内容、来源原文和技术配置键保持原值。
- 公共状态、类别、范围、耗时及日期显示已统一为中文；弹窗无障碍关闭文案同步汉化。
- 本地浏览器已核验来源详情弹窗的中文控件与布局；英文旧控件扫描为零。
- 验收：`npm run check` 通过；`npm test` 196/196 通过；`npm run release:check` 39 项强制检查通过、0 失败；新增中文界面回归测试 2/2 通过。
- 本地提交：`4e05b1e`（版本 `1.17.3`）。自动审批审查拒绝直接推送默认分支，因此远端推送与生产部署等待用户再次明确授权；当前生产仍为 `1.17.2`。

## Favorites Sync 收尾卡死修复（2026-09-09）

- 已定位“重试失败项”长期停留在“正在保存同步结果和检查点”为后台请求无超时与终态落盘顺序问题：标签页清理或遥测请求卡住时，会话仍保持 `running + completed`。
- 版本 `1.17.4` 将完成状态与收藏夹检查点在清理前原子写入 Chrome 本地存储；CMS 请求增加 45 秒超时，媒体请求增加 30 秒超时，超时任务保留在可恢复队列。
- Extension 重启时会自动收敛遗留的 `running + completed` 会话；仍有失败项时进入 `paused_failed_items`，无失败项时完成检查点提交，不会丢失已采集内容。
- 验收：Favorites Sync 专项测试 15/15 通过；`npm run check` 通过；`npm test` 197/197 通过；`npm run release:check` 39 项强制检查通过、0 失败。
