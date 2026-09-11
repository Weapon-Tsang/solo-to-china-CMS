# SoloToChina CMS 2.0 大重构与生产部署报告

日期：2026-09-11  
分支：`codex/audit-v1.3`  
生产运行提交：`34ca0d8`（本报告的记录提交随后产生）  
版本：应用/扩展 `2.0.0`、内容策略 `3.0`、数据库 Schema `57`

## 1. 范围、基线与安全边界

本次从生产基线 `8de53ed`、应用 `1.18.3`、策略 `2.1`、Schema `56` 升级。实施范围来自 `SoloToChina_CMS_Major_Refactor_Codex_Prompt.txt` 的 A–M 模块；文档中的提示被当作实现规格，用户请求仍是完成开发、提交、推送和部署。未读取、修改或提交工作区内用户自有的 `.tar`，并通过 `.gitignore` 将其排除在 Cloud Build 上下文之外。

## 2. 小红书原始媒体耐久化

新增经 SHA-256、MIME、尺寸和文件签名校验的图片/视频分块上传，原件写入持久卷 `source-uploads/media`；原件与衍生图分别记录。来源状态现在分离媒体发现、原件耐久化和 AI 可读性。小红书来源只有在全部已发现媒体达到 `ORIGINAL_STORED` 后才进入抽取；旧 `saved_unknown` 不再被误认作原件。

## 3. 增量、修复与全量同步

浏览器扩展支持 `incremental`、`repair`、`full` 三种收藏同步模式。重复采集不会制造新来源版本；若补回缺失原件，会取消重复修复任务并只恢复一次受阻抽取。服务端可恢复仍有效的远端原件，失效资源进入 browser repair manifest，要求操作者在已授权、已打开的原笔记中修复。

## 4. Experience 语义层

Claims 后新增独立、可追溯的 Experience Blocks，保存路线顺序、条件、权衡、提醒、替代方案和游客决策逻辑。每个 Block 必须引用现有 segment，并至少引用 Claim 或 evidence span；无依据内容被丢弃，最多持久化 20 个 Block，Claims 不被替换或伪装成叙事经验。

## 5. 写作输入与生产流水线

生产顺序改为 `Editorial Assembly → Narrative Plan → Writing Packet → Draft`。Writing Packet 是本次文章的可读、最小证据包，而不是数据库行转储；只带入已选事实、Experience、来源和编辑约束。`SOURCE_ADAPTATION`、`TOPIC_FEATURE`、`MULTI_SOURCE_SYNTHESIS` 保持并行，同一来源可有多个独立方向。

## 6. 编辑 QA

新增并固化 `DATABASE_DUMP`、`GENERIC_AI_TRANSITIONS`、`REPETITIVE_EXPLANATION`、`UNIFORM_SECTION_RHYTHM`、`EXCESSIVE_HEDGING`、`NO_TRAVELER_DECISION`、`NO_CAUSAL_FLOW`、`FAKE_FIRST_PERSON`。篇幅是软指导，短但完整的文章可通过；FAQ 可选；正文 QA 与媒体/页面交付 QA 独立，媒体故障不会重写已经通过的正文。

## 7. 建议与 SEO 生命周期

建议页只列可执行内容机会，来源诊断留在来源详情。每个方向可独立批准、暂缓或忽略，并支持逐项可回滚的批量决定。知识变化在至少两个独立来源家族支持时可创建多来源机会；发布库存影响会产生更新建议，绝不自动发布。SEO 动作明确为 `NEW / UPDATE / EXPAND / MERGE / SKIP`。

## 8. 事件驱动的知识就绪

来源抽取、Claims/Experience 完成、知识重建和发布库存变化通过幂等事件/任务推进。知识变化只刷新受影响的目的地与机会，不以全库轮询替代业务事件。来源、Claim、Experience、机会和发布影响各自保留生命周期与来源引用。

## 9. 失败学习与回滚

普通内容生产终态失败会生成 Failure Lesson，删除或失效仅属于该生产尝试的瞬态产物，保留来源、Claims、Knowledge、Experience、人工决定和研究资产，并将机会退回 `recommended_again`；再次生产必须重新批准。系统级故障仍进入设置/运维，不会被误当作内容质量失败。

## 10. 编辑学习资产

新增 Editorial Lessons 与 Golden Articles。人工反馈可沉淀为显式原则；Golden Article 保存标题和快照，即使相关草稿以后清理也不会失去已确认的编辑学习。失败教训是写作约束，不会被直接拼进文章。

## 11. 媒体业务规则

真实地点、路线、菜单和现场信息优先使用已授权且已持久化的来源原件；衍生图和翻译图不能替代原件证明。地图/信息图按确定数据生成，生成式图片只作为非纪实插画。媒体缺口进入恢复流程，不能靠合成图或过期 CDN URL 假装完成。

## 12. 公平队列与生产回填

优先级为：交互、来源完成、审计和关键知识任务优先；Experience、重算与已批准内容居中；历史回填最低。所有回填先 dry-run，再执行并写审计记录。

- 媒体预检 `media_backfill_4326fa1ba34b456d9e2071e8173ed5b3`；执行 `media_backfill_1dc6783c026b4275b16c372619e7b210` 已完成：扫描 1,311，服务器恢复原件 362，需要浏览器修复 949，不可用 0。
- Experience 预检 `backfill_a42bc6e3c111433bb6d300a18b774043`；执行 `backfill_9a4804aeb70d45e8904a82d0d5d627b0`：74 个来源入队，在线验证时已成功 5、待处理 69、终态失败 0。
- 建议预检 `backfill_ec9cfc775bb2435aa484f71ff30c98f1`；执行 `backfill_2f4dcb413226435c94f765def7a463d5` 已完成：7 个目的地，机会从 270 更新到 610，创建或刷新 340。
- 失败产物预检 `backfill_e993b965c36a43efb8832f989f1a4ce2`；执行 `backfill_c2b5572ca0ff425eb518c657464d4b94` 已完成：15/15 个无 WordPress 文章的失败草稿安全回滚。

上线期间发现启动补建与手工 Experience 回填曾使用不同去重键；`faff791` 统一键并审计性终止 74 条尚未执行的重复任务。随后确认 Vertex 对完整 Schema 的 `maxItems` 组合返回 `400 INVALID_ARGUMENT`；`34ca0d8` 将 20 条上限移到持久化边界。真实生产随后出现首批成功，项目配额压力 `429` 保持 queued 并指数退避，不会转成内容失败。

## 13. 后台 IA、迁移、测试与文档

顶级菜单固定为六个：来源、建议、内容、知识库、商品、设置。同步、健康、失败教训、Golden Articles、回填和高级维护归入设置；来源列表显示平台/作者、采集、完整性、抽取、媒体耐久化和 Experience 状态。Schema 57 只迁移结构和状态，不在迁移事务中隐式启动付费回填。

最终 `npm run release:check` 通过 49 项强制检查、0 失败；包含 1,198 项单元/集成测试、Vite 生产构建、语法/服务边界、固定前端 SHA 契约、全新/升级迁移、数据库完整性、备份恢复演练、隔离 API/UI 与扩展清单检查。警告 5 项、明确未测试 5 项。

## 14. 提交、构建、部署与线上验证

已推送运行提交：`481f1bf`（CMS 生产生命周期重构）、`6c3f3e4`（运行镜像包含回填 CLI）、`faff791`（Experience 回填去重）、`34ca0d8`（Vertex Experience Schema 兼容）。最终 Cloud Build `01d51701-551e-4dfc-8251-f733d19b36b8` 为 `SUCCESS`；镜像 `asia-east1-docker.pkg.dev/project-4bcb9146-c37b-43b0-b11/solo-to-china/engine:2.0.0`，摘要 `sha256:297208e457858e247e6b884ea5a2567182ea0768ad9de1fe92f3de5fae03218d`。

生产目标仍为 GCE `solo-to-china-engine`、`asia-east1-b`、项目 `project-4bcb9146-c37b-43b0-b11` 和原持久卷。最终串口记录在 `07:32:44Z` 创建经验证的数据库/内容快照，拉取上述摘要，并在 `07:33:07Z` 报告部署成功。`engine.solotochina.com` 健康与就绪均为 HTTP 200、应用 `2.0.0`、策略 `3.0`、数据库 ready、前端契约 healthy；`capture.solotochina.com/api/health` 为 200，`/api/dashboard` 为 404。未扩大 IAM；既有 Guest Agent Cloud Logging 权限警告不影响应用。

未声称验证：真实 Chrome Load Unpacked/真实小红书授权修复同步、生产 WordPress 最终渲染与爬虫结果、Search Console、排名、索引、流量或 AI 引用。部署与回填没有自动发布 WordPress 内容；949 个历史原件缺口必须由操作者合法打开原笔记后运行 repair sync。
