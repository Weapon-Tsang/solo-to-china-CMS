# CMS 采集与生产可靠性实施验收 — 2026-09-12

本报告对应用户附件 S0–S5 / T01–T18，记录本次实际本地代码、测试及测量。主要缺陷已修复并通过离线门禁；这不是生产上线记录，也不代表真实 Chrome MV3、小红书、模型质量/账单或生产发布已经验收。

## S0：实际基线

- HEAD `2395fe4ed68f7414d777d0156770af76e858eb1b`，分支 `codex/audit-v1.3`；开始时工作区干净。没有回退到附件中的历史 main，没有覆盖用户未提交修改。
- Node `v24.14.0`，满足 `>=24`。起点 App/Extension `2.0.5`、Strategy `3.0`、schema `59`。未发现适用 AGENTS.md；已完整读取附件、README、ARCHITECTURE、HANDOFF、当前策略、失败生命周期、依赖及 CI/发布门禁。
- `npm ci --ignore-scripts` 成功。为可控 DOM 和浏览器暂存测试加入开发依赖 `linkedom`、`fake-indexeddb`，锁文件同步。
- 原命令 `node --test` 会发现被 Git 忽略的 `output/deployment.../source/test` 历史副本，最初1231/1231的结果不能代表当前仓库测试数量。现将 `npm test` 限定为 `node --test "test/**/*.test.mjs"`，没有跳过当前仓库测试。
- 在隔离 detached worktree 按同一测试范围重跑原 HEAD：**437/437通过、0失败、0跳过**，Node报告23588.5207 ms。复用当前依赖目录；工作树及目录连接随后移除。脚本 `scripts/check-baseline-reliability.mjs`，结果见[基线 JSON](CMS_BASELINE_TESTS_2026-09-12.json)。不同测试数的套件耗时差不作为性能收益。
- 数据库写入、故障注入和清理演练仅针对隔离测试目录。未修改真实原始素材、另一个前端仓库、远程 main、生产数据库或 WordPress。本地实现未提交、未部署。

## T01–T18 实施映射

“本地通过”只表示相关离线契约/回归通过；“已有实现”表示保留有效机制并验证。测试名称均位于 `test/<名称>.test.mjs`。

| 项目 | 核对结论与实际改动 | 实际代码 | 测试及状态 |
|---|---|---|---|
| T01 类型契约 | 修复上传前缺kind；采集与合并边界双重规范化；字节决定MIME，拒绝HTML/声明冲突；视频不进入Canvas。 | `extension/media-contract.js`、`page-extractor.js`、`background.js`；`src/media-storage.mjs`、`capture-media-upload.mjs` | `reliability-transport/media`：旧视频无kind、混合上传/来源入库、错误MIME、HTML；合法PNG/WebM另经Chromium解码。**本地通过**。 |
| T02 响应生命周期 | 修复headers返回即清超时。作用域覆盖读完JSON/二进制/错误正文；总截止、无进展、字节上限、取消分别编码；暂停/取消/失去lease中止请求并释放槽位。 | `extension/transport.js`、`background.js`、`sync-core.js` | `reliability-transport`本地HTTP慢头/慢正文/停滞/POST取消/超限/槽位恢复；`reliability-budgets`等待取消。**本地通过**。 |
| T03 选定证据 | 修复历史候选误入必写值、整章借值。Packet冻结精确claim/source/版本/值/条件；按最小节点验证，历史/条件并列有显式角色；移除快照内原始历史JSON旁路。 | `src/evidence-validator.mjs`、`repository.mjs`、`ai/content-engine.mjs`；migration62/63 | `evidence-validator`、`major-refactor`、`reliability-budgets`：当前60/历史40、错误块、年份、人群交换、单位、否定、伪造引用、空Packet。**本地通过**，保留独立语义QA。 |
| T04 Worker恢复 | 自动恢复、永久坏笔记、完成但有失败、checkpoint和所有权已有。保留并回归；补请求取消、暂存恢复，并修复真实异步IDB暴露的空worker反复启动导致事件循环饥饿。 | `extension/background.js`、`sync-core.js`；原popup消费者 | `favorites-sync`、`extension-background-recovery`、`extension-popup-progress`。**已有机制及补缺通过**；真实MV3未验收。 |
| T05 完整性 | 未知媒体总数保留unknown；观察DOM/媒体事件并设硬截止；只海报/blob视频保持缺口。列表按稳定身份推进，明确结束或多轮无身份/加载进展才结束。清理评论、推荐、导航和控件。 | `extension/page-extractor.js`；`src/adapters/xiaohongshu.mjs` | `reliability-dom`：4200ms延迟图、宽高未就绪、未知轮播、海报、普通笔记、虚拟卡片和结束标记；旧输入标legacy_unverified。**受控DOM通过**；真实站点仍待验收。 |
| T06 媒体续传 | 先存正文/清单，再媒体、再确认完整；v2持久uploadId/token/缺块/回执，complete可重取；IDB二进制/快照；旧完整且原件齐全版本不被partial覆盖；清理有预览。 | `extension/media-journal.js`、`background.js`；`src/capture-media-upload.mjs`、`source-media-store.mjs`、`repository.mjs`、`server.mjs` | `reliability-media/budgets`、`capture-upload`、`favorites-api`。`reliability-capture-versions`补验完整重采、同一文件复用、旧文章/证据引用和失败重采；migration64按版本保存资产/文件/分段，提供历史读取。**本地通过**。 |
| T07 传输/池 | 持续补位和全局池已有。去掉普通图重复base64；单来源媒体最多4个、独立全局额度、加权字节预算；小任务可有界绕过大预约。衍生图按原件hash/参数/转换器版本缓存。 | `extension/background.js`、`sync-core.js`、`derivative-cache.js` | `reliability-media`断言实际字节和JSON；`reliability-budgets`公平性/缩额/取消/缓存重启淘汰；原pool测试。**本地通过**；Chrome全进程解码峰值未证明，大视频流式IDB未实现。 |
| T08 异步I/O | 合并/哈希/校验为有界流、两个finalizer槽位；在写入流校验，避免写后再读整文件；原子链接、持久回执后关联；可信记录+stat复用，变化后异步校验。 | `src/capture-media-upload.mjs`、`media-storage.mjs`、`source-media-store.mjs` | 媒体/网络回归及真实混合负载benchmark。**已实现并测量**：API延迟改善，合并耗时有回退。inline旧图片仍是有上限同步兼容路径。 |
| T09 依赖/提交 | 补Narrative/Packet、实际adapter prompt/schema/config依赖；稳定语义hash、输出hash检查；命中补下游。主要单次模型阶段事务存产物/enqueue/finish；实体解析所有页统一提交，不让本轮别名更新污染后页输入；异步返回检查lease和当前输入。 | `src/pipeline-contract.mjs`、`pipeline.mjs`、`repository.mjs`、`ai/kimi.mjs`、`ai/content-engine.mjs` | `pipeline-artifacts`、`reliability-pipeline`、`major-refactor`、`vertex-batch-pipeline`，305条claim的跨页运行及迟到更新拒绝通过。`reliability-step-recovery`补齐分页模型回执、组合补提取/审核、页面/商业/发布包/投递回执事务及实际输入校验。第1/2页落盘、保存/enqueue边界真实kill恢复通过。**本地通过**；不宣称提供方与数据库原子提交。 |
| T10 合并更新 | 已有enqueue去重和选定事实范围。补running任务dirty/claimed revision：十次变化合并成同一任务一次后续重跑；来源/媒体/语义复用分别判断。 | `src/db.mjs` migration60；`repository.mjs`、`pipeline.mjs` | `reliability-pipeline`、`pipeline-artifacts`、`operations`、`source-preflight`。**本地通过**。采用受控合并，未把所有知识重建改为逐事实SQL；未生产回填。 |
| T11 最小恢复 | 系统/媒体故障原已分离。改掉普通终止失败删除昂贵后代：保留批准、Packet/正文/关联，归档失败快照并给repairStage；明确范围失效才重新推荐。失败学习限定当前机会和retry-safe规则。 | `src/repository.mjs`、`db.mjs` migration61；失败生命周期文档 | `major-refactor`、`content-recovery`、`wordpress`。**本地通过**；修复预算与发布保护保留，没有新增内部审批。 |
| T12 远程边界 | 修复直接fetch跟随重定向。HTTPS443、全部DNS审查、连接lookup固定、实际socket对照、逐跳重定向/超时；拒绝私网/映射地址；路径拒绝越界/junction，v2需token。 | `src/safe-media-http.mjs`、`media-storage.mjs`、`source-media-store.mjs`；上传API | `reliability-network/media`测DNS/连接变化、跳转、超限、串会话和junction。**受控本地通过**；TLS事件为注入夹具，外部CDN未实测，未探测真实内网。 |
| T13 实体/逐图 | 撤销合并和图片来源层已有。加强正向身份依据，高置信度+相近坐标不再充分；保留related/unknown，明确双语别名可归一。逐图只用自身附近上下文。 | `src/entity-resolution.mjs`、`repository.mjs`；`extension/page-extractor.js` | `entity-resolution`、`reliability-pipeline`、`visual-planning`、`block-provenance`。**已有机制及增强通过**；真实复杂图片归属未人工评审。 |
| T14 复杂度 | 完整分段、逐媒体记录、局部遗漏修复已有。新增可观察profile和可执行fragment分支：仍做Claims/Coverage/Experience，碎片不排整篇蓝图/诊断，其他保留完整路径。 | `src/source-processing-profile.mjs`、`config.mjs`、`pipeline.mjs` | `reliability-pipeline`、`source-preflight`、`second-pass-semantics`、`zero-loss-pipeline`。**离线路由通过，默认关闭**；真实质量/成本未证明，未上线更激进合并读取/抽检。 |
| T15 Packet边界 | 分层生产、Experience、选材、独立正文/媒体审核和draft-only已有。新增context v2冻结写作DTO、证据角色、媒体/经验/边界；冻结policy，空快照不回退读实时全库。 | `src/repository.mjs`、`ai/content-engine.mjs`；migration62/63 | `major-refactor`、`content-pipeline`、`reliability-budgets`、`quality-evaluation`、`visual-planning`、`final-html-validator`、`seo-geo`。**本地契约通过**；真实成文/视觉质量、线上主题HTML未验收。 |
| T16 realtime/Batch | 保留持久Batch及迟到保护。交互extraction/coverage路由realtime；历史低优先级可Batch，不因队列阈值延期全部交互；文字/视觉反压分离。 | `src/pipeline.mjs`、`repository.mjs`、`server.mjs` | `reliability-pipeline`、`vertex-batch-pipeline`、`operations`、`model-stage-policy`。**离线调度通过**；真实provider限流/账单和长时饥饿压力未实测。 |
| T17 轮询/读路径 | 保留协调器、分页和摘要。health去掉重遥测，概览TTL15秒且HTTP写后失效；活跃7.5秒/空闲60秒/隐藏120秒，回可见立即刷新，禁止重叠。 | `src/services/summary-cache.mjs`、`server.mjs`；`frontend/src/lib/request-coordinator.js`、`App.jsx` | `reliability-ui-migration`、`ui-request-coordinator`、`performance-read-paths`、250来源真实HTTP测量。**本地通过**；另用真实应用内浏览器验证65来源、刷新保留未提交标题/说明、当前标签、来源详情；生产规模及全部编辑交互仍未验收。 |
| T18 边界/交接 | 按媒体/传输/hash/缓存职责提取小模块，保留Repository facade，加入边界检查；固定Frontend不变。新增真实benchmark、完整日志、迁移/回退文档，策略统一3.1。 | 新模块与`scripts/release-check.mjs`、`benchmark-pipeline-reliability.mjs`、`check-baseline-reliability.mjs`、`verify-media-fixtures.mjs`及文档 | **完整离线门禁通过**。未全面拆Repository/Pipeline；最终合格文章全链性能/成本缺真实样本，不能标已验证。 |

## 协议、迁移与产品语义

- 版本：App/Extension **2.0.6**、Strategy **3.1**、schema **65**；媒体协议v2兼容v1；Writing Packet context v2兼容缺省旧context；artifact契约`pipeline-dependencies-2`。
- Frontend contract仍为1.3.0，固定commit `f44ce1092ced93dfb47d9b3eae83d0d5e4b97086`，checksum `422778911aad4726d420886e70374f40f26601b641398166ceb7bed87639f8c5`，未通过改基线绕过测试。
- 新后端接受旧create/chunk/complete；新扩展遇到旧服务器未宣告v2时用旧分块流程，不能得到v2续传保证。v2 status/receipt需uploadToken及现有Capture认证。旧缺省完整性标legacy_unverified，不冒充验证；旧context走明确旧路径。
- 迁移60：dirty/claimed revision；61：production_attempt_archives；62：writing_packets.context_json；63：narrative_plans.evidence_selections_json。64：资产/文件加capture_version，事务重建资产/文件/分段唯一约束，保留ID和索引，增加当前版本视图；65：pipeline_step_receipts。可重复打开，迁移不排全库任务；64需为表副本及WAL预留空间。旧来源、草稿、审核保留创建时策略，不全表改写。
- IDB原件/manifest预算256 MiB，不自动淘汰未完成素材。默认96 MiB在途二进制预算：视频24 MiB、图片20 MiB；提高预算后视频绝对上限32 MiB。衍生缓存独立64 MiB，只淘汰可再生成资产。后端512 MiB限制不代表浏览器支持512 MiB视频。
- 未完成上传保留30天；`cleanupExpired()`默认预览并排除活跃会话，已完成回执和原件不清除。仅临时测试目录执行删除，没有接生产定时任务。
- 正文清理保留有效全文，排除评论/推荐/导航/按钮/轮播噪声，不静默截断。清理后的文字/HTML和媒体内容参与采集版本及依赖；稳定媒体身份、顺序与逐图附近上下文保留。capture_versions保存原文及媒体快照。完整重采保留历史资产、文件和分段；精确引用继续解析旧行，当前列表和覆盖审查只读当前版本。升级不能恢复此前已被旧代码删除的关联，历史接口明确snapshot_only，不能把快照计数当作找到原件。
- 六个业务入口、机会一次批准、最终发布控制、事实/经验/正文/商业分层保持。未新增普遍双来源或人工官方核验门槛。WordPress保留draft-only、防重复、已发布防覆盖。补图/局部技术失败不撤销同范围批准或重写合格正文。

## 真实测试结果

`npm run release:check`已包含check/build、当前npm test、固定SHA跨仓库测试、版本/迁移检查、隔离API/UI smoke、备份恢复演练及扩展静态/调度检查，未机械重复运行相同子命令。

| 检查 | 最终真实结果 | 范围 |
|---|---|---|
| 原HEAD同范围测试 | 437通过 / 0失败 / 0跳过 | Node报告23588.5207ms，隔离worktree |
| 修改后全套测试 | **480通过 / 0失败 / 0跳过** | 22306.8047ms；新回归及原golden/质量/发布保护共同执行 |
| 完整离线门禁 | **51必需检查通过 / 4警告 / 5未验证或未配置 / 0失败** | 不表示外部服务也通过 |
| Frontend contract | 通过 | 固定SHA未变，另一个仓库未修改 |
| 数据库/恢复 | 通过 | 新库1–65、schema59升级/中断/重开、真实进程在迁移64提交前终止后恢复、旧job/资产/文件/证据外键/完整性；gate备份小样本1哈希文件、0业务引用，另有独立backup fixtures |
| 合法媒体解码 | PNG、WebM均通过 | 应用内Chromium152；PNG1×1；WebM1×1且readyState4；不是MV3端到端 |
| 真实后台交互 | 局部通过 | 65条合成来源；刷新保留未提交标题/说明和业务标签；打开的来源详情与表单跨自动轮询保留；非MV3 |
| 外部服务 | 未调用 | Kimi、WordPress、Search Console、实际费用及搜索结果不计通过 |

SQLite ExperimentalWarning为已记录运行时警告。继续实施时先复现了完整重采删除旧图片所致的外键失败，以及同一原文件跨版本被旧唯一约束拒绝；迁移64及回归已修复。自动二分重试也增加保护：仅拆当前且未形成提取结果/证据引用的分段，不能因一次输出超限级联删除旧证据；已有引用时保留原输出并报告本次模型错误。首轮续接门禁因HANDOFF仍写schema63而失败，修正文档后重跑。过程中发现并修正：异步IDB下空队列worker饥饿、初版性能脚本未预热事件循环监测、旧PNG base64损坏，以及分页实体处理将自身别名更新误判为外部输入变化的边界。最终PNG有合法chunk/CRC/压缩像素，新增完整性断言；PNG和WebM均经真实Chromium解码。中间失败和最终正式样本不混用。

最终门禁计数、测试摘要、子日志路径和媒体解码记录见[最终检查JSON](CMS_FINAL_CHECKS_2026-09-12.json)。原始记录在`output/reliability-2026-09-12/`：`baseline-current-test-scope.log`、`final-release-check.log`、`media-decoder.json`；完整UTF-8子命令日志在`output/release-check-logs/`。`output/`按原规则不入Git；基线、最终检查和性能JSON同时纳入本审计目录。

本轮应用内浏览器的隔离 CMS 共记录34次API请求，0个HTTP错误；空闲时概览请求在07:08–07:19 UTC按约60秒持续刷新，来源详情保持打开，未提交标题/说明保持原值。手动刷新也保留当前业务标签。记录为`output/reliability-2026-09-12/ui-http.json`，时间和结论已纳入最终检查JSON。浏览器标签已关闭，隔离服务已自动停止并删除其合成测试库；没有向外部来源、模型或WordPress请求数据。

### R01–R26 最低矩阵

| 矩阵 | 实际依据与局限 |
|---|---|
| R01 | reliability-media/transport跨扩展规范化、真实上传管理器、来源落库；独立浏览器PNG/WebM解码。 |
| R02 | 本地HTTP迟正文/停滞/POST取消/槽位恢复；大上传发送途中真实Chrome中止未测。 |
| R03–R05 | evidence-validator当前/历史、逐块、条件、时间/币种/单位、伪造引用、否定、显式共享节点。 |
| R06–R07 | favorites-sync、extension-background-recovery、popup：自动恢复、主动/验证暂停、永久失败及增量推进。 |
| R08 | reliability-dom迟加载、虚拟身份替换、未知轮播、海报；真实站点轮播和迟到无限滚动未测。 |
| R09–R10 | reliability-media缺块/重启/complete重取/去重；下载与上传各211字节，Capture无重复base64。 |
| R11 | 原worker/pool回归及reliability-budgets公平/取消/缩额；不是全Chrome内存压力证明。 |
| R12 | 真实CMS health/来源/概览与4个16MiB合并并发，测事件循环/RSS/API；并以10ms定时器更新真实已领取SQLite任务的心跳，记录间隔与合并中的推进次数；没有启动生产Pipeline。 |
| R13–R14 | major-refactor、pipeline-artifacts、reliability-pipeline：Packet/选材/配置依赖、输出复用与补下游。 |
| R15 | 真实进程在实体第1/2页回执后、业务写入与enqueue之间终止，再领取同一任务恢复；覆盖审核失败只重做审核；改变配置/输入、损坏回执、旧lease均不可复用。原Batch迟到保护继续通过；未对每个外部网络响应边界逐点kill。 |
| R16 | running任务十次变化只留下同任务一次后续重跑，完成后无遗漏queued。 |
| R17 | content-recovery、major-refactor：正文/媒体分离、归档、批准与成功产物保留。 |
| R18 | reliability-network/media：DNS/逐跳/实际peer事件、路径/junction和token；TLS为受控连接夹具。 |
| R19 | entity-resolution、visual-planning、block-provenance：正向身份/撤销/独立图片；真实三地点归属未人工评审。 |
| R20 | source-preflight、zero-loss-pipeline、second-pass-semantics及profile分流；真实遗漏率、补图总调用减少未量化。 |
| R21 | major-refactor、quality-evaluation、content-pipeline、reliability-budgets：窄范围/Experience/Packet；不冒充人工成文评审。 |
| R22 | vertex-batch-pipeline、reliability-pipeline：realtime/已提交Batch/视觉隔离；长时真实配额环境未测。 |
| R23 | reliability-ui-migration、ui-request-coordinator：隐藏降频/无重叠/迟到响应/TTL；应用内Chromium另验刷新保留来源表单、业务标签、打开的来源详情；正文SEO编辑及所有页面筛选组合未测。 |
| R24 | 旧分块输入、legacy completeness、schema59升级/中断/重开；真实已安装旧扩展互操作待测。 |
| R25 | 原wordpress、publish-page、content-recovery重复draft/发布保护通过；没有向WordPress发请求。 |
| R26 | reliability-media/budgets、major-refactor保留capture_versions/原件/receipt/失败快照；补充真实完整重采回归：旧图片/文件ID、证据位置、文章外键、冻结Packet资产仍可读，当前计数不重复，随后partial不覆盖新完整版本。 |

## 性能：实际测量与未知项

命令`npm run benchmark:pipeline-reliability`；原始逐次采样见[性能JSON](CMS_PIPELINE_PERFORMANCE_2026-09-12.json)。Windows、Node24.14.0；4个16 MiB媒体并发finalize，4 MiB块，1轮预热+6轮计入，每进程含预热28文件/448 MiB。四进程顺序baseline/current/current/baseline，不能视作冷盘测试。

仅finalizer分别使用原HEAD/当前代码；**两组都使用同一份当前CMS真实HTTP路由及250条SQLite来源**。独立Worker每轮并发请求health、来源20条列表、概览，完成后间隔5ms。它隔离I/O改动的响应性影响，不是完整旧/新CMS性能比较。增加10ms定时器调用真实Repository.heartbeatJob，测量合并期间次数与心跳间隔。Pipeline.runOne/维护/模型/WordPress未启动。16 MiB样本是WebM头加填充的存储压力数据，不是16 MiB视频解码实测。

| 指标 | baseline A | current A | current B | baseline B |
|---|---:|---:|---:|---:|
| 四文件合并批次p50 / p95，ms | 192.25 / 196.72 | 272.36 / 296.66 | 263.15 / 274.19 | 187.63 / 250.84 |
| 单文件finalize调用p50 / p95，ms | 101.06 / 193.92 | 160.91 / 296.62 | 144.15 / 274.15 | 139.36 / 206.43 |
| health p50 / p95，ms | 2.04 / 194.29 | 2.39 / 8.87 | 2.18 / 5.72 | 3.14 / 197.46 |
| 来源列表p50 / p95，ms | 4.21 / 195.68 | 4.47 / 7.60 | 4.24 / 6.92 | 5.55 / 199.08 |
| 概览p50 / p95，ms | 4.54 / 195.89 | 4.74 / 7.57 | 4.50 / 6.96 | 6.09 / 199.30 |
| 每轮事件循环最大延迟的p95，ms | 210.76 | 31.51 | 17.45 | 255.20 |
| 任务心跳间隔p95，ms | 208.49 | 15.72 | 15.24 | 266.87 |
| 每轮合并期间成功心跳次数 | 0–0 | 24–27 | 24–26 | 0–0 |
| 峰值RSS，MiB | 225.09 | 178.17 | 174.40 | 223.41 |
| 计入HTTP响应数 | 93 | 393 | 393 | 93 |

实测支持：媒体处理中轻量请求及真实数据库任务心跳能继续推进，事件循环长暂停和RSS下降。旧finalizer的6轮合并窗口内均为0次心跳；当前每轮24–27次。同时**媒体合并总耗时增加**，不能声称合并吞吐或单篇完整保存更快。当前实现处理了更多HTTP请求，另有持久回执/可信记录成本；不同请求数、操作系统缓存及6轮小样本限制比较。合并p95是“四文件批次”p95，不是单笔记p95；loop一栏是每轮最大值的分位数。单文件一栏是进程内complete调用直到Promise完成的观察值，包含槽位/事件循环等待，不包含发现、下载或分块传输，也不能替代完整来源耗时。心跳为专门的已领取测试任务，不表示语义任务已经处理完成。

重复工作有实际夹具断言：PNG70字节+WebM141字节，下载211字节、原件上传211字节，最终Capture不含同一原件base64；70字节PNG对应96个base64字符，现为0（不计JSON字段开销，不外推全任务比例）。同hash create直接返回receipt；重启只补缺块；重复complete同receipt；衍生缓存hash/参数/版本一致复用；产物命中补下游且不调用模型。实体解析305条claim在第1/2页落盘后被真实杀进程，恢复后的总fixture调用仍为2次；补提取成功而审核传输失败时，提取1次、审核2次。这些不是实际账单收益证明。

以下统一为**unknown / 未测**：单篇完整来源p50/p95；真实浏览器总网络字节/人工介入率；生产阶段排队/provider等待分布；模型tokens/费用；重要遗漏/首轮质量通过率；最终合格文章含失败成本的总费用/总耗时。脚本providerCalls=0表示没有调用，不表示文章费用为0。原`benchmark:extension-repair`使用模拟时长，不作为本次真实速度依据。

## 升级、回退与精确续接

完整步骤见[2.0.6升级文档](../CMS_RELIABILITY_UPGRADE_2.0.6.md)。维护窗口先备份一致数据库、原件、回执及必要临时分块；隔离副本验收；**后端先升、扩展后升**。按迁移60–65升级，64事务重建三张表的唯一约束且保留行与引用，不全库回填；保持`SOURCE_COMPLEXITY_ROUTING=false`。回退恢复匹配的代码/数据库/文件快照，不能删列或改schema号；不得删除原件或清空浏览器IDB。

| 续接编号 | 未完成或受环境限制内容 | 后续范围 |
|---|---|---|
| T04–T07、T17 | 真实MV3/小红书及完整编辑交互未验收；已验证的应用内来源表单/详情不代表Chrome扩展持久性。 | 按升级文档，在隔离后端测试加载/上传时重启、丢complete、主动/验证暂停、永久坏笔记、轮播迟加载、隐藏/恢复；记录真实传输和完整状态。 |
| T06–T08 | 无浏览器大视频流式IDB路径；解码峰值和真实断电耐久未验收。历史资产/文件版本迁移及消费者回归已补齐。 | 保持24/32MiB上限；在真实Chrome测内存后再扩容量。生产大库迁移时间/空间需在备份副本测量。 |
| T09、T11、T16 | 分页回执、组合补提取/审核、页面/商业/发布包及投递确认已补齐；真实外部响应丢失和收费窗口未验证。 | 保留WP既有幂等/回执；单次模型阶段继续使用完整artifact，没有全部改为逐调用回执。不能保证“已收费、本地未落盘”窗口绝无重复费用。 |
| T13–T16 | 真实语义、图片本地化质量、轻量路由质量/成本、配额压力未知。 | 保持开关关闭。隔离固定样本按实际配置adapter记录模型/输入范围/tokens/账单并人工评审，再决定启用；不新增日常产品人工门槛。 |
| T12 | 外部合法CDN/TLS恢复未运行。 | 隔离环境用用户正常获得的合法媒体链接验收；不探测真实内网。 |
| T08、T17、T18 | 缺最终合格文章全链成本/耗时比较与生产规模；真实SQLite心跳混合负载已补测。 | 复跑现有benchmark，补单来源端到端样本与语义任务处理进度，不能用finalize或心跳代替全链完成。 |
| T15、T18 | 真实WordPress主题/crawler可见HTML、搜索结果未验收，未部署。 | 离线gate已完成；外部演练只投递受控测试草稿且保留防覆盖。生产发布继续由用户控制。 |

可复跑命令：`npm run release:check`；`npm run benchmark:pipeline-reliability`；`node scripts/check-baseline-reliability.mjs`；`node scripts/verify-cms-ui.mjs --duration-ms=180000`（65条合成来源，自动停止并清理临时库）；`node scripts/verify-media-fixtures.mjs`后在浏览器打开打印出的本地地址，仅服务合成媒体。离线局部调度筛选可用`node --test --test-name-pattern="fragment|coverage|Batch" "test/**/*.test.mjs"`。没有伪造“一键完成真实模型人工评审”的命令，也未运行生产回填。
