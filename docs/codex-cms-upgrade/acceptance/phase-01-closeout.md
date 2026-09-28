# 阶段 01 定向收尾验收映射

本表逐项承接 [原阶段验收](phase-01.md) 的原状态和证据/缺口，不把原 `PARTIAL` 改写成通过。新增证据见 [恢复](../evidence/phase-01/closeout-restore-20260927.json)、[媒体与投递取证](../evidence/phase-01/closeout-forensic-20260927.json)、[Worker 回放](../evidence/phase-01/closeout-worker-20260927.json)。

归属允许多个标签：`LOCAL_REQUIRED` 为本地硬要求；`REAL_DATA_REPAIR` 是原数据修复；`EXTERNAL_AUTH` 是外部授权/环境验证。后续内容功能另列阶段 02 台账，不替换这里的本地验收。

| 原需求/用例 | 原状态 | 归属 | 原证据与未完成项 | 本轮新增证据 |
|---|---|---|---|---|
| LOC-001 基线 | PARTIAL | LOCAL_REQUIRED | 核实唯一仓库、remote、HEAD 与工作树；未执行完整迁移前基线。 | 本轮无新增验证，沿用原记录 |
| LOC-002 模式隔离 | PARTIAL | LOCAL_REQUIRED | development 身份标记拒绝生产/无标记 DB；migration-review API/Worker 禁写；待真实历史 DB 副本复验。 | 实时图片分析未知投递隔离仍生效 |
| LOC-003 数据分离 | PASS_LOCAL(CMS_ONLY) | LOCAL_REQUIRED | `CMS_DATA_ROOT` 外置；临时源码副本移走后稳定 release API 仍健康；更新代码/重装依赖生成第二 release 时旧 API 仍可用，切换后保留同一数据集。 | 本轮无新增验证，沿用原记录 |
| LOC-004 启停诊断 | PARTIAL | LOCAL_REQUIRED | `local:prepare/stable/status/stop/logs/unlock/inspect/promote` 存在，停止幂等、端口冲突有测试；最新代码已重跑隔离 release/API health/同数据根切换演练，完整安装与启动异常矩阵未验。 | 本轮无新增验证，沿用原记录 |
| LOC-005 单主协调 | PARTIAL | LOCAL_REQUIRED | 同一根目录 API+Worker 共存、重复角色拒绝；跨文件系统/跨主机条件未验证。 | 本轮无新增验证，沿用原记录 |
| LOC-006 Google 认证 | PARTIAL | LOCAL_REQUIRED + EXTERNAL_AUTH | ADC 与 GCE metadata 分支及并发刷新 mock PASS；真实权限未验。 | 本轮无新增验证，沿用原记录 |
| LOC-007 主密钥 | PARTIAL | LOCAL_REQUIRED | 正确/错误/缺失密钥的本地安全阻断及密文保留 PASS；重录流程未做 UI 验收。 | 本轮无新增验证，沿用原记录 |
| LOC-008 数据盘点 | PARTIAL | LOCAL_REQUIRED + REAL_DATA_REPAIR | 多类文件根、DB 明确路径列、未晋升视觉候选，以及来源/历史采集 JSON 中的 `localPath`、`storagePath`、原图/衍生图引用纳入快照；其他潜在 JSON 键和真实历史路径尚未审计。 | 修复快照正向恢复 + 原快照拒绝；原生产数据仍待处理 |
| LOC-009 一致快照 | PARTIAL | LOCAL_REQUIRED | SQLite `VACUUM INTO`、部分媒体 lease、已存 DB SHA-256 与文件字节交叉校验；普通采集分块原子落盘且重试不可覆盖，快照排除尚未提交的 `.tmp` 分块，来源清理保护视觉候选引用。全部写入/清理者和主线程延迟未验。 | 修复快照正向恢复 + 原快照拒绝；原生产数据仍待处理 |
| LOC-010 manifest | PARTIAL | LOCAL_REQUIRED | v3 清单增加关键业务行指纹，保留 v2 读取；文件哈希、DB 引用、schema、retention、回滚字段已核对；历史格式和全部用途字段未穷尽。 | 修复快照正向恢复 + 原快照拒绝；原生产数据仍待处理 |
| LOC-011 可移植恢复 | PARTIAL | LOCAL_REQUIRED + REAL_DATA_REPAIR | 新目录恢复、明确存储列及历史采集 JSON 文件路径重映射、旧清理队列重映射、schema 检查、空间预检及符号链接/大小写防护；跨 OS 实测未做。 | 修复快照正向恢复 + 原快照拒绝；原生产数据仍待处理 |
| LOC-012 恢复业务核对 | PARTIAL | LOCAL_REQUIRED + REAL_DATA_REPAIR | v3 清单记录来源、版本、Job、知识、草稿、视觉候选、WordPress 映射、Provider Batch/调用的关键列全行指纹，恢复后复核；另有哈希、DB 完整性、外键、媒体可打开、演练和直接恢复启用前的已知 MIME 文件头核对、离线草稿交付探针。真实历史数据及远端映射对账未做。 | 修复快照正向恢复 + 原快照拒绝；原生产数据仍待处理 |
| LOC-013 多设备访问 | PARTIAL | LOCAL_REQUIRED + EXTERNAL_AUTH | CORS 仅接受同源或 `CAPTURE_ALLOWED_ORIGINS` 明确配置的扩展来源；未知来源的预检/写请求拒绝测试 PASS。私有代理、Host/CSRF 全流程、扩展权限和移动设备 UI 尚未 E2E。 | 本轮无新增验证，沿用原记录 |
| LOC-014 换主机交接 | PARTIAL | LOCAL_REQUIRED + EXTERNAL_AUTH | 只读交接检查列出运行中 Job/未决投递；提升要求旧主机停用确认并阻断未对账状态；实际双机交接未演练。 | 实时图片分析未知投递隔离仍生效 |
| LOC-015 只补缺口 | PARTIAL | LOCAL_REQUIRED | 未决远端状态可识别并阻断提升；按 ID 自动对账及断点续跑未完成。 | 实时图片分析未知投递隔离仍生效；12 Job 的 scoped Worker mock 回放；7 来源仍需人工 review |
| LOC-016 独立交付 | PARTIAL | LOCAL_REQUIRED + EXTERNAL_AUTH | 独立 HTTP 接收器在 CMS 关闭后仍能提供 JSON/图片；真实 WordPress/PHP 未验。 | 本轮无新增验证，沿用原记录 |
| LOC-017 外部依赖 | PARTIAL | LOCAL_REQUIRED + EXTERNAL_AUTH | 未知资源如实列于外部依赖清单；无真实合同、账单或设备核对。 | 本轮无新增验证，沿用原记录 |
| LOC-018 说明与版本 | PARTIAL | LOCAL_REQUIRED | 本地运行说明、状态版本/schema 输出可用；迁移操作手册仍需补齐。 | 本轮无新增验证，沿用原记录 |
| PERF-001 服务端分页 | PARTIAL | LOCAL_REQUIRED | 来源/知识/内容主列表 SQL 分页，异常列表批量查找降到 12 SQL；异常集合仍由 JS 汇总/分页。 | 本轮无新增验证，沿用原记录 |
| PERF-002 路由状态 | PARTIAL | LOCAL_REQUIRED | 来源页切菜单和 20→50 条浏览器 smoke PASS；筛选/迟到响应未全验。 | 本轮无新增验证，沿用原记录 |
| PERF-003 预取与轮询 | PARTIAL | LOCAL_REQUIRED | 请求协调/隐藏页退避、返回刷新与不重叠定向测试 PASS；后台失焦、慢健康检查 E2E 未验。 | 本轮无新增验证，沿用原记录 |
| PERF-004 API/Worker 分离 | PARTIAL | LOCAL_REQUIRED | 进程角色与租约、合成非空 API 基准；Worker 负载下的延迟未验。 | 12 Job 的 scoped Worker mock 回放；7 来源仍需人工 review |
| PERF-005 可复现基准 | PARTIAL | LOCAL_REQUIRED | 1000 来源、10k claims、300 drafts、3000 media、50 系统故障；API 各路 30 次及 Chrome 三个菜单冷/热各 30 次，在 idle 与 CMS Worker＋合成只读/CPU 并发负载下均保存原始样本；真实 Worker 执行业务负载未测。 | 12 Job 的 scoped Worker mock 回放；7 来源仍需人工 review |
| PERF-006 耗时/费用 | PARTIAL | LOCAL_REQUIRED + EXTERNAL_AUTH | 模型尝试计量、未知价格为空、429/未知传输结果、确定性错误不继承旧 429 的定向测试 PASS；全阶段耗时和真实账单对照未验。 | 本轮无新增验证，沿用原记录 |
| LOC-019 范围与接续 | PARTIAL | LOCAL_REQUIRED | 仅 CMS 仓库改动、提示词与证据落盘；旧阶段证据映射未全面复验。 | 本轮无新增验证，沿用原记录 |
| T01-01 | PARTIAL | LOCAL_REQUIRED | 独立 release prepare、release 内 status、API health 200、logs PASS；完整安装/启动矩阵未验。 | 本轮无新增验证，沿用原记录 |
| T01-02 | PARTIAL | LOCAL_REQUIRED | 错误 development 数据根、缺生产库的本地拒绝 PASS；真实生产目录替身与 Worker 门禁待复验。 | 实时图片分析未知投递隔离仍生效 |
| T01-03 | PARTIAL | LOCAL_REQUIRED | migration-review 含 queued/running Job 的只读检查，DB 哈希不变；真实历史库及外部调用监控未验。 | 实时图片分析未知投递隔离仍生效 |
| T01-04 | PASS_LOCAL(CMS_ONLY) | LOCAL_REQUIRED | `node scripts/verify-local-release-isolation.mjs`：移走临时源码后启动 release，准备更新版时旧 API 保持 200，更新版启动后数据库身份不变；见 `release-isolation.json`。 | 本轮无新增验证，沿用原记录 |
| T01-05 | PARTIAL | LOCAL_REQUIRED | 端口冲突、停止两次、安全日志 PASS；缺依赖和全部启动异常未验。 | 本轮无新增验证，沿用原记录 |
| T01-06 | PARTIAL | LOCAL_REQUIRED | API+Worker 与重复角色租约测试 PASS；负载/跨主机未验。 | 本轮无新增验证，沿用原记录 |
| T01-07 | PARTIAL | LOCAL_REQUIRED + EXTERNAL_AUTH | ADC 与 metadata mock PASS；真实云运行未验。 | 本轮无新增验证，沿用原记录 |
| T01-08 | PARTIAL | LOCAL_REQUIRED + EXTERNAL_AUTH | ADC 并发刷新、缺凭证 mock PASS；真实错误权限与 429 行为未验。 | 本轮无新增验证，沿用原记录 |
| T01-09 | PARTIAL | LOCAL_REQUIRED | 正确/错误/缺失加密主密钥本地测试 PASS；后台重录 UI 未验。 | 本轮无新增验证，沿用原记录 |
| T01-10 | PARTIAL | LOCAL_REQUIRED + REAL_DATA_REPAIR | WAL、多类媒体、v3 manifest、独立列和历史采集 JSON 引用、DB 媒体指纹交叉检查及 v2/DB-only 旧格式测试；全部潜在引用未盘清。 | 修复快照正向恢复 + 原快照拒绝；原生产数据仍待处理 |
| T01-11 | PARTIAL | LOCAL_REQUIRED + REAL_DATA_REPAIR | 异目录恢复和独立列/历史采集 JSON 路径重映射、v3 关键业务行指纹复核、哈希、已知 MIME 文件头检查、离线草稿探针；真实历史业务 ID/远端映射全量对账未做。 | 修复快照正向恢复 + 原快照拒绝；原生产数据仍待处理 |
| T01-12 | PARTIAL | LOCAL_REQUIRED | 媒体 lease 冲突、采集分块原子提交/重复上传冲突、快照排除未提交临时分块测试 PASS；全部媒体写入路径/事件循环延迟未验。 | 本轮无新增验证，沿用原记录 |
| T01-13 | PARTIAL | LOCAL_REQUIRED + REAL_DATA_REPAIR | 缺图、坏哈希、manifest 少列 DB 引用、schema 新旧隔离、空间不足预检测试 PASS；真实盘满/部分归档完整矩阵未验。 | 修复快照正向恢复 + 原快照拒绝；原生产数据仍待处理 |
| T01-14 | PARTIAL | LOCAL_REQUIRED + REAL_DATA_REPAIR | 路径穿越、符号链接、大小写碰撞、POSIX 路径在 Windows 恢复、复制中断后同快照续恢复 fixture PASS；另一 OS 和真实盘满未验。 | 修复快照正向恢复 + 原快照拒绝；原生产数据仍待处理 |
| T01-15 | PARTIAL | LOCAL_REQUIRED + EXTERNAL_AUTH | 精确 CORS allowlist、未知扩展 Origin 的预检/写请求拒绝本地 HTTP 测试 PASS；私有访问/扩展/移动端完整流程未验。 | 本轮无新增验证，沿用原记录 |
| T01-16 | PARTIAL | LOCAL_REQUIRED + EXTERNAL_AUTH | 未确认旧主机停用及运行中任务阻断提升 PASS；实际交接/重启未验。 | 实时图片分析未知投递隔离仍生效 |
| T01-17 | PARTIAL | LOCAL_REQUIRED + EXTERNAL_AUTH | Batch/远端不确定状态被只读列出并阻断提升；按 ID 对账与断点续跑未实现。 | 实时图片分析未知投递隔离仍生效；12 Job 的 scoped Worker mock 回放；7 来源仍需人工 review |
| T01-18 | PASS_LOCAL(CMS_ONLY) | LOCAL_REQUIRED + EXTERNAL_AUTH | 独立 HTTP 接收器保存交付 JSON/图片，CMS 关闭并删本地图片后仍可读取；真实 WP 单列 `NOT TESTED`。 | 本轮无新增验证，沿用原记录 |
| T01-19 | PARTIAL | LOCAL_REQUIRED + EXTERNAL_AUTH | 未知外部资源清单如实记录；真实资源访问未获验证。 | 本轮无新增验证，沿用原记录 |
| T01-20 | PARTIAL | LOCAL_REQUIRED | 非空数据集分页及异常批量查询测试；异常仍非 SQL 级分页。 | 本轮无新增验证，沿用原记录 |
| T01-21 | PARTIAL | LOCAL_REQUIRED | 来源页切菜单、翻页、改 page size 浏览器 smoke；迟到请求取消/忽略单元测试 PASS；筛选失效 E2E 未验。 | 本轮无新增验证，沿用原记录 |
| T01-22 | PARTIAL | LOCAL_REQUIRED | 隐藏页轮询退避、可见时刷新、不重叠和销毁后不恢复单元测试 PASS；后台/失焦/慢模型健康 E2E 未做。 | 本轮无新增验证，沿用原记录 |
| T01-23 | PARTIAL | LOCAL_REQUIRED | 同代码/合成数据的 API idle/loaded 各路 30 次见 v8/v7 报告；Chrome 来源/知识库/内容菜单在 idle/loaded 下冷/热各 30 次见两份 browser 报告，冷 P95 idle/loaded 为 270/285、344/351、404/364 ms；真实 Worker 业务负载未测。 | 12 Job 的 scoped Worker mock 回放；7 来源仍需人工 review；19.707 ms 仅为内部函数，非 API/菜单指标 |
| T01-24 | PARTIAL | LOCAL_REQUIRED + EXTERNAL_AUTH | 模型账本 unknown 不冒充 0、429 保留 HTTP 状态/请求 ID、图片变换失败不伪造候选、确定性布局错误不继承旧 429 的 mock 回归 PASS；真实 Provider/账单仍未验。 | 实时图片分析未知投递隔离仍生效 |
| T01-25 | PARTIAL | LOCAL_REQUIRED | 仅 CMS 工作树、无前端仓库修改；旧 CMS 证据映射待核。 | 本轮无新增验证，沿用原记录 |

## 本轮输入和取证

- 工作树：`C:\Users\Mloong\Documents\ChatGPT\solo-to-china-CMS`，`main`，HEAD `e9f7c8e82ff760f4d18f2d2e0673452eb8744290`，仍有阶段 01 未提交改动。原执行规范保持在 `phases/phase-01.txt`，本轮补充规范另存 `phases/phase-01-closeout.txt`。
- 原始已授权本地快照：`baseline-20260923`，v2 manifest SHA-256 `fdbd052fb3f9c7b336d8c2e0d36a6d4336131005e926b9fd4083d4f4214165c0`。原快照和原 `source-gap-work.sqlite` 没有改写。
- 本轮风险分类：`DATABASE_LOGIC / PIPELINE / DATA_MIGRATION` 的恢复演练、`LOCAL_LOGIC` 的隔离测试。无生产发布。私有行值仅在本机演练副本中使用；仓库证据用不可逆短标签。

### 缺失媒体：五条引用、一个文件

[逐行脱敏证据](../evidence/phase-01/closeout-forensic-20260927.json)列出每条 `source_asset_storage_refs.derivative_storage_ref`、所属来源标签、capture version、原件和派生件路径、预期 SHA-256 与处理记录。五条均指向一个 24,572 字节 WebP；`transform_json={}`，五条 `ai_derivative_sha256`、`original_sha256`、`stored_sha256` 和原件 manifest/file SHA-256 全等。分类为 **D：同一原件字节已归档，派生路径副本缺失**。原件是保存的原始证据；派生路径是相同字节的别名。缺失路径为何没有落盘或入档，现有证据无法判定。

运行 `python scripts/stage01-repair-identical-derivative.py <原快照> <全新演练目录>`，脚本只有在五条引用、一个派生路径、一个原件路径、四种哈希/状态均精确一致时才创建新快照。演练快照 manifest SHA-256 为 `e5dede046d15aebf212280c3ec3b5c68fba8a0adeb15dfd81cbf641fd20956ae`，记录父 manifest 和唯一新增文件。`verifyBackup` 对新快照检查 1219 文件及 1592 条引用通过；`restoreBackup` 恢复到新的 `C:\s01-restore-20260927`，schema 78→80，`quick_check=ok`、外键违规 0，业务表 ID 集合逐项不变，WebP 实际解码为 360×360。原损坏快照的 `verifyBackup` 继续拒绝缺失引用。[完整核对](../evidence/phase-01/closeout-restore-20260927.json)。这证明本机**修复副本**可恢复，不表示原快照或现行生产文件系统已修好；原真实快照状态仍为 `BLOCKED_DATA`。

### 未知投递：实时图片分析

唯一未决 `media_dispatches` 是 `analyze_source_image`，Vertex `global` / `gemini-3.8-flash`，时间和脱敏对象见取证 JSON。它不是 Batch 创建或结果读取；本地没有该投递的 `provider_request_id` 或成功回执。相同 visual 后来的本地化与质量 QA 有各自已完成回执和成品，但不能证明最初分析请求的真实远端结果。该子阶段预算已花 1 次，额外授权 0；未改状态、未归零预算、未重发。现有本地 QA 对账接口只接受 `visual_quality_qa` 且须精确候选哈希；测试新增 `analyze_source_image` 拒绝路径。提升门禁在重启后仍拒绝任意未决媒体投递。真实请求维持 `QUARANTINED_UNRESOLVED`。如需进一步外部核查，须单独批准具体 project、location、时间窗、对象和只读动作；同步分析没有可确认的按 request ID 找回结果接口，不能假装可自动对账。

### 12 个 Job 的实际 Worker 回放

从已恢复、已迁移的本地库另用 SQLite `VACUUM INTO` 创建 D 盘一次性工作库；脚本 `scripts/stage01-worker-replay.mjs` 在应用模块载入前拒绝 `fetch`、HTTP、socket、TLS 和子进程出口，禁用 Batch、只注入 extractor mock，限定可领取的来源处理 Job，未消费旧队列/WordPress。所有 12 个原始恢复 Job 经真实 `Pipeline.runOne` 领取、检查、提交而 `succeeded`；后续 6 个 `segment_source`、23 个分段抽取、23 个覆盖审计、17 个定向重试也经相同代码执行，共 75 次领取。外键违规 0，未知投递保留为 1，未新增真实 Provider metric。逐 Job 的哈希标签、capture version、类型和最终状态见 [Worker 证据](../evidence/phase-01/closeout-worker-20260927.json)。

七个真实来源均因图片 mock 无法提供可信语义而停在 `exception/manual_review`；未直接 SQL 改 Job 成功，也未把 mock 输出当成真实来源处理完成。正向的受控文本来源 Pipeline 链和事务回滚/重复入队回归见 `test/pipeline.test.mjs`、`test/reliability-pipeline.test.mjs`。真实图像来源的完整下游终态、处理中崩溃重启、旧结果晚到与媒体成功但 QA 未完成的同一回放场景尚未全部验证，C01-08/C01-09 不能标成全通过。

## L1～L6 与探索审计

分级定义取自仓库 `AGENTS.md`，不是截图里的数字推断。

| 层级 | 适用定义 | 本轮状态和证据 |
|---|---|---|
| L1 Targeted Tests | 受影响模块的快速测试 | `PASS`：恢复、运行模式、媒体投递和 Pipeline 定向测试 68/68。 |
| L2 Module Regression | 模块及直接上下游 | `PASS`：`npm test` 887/887，`npm run check` 通过。 |
| L3 Production DB Replay | 已授权真实 DB 的一次性副本 | `PARTIAL`：12 Job 与 schema/恢复通过；7 个来源只到人工 review，未证明真实内容自动完成。 |
| L4 Browser E2E | 实际用户交互 | `PARTIAL`：沿用既有来源页分页/移动端、菜单基准证据；本轮未新增完整 Source Recovery/Content 操作 E2E。 |
| L5 Real Provider Canary | 模型/Schema/传输改动才执行 | `NOT TESTED`（本轮）；前轮固定文本 canary 1 次 PASS，不能代替图片分析或 Batch。最新授权禁止新请求。 |
| L6 Full Production-Like Replay | 大型流程/正式发布前 | `NOT TESTED`；真实接管、付费全链和 WordPress 属后续授权，当前本地 scoped Worker 回放已单独记录。 |
| Post-Fix Exploratory Audit | 中高风险相邻问题扫描 | `ISSUES FOUND`：未知实时投递、7 来源人工 review、原快照仍损坏；没有静默提升。 |

## C01-01～12 专项结论

| 项目 | 状态 | 本轮事实与剩余缺口 |
|---|---|---|
| C01-01 工作树身份 | PASS | repo/remote/HEAD/未提交改动已核；未 reset、stash、pull、覆盖。 |
| C01-02 五引用一文件 | PASS | 五行、一个 SHA-256、原件/派生路径及 capture version 逐行取证。 |
| C01-03 正常恢复 | PASS_LOCAL | 修复副本全文件校验、异路径恢复、schema/ID/hash/解码通过。原快照仍损坏。 |
| C01-04 损坏拒绝 | PASS | 原快照明确拒绝，原件和旧 manifest 未修改。 |
| C01-05 修复身份 | PASS_LOCAL / BLOCKED_DATA | 同哈希别名仅加在有父记录的新演练快照；生产当前数据未改。 |
| C01-06 未知结果 | PARTIAL | 实时图片分析不能按 Batch 对账；本地 QA 对账拒绝错误子阶段，真实结果仍未知。 |
| C01-07 隔离持久 | PARTIAL | 重启后提升仍拒绝、预算/投递未清；同一真实场景旧结果晚到及重复唤醒全链未测。 |
| C01-08 Worker 正向链 | PARTIAL | 12 个原始 Job 均由 Worker 执行并成功；7 个来源未形成完整下游成果。 |
| C01-09 Worker 负向链 | PARTIAL | mock 无法证明图像事实时明确进入 review；崩溃/QA 丢失等组合故障未在这份库重放。 |
| C01-10 模式与出口 | PARTIAL | 已有模式门禁回归，本轮脚本网络/子进程出口拒绝；真实旧主机交接未执行。 |
| C01-11 性能与回归 | PARTIAL | 既有合成 API/菜单 30 样本，真实 Worker 同时承载 API 未测；19.707 ms 是内部异常集合构建函数。 |
| C01-12 决策分层 | PASS | 本地能力、原快照、未知投递、阶段 02、生产许可分别列下。 |

## 验收决策

| 决策对象 | 结论 |
|---|---|
| 阶段 01 本地能力 | **BLOCKED**：C01-08/09/11 及原阶段本地硬要求仍有 `PARTIAL`，无用户接受的偏差记录。 |
| 当前真实生产快照可直接完整恢复 | **BLOCKED_DATA**；本机有可恢复的修复副本，原快照仍拒绝。 |
| 未知真实图片分析请求 | **QUARANTINED_UNRESOLVED**；无精确回执，不自动重发。 |
| 阶段 02 隔离本地开发 | **BLOCKED**；待阶段 01 本地硬要求补齐后再判。 |
| 本机接管真实生产/停云 | **NOT_AUTHORIZED / NOT_READY**。 |

本轮停止于阶段 01，不运行阶段 02。未提交、推送或部署；未新增生产私有读取/写入、真实模型请求或前端仓库修改；未提升稳定模式、未停止云端服务。第一次演练快照复制因 Windows 长路径失败，随后使用扩展路径前缀在新目录成功；自动审批拒绝了清理第一次未完成副本的递归删除，故该未完成本地目录仍保留，且不作为证据使用。

## 本轮命令、退出码与边界

| 命令/动作 | 环境与输入 | 结果 |
|---|---|---|
| `python scripts/stage01-repair-identical-derivative.py ...` | 已授权本地 v2 快照 → 新隔离目录 | 首次 Windows 长路径复制失败；扩展路径修正后退出码 0，新增一份同哈希副本。 |
| `npm run backup:verify -- <修复副本>` | 本地修复副本 | 退出码 0，1219 文件、1592 引用、3,016,152,188 字节全校验。 |
| `verifyBackup(<原快照>)` | 原快照只读 | 正确拒绝缺失数据库引用；原 manifest SHA-256 不变。 |
| `restoreBackup(<修复副本>, <全新外置路径>)` | 本地修复副本 | 退出码 0；schema 80、`quick_check=ok`、外键 0、关键表 ID 保持、WebP 解码通过。 |
| `node scripts/stage01-worker-replay.mjs ...` 及 `--resume` | 本地恢复库 → D 盘一次性工作库；网络/子进程拒绝、供应商 mock | 两次均退出码 0；75 个相关 Job 真实领取/执行，12 个原始 Job 成功，7 个来源人工 review。 |
| `node --test test/local-runtime.test.mjs test/media-request-executor.test.mjs test/backup.test.mjs test/pipeline.test.mjs test/reliability-pipeline.test.mjs` | 本地 fixture/mock | 退出码 0，68/68。 |
| `npm test` | 本地 fixture/mock | 退出码 0，887/887，无失败或跳过；完整日志保存在本机演练目录，不写入仓库。 |
| `npm run check` | 本地构建、语法、服务边界 | 退出码 0，服务边界 12 文件无违规。 |
| `git diff --check` | 当前未提交工作树 | 退出码 0。`git diff --stat` 仅覆盖 30 个已跟踪改动文件；新增证据和脚本仍为 untracked，完整清单见 `git status --short`。 |

此前 [API 与菜单原始样本](../evidence/phase-01/local-validation.md) 的合成负载曾达到目标，但本轮 75 个真实 Pipeline Job 没有与 HTTP/浏览器基准同时运行，因此不能把两项证据相乘称为“真实 Worker 负载下 P95 已达标”。数据库异常列表内部构建 30 样本 P95 19.707 ms 也不能代替完整 API 或菜单指标。

既有 30 样本基准的可复核数值：idle/合成负载/合成 Worker 负载下，五条 20 项 API 路由最大 P95 分别为 8.456/19.999/7.788 ms；Chrome 来源/知识/内容冷菜单 P95 分别为 idle 270/344/404 ms、合成负载 285/351/364 ms，热菜单最大 88 ms。原始样本在 [`performance-idle-v8.json`](../evidence/phase-01/performance-idle-v8.json)、[`performance-loaded-v7.json`](../evidence/phase-01/performance-loaded-v7.json)、[`worker-load-20260927.json`](../evidence/phase-01/worker-load-20260927.json)、[`performance-browser-v1.json`](../evidence/phase-01/performance-browser-v1.json)、[`performance-browser-loaded-v1.json`](../evidence/phase-01/performance-browser-loaded-v1.json)。它们验证合成基准目标，不覆盖本轮真实业务 Job 同时运行的场景。

下一轮阶段 01 的最低本地补证：在同一隔离数据集运行包含完整文本与媒体输入的受控正向 Worker 链，并对处理中退出/重启、重复唤醒、旧回执晚到、媒体成功而 QA 未完成做组合故障注入；完成 Source/Content 浏览器操作 E2E；在 Worker 真正执行时采集非空数据库 API 与菜单各 30 样本。修复真实未知分析投递须另行精确授权，不应阻塞上述本地工作。

## 2026-09-27 FIN01 v1.1 续修增量

本节补充上述未完成证据，保留前文作为当时的记录。完整本轮输入保存在 [`phase-01-closeout-v1.1.txt`](../phases/phase-01-closeout-v1.1.txt)。仓库仍是 `C:\Users\Mloong\Documents\ChatGPT\solo-to-china-CMS`、`main`、HEAD `e9f7c8e82ff760f4d18f2d2e0673452eb8744290`；所有改动未提交。变更风险分类：`PIPELINE`（重新提取收尾）、`UI_ONLY`（知识库筛选状态）、本地故障验证。没有生产读写、真实模型请求、正式 WordPress 写入、提交、推送或部署。

### FIN01 对原门槛的映射

| 检查 | 原门槛 | 状态 | 本轮证据与边界 |
|---|---|---|---|
| FIN01-01 工作树与证据身份 | C01-01、T01-25 | PASS_NEW | 核对仓库、remote、分支、HEAD、未提交改动及原三份取证 JSON；九个相关代码/提示词文件的 SHA-256 和工作树状态见 [`fin01-worktree-identity.json`](../evidence/phase-01/fin01-worktree-identity.json)。保留旧 v1.0 和旧演练目录。 |
| FIN01-02 三种快照身份 | C01-02～05、T01-10/11/13/14 | PASS_EXISTING_VERIFIED | 原 manifest `fdbd052f…165c0` 仍按预期拒绝；修复 manifest `e5dede04…56ae` 的 1219 文件、1592 引用校验与本地恢复见 [`closeout-restore-20260927.json`](../evidence/phase-01/closeout-restore-20260927.json)。本轮没有再次复制或改写快照。 |
| FIN01-03 七个历史 review | C01-08/09、T01-17 | NOT_RUN（逐段原因）；聚合复用旧证据 | 旧 Worker 报告的 7 个脱敏来源均为 `exception`，各有 1/6/1/3/1/3/2 个 `manual_review` 覆盖段；媒体 mock 不产生可信图片 Claim，`reconcileSourceCoverageState` 对 material uncovered 段设置人工 review。旧报告未保存每段 `uncovered_spans_json`，因此无法把每一行的具体缺口冒称已核实；review 不视作 Worker 调度失败。 |
| FIN01-04 完整正向 Worker | C01-08、T01-17 | PASS_NEW | 完整文字与实际 PNG 字节的独立来源经真实 Worker 到 `processed`，26/26 Job 成功、9 个 artifact、1 个可追溯 Claim、0 活动 Job、0 真实模型/媒体投递、0 外键违规；见 [`fin01-worker-complete.json`](../evidence/phase-01/fin01-worker-complete.json)。AI 仅在供应商方法边界给出与文字一致的契约响应；队列、事务、检查点、Pipeline 和状态转换均为应用代码。 |
| FIN01-05 故障注入 | C01-07/09、T01-03/17/18 | PASS_NEW（下列本地场景）；同一历史数据集组合回放 NOT_RUN | 首个成功 artifact 后停止 Worker PID 11528，新 Worker PID 1576 从同库继续，24/24 Job 成功、未重复已提交步骤，见 [`fin01-worker-resumed.json`](../evidence/phase-01/fin01-worker-resumed.json) 及保留的 `interruption.json`；重复启动 PID 4272 后 26 Job/9 artifact/1 Claim 不变，见 [`fin01-worker-duplicate-wakeup.json`](../evidence/phase-01/fin01-worker-duplicate-wakeup.json)。媒体母图 `pending_qa` 仅重做 QA 的定向回归、晚到旧输入阻断提交、接收器落盘后丢响应并先 GET 对账、migration-review 真 Worker 拒绝另见下文。 |
| FIN01-06 未知结果隔离 | C01-06/07、T01-16/17/24 | PASS_EXISTING_VERIFIED（本地保护）；真实结果未解决 | 旧报告记录 `analyze_source_image` 一笔 `outcome_unknown`、预算已花 1 次且未增加授权；`test/media-request-executor.test.mjs` 覆盖重启后 unknown、拒绝错误 QA 子阶段和额外 grant。未查询或重发真实供应商请求。 |
| FIN01-07 浏览器交互 | T01-20/21/22 | NOT_RUN（真实 unknown/review 页面）；其余交互 PASS_NEW | 浏览器连接真实本地 API 与隔离 SQLite：来源 20→50、翻页、详情返回，点击“重新提取”看到 queued→processed；设置页读取 50 个异常；切菜单后知识库目的地筛选保留。截图见 [`fin01-browser-sources-50.jpg`](../evidence/phase-01/fin01-browser-sources-50.jpg)、[`fin01-browser-recovery-queued.jpg`](../evidence/phase-01/fin01-browser-recovery-queued.jpg)、[`fin01-browser-recovery-complete.jpg`](../evidence/phase-01/fin01-browser-recovery-complete.jpg)、[`fin01-browser-exceptions.jpg`](../evidence/phase-01/fin01-browser-exceptions.jpg)、[`fin01-browser-filter-retained.jpg`](../evidence/phase-01/fin01-browser-filter-retained.jpg)。迟到详情/请求取消由现有请求协调回归覆盖；真实 unknown/review 的页面未用历史私有库重开。 |
| FIN01-08 真实 Worker 性能 | PERF-005、C01-11、T01-23 | PASS_NEW（已测指标） | 1,200 来源、10,000→10,013 claims、300 草稿、3,200 媒体元数据。API 5 路各 30 次完整响应，idle/Worker 最大 P95 为 8.805/10.330 ms，失败 0；[`fin01-api-idle.json`](../evidence/phase-01/fin01-api-idle.json)、[`fin01-api-worker.json`](../evidence/phase-01/fin01-api-worker.json)。Chrome 147 三个菜单每种条件 30 次，idle/Worker 冷 P95 最大 391/420 ms，热 P95 最大 133/128 ms；[`fin01-playwright-idle.json`](../evidence/phase-01/fin01-playwright-idle.json)、[`fin01-playwright-worker.json`](../evidence/phase-01/fin01-playwright-worker.json)。Worker PID 12300 在菜单窗口有 89 个 Job 成功、178 条 Job 更新。缓存数据首次可操作已测；后台权威刷新完成时间未测，不能把它并入热菜单指标。 |
| FIN01-09 回归与保护性断言 | C01-11、T01-25 | PASS_NEW | 全量 `npm test` 889/889；最后的小型 UI 请求防旧响应调整后，受影响的 `node --test test/ui-request-coordinator.test.mjs` 6/6、`npm run check`、`git diff --check` 通过，三个新增脚本 `node --check` 通过。新增来源重复提取与本地响应丢失回归，未删除旧断言。 |
| FIN01-10 分层判定 | C01-12 | PASS_NEW | 见文末最新七列结论，保留生产与历史未知事项的独立门禁。 |

### 故障细节与修复

受控正向来源使用非空路线文字、真实可解码 PNG 和当前 capture version。PNG 明确标为装饰性，不用它证明地理事实；唯一 Claim 的摘录来自文字。首次通过浏览器重新提取已处理来源时发现 `segment_source` 遇到已完成的全部当前分段，没有重新排入 `finalize_source_extraction`，来源停在 `processing` 且队列为空。修正 [`src/pipeline.mjs`](../../../src/pipeline.mjs) 后，同一浏览器合法重试进入 `processed`、50/50 Job 成功、无待处理 Job；数据库证据为 [`fin01-browser-recovery-fixed.json`](../evidence/phase-01/fin01-browser-recovery-fixed.json)。[`test/pipeline.test.mjs`](../../../test/pipeline.test.mjs) 增加重复提取不丢终态、不复制 Claim 的永久回归。

`test/visuals.test.mjs` 的“persisted transform candidate resumes only quality QA”断言母图变换只调用一次、QA 429 后仅重做 QA，并核对候选哈希与调用子阶段；`test/reliability-pipeline.test.mjs` 的并发输入修订测试拒绝晚到实体结果落库。新增 `test/local-delivery-receiver.test.mjs` 使用独立回环 HTTP 接收器：POST 已写本地 JSON 后主动断开响应，CMS 读回精确 post ID/status，`wordpress_publish_attempts` 的 unknown 状态阻止盲目第二次 POST，写入计数保持 1；这不等于真实第三方 exactly-once。[`fin01-migration-review-guard.json`](../evidence/phase-01/fin01-migration-review-guard.json) 中 Worker PID 7048 在服务启动前以 read-only 错误退出，queued Job attempts 仍 0，DB SHA-256 前后相同，模型调用 0；只读 inspect 成功。

旧七个 review 的聚合原因与状态转换可以核对，但没有旧 work DB 中每个段的完整 review reason 原始行，因此 FIN01-03 的逐行原因仍是 `NOT_RUN`。真实未知图片分析仍是 `QUARANTINED_UNRESOLVED`，没有以新 fixture 替换其历史状态。原坏快照与第一次失败演练副本保持原状；旧副本具体绝对路径未出现在现有脱敏证据里，本轮未扫描或删除它，也没有测试引用它。Worker 演练根 `cms-fin01-20260927-checkpoint-01`、`cms-fin01-20260927-complete-02`、性能根 `cms-phase01-bench-qsohHo`、最终异常页根 `cms-phase01-bench-Knq3aL` 保留在系统临时目录。一次早期只用于异常页截图的 `cms-phase01-bench-7Bjro8` 按原 benchmark 脚本退出时自动清理；发现后已改为 `--browser-hold` 保留后续 fixture，旧失败演练目录未受影响。所有测试进程已停止。

### 最新结论与停止点

| 判定对象 | 最新结论 |
|---|---|
| `phase01_local_capability` | `EVIDENCE_MISSING`：FIN01-03 每段真实 review reason、FIN01-07 真实 unknown/review 页面状态和原 T01 其余 `PARTIAL` 硬门槛仍未形成完整证据；已验证的 Worker 正向、故障保护及 PERF-005 指标分别通过。 |
| `original_archive` | `INVALID_PRESERVED`，继续按预期拒绝缺件。 |
| `repaired_archive_restore` | `VERIFIED_LOCAL_RESTORE`，不同于稳定生产可接管。 |
| `historical_sources_review` | 7 个来源进入人工 review；聚合上是材料覆盖不足的正确待审状态，逐段详细原因未取得。 |
| `unknown_realtime_request` | `QUARANTINED_UNRESOLVED`，预算与记录保留。 |
| `phase02_isolated_development` | `NOT_READY`，未进入阶段 02。 |
| `production_takeover` | `NOT_AUTHORIZED / NOT_READY`。 |

L1 Targeted Tests `PASS`；L2 Module Regression `PASS`；L3 Production DB Replay 复用旧隔离库报告、当前代码修复未在该历史库重放，故当前变更为 `NOT TESTED`；L4 Browser E2E `PARTIAL`；L5 Real Provider Canary `NOT REQUIRED`（本轮明确禁止真实请求）；L6 Full Production Replay `NOT TESTED`；Post-Fix Exploratory Audit `ISSUES FOUND`（重复提取状态机缺陷已修，历史逐段原因和 unknown UI 仍待证据）。

本轮只停止自己启动的 Worker、API 和 Chrome 测试会话；未修改阶段 02、未执行 commit/push/deploy。`current_authorized_step=NONE`，`phase_end_stop=true`。

## 2026-09-27 v1.2 当前态验收矩阵

本节只给出当前结论，不改写上方历史记录。历史 `PARTIAL` 仅表示当时缺证，不能覆盖本轮已核对或新增的本地证据。验收边界为 CMS 本地能力；真实外部系统、历史业务取证与生产接管分别列出。

本轮变更分类：`DATABASE_LOGIC + UI_ONLY + LOCAL_LOGIC`。未改变数据库 schema、AI Prompt、Provider transport 或生产数据。

| 原始用例 | 当前本地状态 | 当前证据与结论 | 外部/历史状态（不并入本地结论） |
|---|---|---|---|
| T01-01 | PASS_EXISTING_VERIFIED | release prepare/status/health/log、启动、端口冲突、幂等停止、版本/schema 输出已复核。 | 完整生产安装矩阵 NOT_RUN。 |
| T01-02 | PASS_EXISTING_VERIFIED | development/migration-review/stable 的数据根标识、错目录和无标识数据库拒绝已有回归。 | 真实迁移目录沿用只读历史证据。 |
| T01-03 | PASS_EXISTING_VERIFIED | migration-review 不启动写入 API/Worker，Job 不消费，DB 哈希不变。 | 生产迁移未授权。 |
| T01-04 | PASS_EXISTING_VERIFIED | 两个不可变 release、旧版存活和同一外部数据根切换证据有效。 | 生产容器切换 NOT_RUN。 |
| T01-05 | PASS_EXISTING_VERIFIED | 缺配置、端口冲突、停止、状态、日志、stale lease 显式解锁均有回归；本轮也实际重启验证。 | 其他 OS 服务管理器 NOT_RUN。 |
| T01-06 | PASS_EXISTING_VERIFIED | 单 API + 单 Worker 可共享数据库，重复角色拒绝；真实 Worker 正向、断点和重复唤醒证据有效。 | 多主机共享文件系统 NOT_RUN。 |
| T01-07 | PASS_EXISTING_VERIFIED | ADC 刷新合并、缺失 ADC、GCE metadata 和本地路由回归通过。 | 真实 Google 权限 ENV_BLOCKED。 |
| T01-08 | PASS_EXISTING_VERIFIED | 凭据刷新、缺凭据、429/Retry-After、冷却和失败分类回归通过。 | 真实 Provider 权限/付费 429 NOT_RUN。 |
| T01-09 | PASS_EXISTING_VERIFIED | 正确/错误/缺失主密钥、不可解密 Worker 阻断及设置页重录入口已复核。 | 真实密钥轮换 NOT_RUN。 |
| T01-10 | PASS_EXISTING_VERIFIED | v3 快照覆盖 DB/媒体/历史 JSON/业务指纹；修复快照 1219 文件/1592 引用通过。 | 原始快照 INVALID_PRESERVED。 |
| T01-11 | PASS_EXISTING_VERIFIED | 新目录恢复、路径重映射、schema 78→80、hash/MIME/业务指纹和离线投递探针通过。 | 原始损坏快照继续拒绝。 |
| T01-12 | PASS_EXISTING_VERIFIED | 媒体 lease、快照并发拒绝、原子发布和临时文件排除回归通过。 | 全生产并发压测 NOT_RUN。 |
| T01-13 | PASS_EXISTING_VERIFIED | 缺文件、错 hash/MIME、schema、空间预检、损坏拒绝和中断恢复均有回归。 | 真实磁盘故障注入 NOT_RUN。 |
| T01-14 | PASS_EXISTING_VERIFIED | 路径穿越、symlink、大小写冲突、POSIX→Windows 映射及重启续传通过。 | 第二套实体 OS 主机 NOT_RUN。 |
| T01-15 | PASS_EXISTING_VERIFIED | 同源/扩展 Origin CORS、未知 Origin 拒绝、安全头、移动视口和详情证据已复核。 | 实体手机/真实扩展/私有反代 NOT_RUN。 |
| T01-16 | PASS_EXISTING_VERIFIED | 未确认远端结果时禁止交接，lease/停机/显式解锁的本地安全边界通过。 | 真实双主机交接 ENV_BLOCKED。 |
| T01-17 | PASS_NEW | 真实媒体请求执行器生成 `outcome_unknown`；API/UI 显示待核、隔离、不重发，重启后预算仍 1/0/1/1，grant 拒绝回归通过。 | 历史真实请求 QUARANTINED_UNRESOLVED。 |
| T01-18 | PASS_EXISTING_VERIFIED | 独立 HTTP 接收端保存 JSON/图片，丢失响应先读回，CMS 停止后仍可读。 | 真实 WordPress/PHP 写入 NOT_RUN。 |
| T01-19 | PASS_EXISTING_VERIFIED | 外部依赖清单、只读能力和缺授权停止边界已复核。 | 未授权来源 NOT_RUN/ENV_BLOCKED。 |
| T01-20 | PASS_NEW | 系统健康改为 SQL 过滤/排序/`LIMIT/OFFSET`；105 条 API 回归为 20+20 无重叠、50+50+5 全唯一，浏览器实际切换 20/50。 | 新查询未跑当前生产副本，见 L3。 |
| T01-21 | PASS_EXISTING_VERIFIED | 分页、筛选保持、快速切页、晚到响应丢弃及浏览器交互证据已复核。 | 真实高延迟网络 NOT_RUN。 |
| T01-22 | PASS_EXISTING_VERIFIED | 隐藏页退避、返回刷新、不重叠、卸载停止和摘要惰性加载回归通过。 | 扩展后台生命周期 NOT_RUN。 |
| T01-23 | PASS_EXISTING_VERIFIED | 1,200 来源、约 10k Claims、300 草稿、3,200 媒体下真实 Worker + API/Chrome 30 次采样满足既定 P95。 | 真实 Provider 时延不含在指标。 |
| T01-24 | PASS_NEW | 429、usage/cost unknown、receipt loss、未知结果不继承旧 429、UI 不伪装成败和不加预算均有证据。 | 真实 Provider 账单 NOT_RUN。 |
| T01-25 | PASS_NEW | 25 个原始用例已逐项映射，且明确分开本地、外部、历史与生产边界；未改前端仓库或进入阶段 02。 | 生产接管未授权。 |

### v1.2 最小补证与永久回归

- 真实本地 Worker 使用正常来源与材料不足来源；后者经一次定向重试后形成持久化 `manual_review`，UI 不再把它误写成成功或明确失败，也没有再次自动重跑。
- 未知请求由真实 `createMediaRequestExecutor` 写入；重启前后 `spent=1, granted=0, limit=1, unknown=1`。
- 系统健康由 [`src/repository.mjs`](../../../src/repository.mjs) 数据库侧分页，前端 [`frontend/src/views.jsx`](../../../frontend/src/views.jsx) 请求当前页；API 日志记录 20 行/4 ms、50 行/4 ms、末页 6 行/6 ms。
- 永久回归见 [`test/server.test.mjs`](../../../test/server.test.mjs)、[`test/media-request-executor.test.mjs`](../../../test/media-request-executor.test.mjs)、[`test/frontend-localization.test.mjs`](../../../test/frontend-localization.test.mjs)。
- 数据集 ID、请求 ID、版本、命令和截图索引见 [`v12-local-closeout-20260927.md`](../evidence/phase-01/v12-local-closeout-20260927.md)。完整提示词已原样保存为 [`phase-01-closeout-v1.2.txt`](../phases/phase-01-closeout-v1.2.txt)。

### 当前分层结论

| 判断对象 | 当前结论 |
|---|---|
| `phase01_local_capability` | `PASS_LOCAL`：T01-01～T01-25 的本地能力均为 PASS_EXISTING_VERIFIED 或 PASS_NEW。 |
| `original_archive` | `INVALID_PRESERVED`：保留，验证器仍拒绝缺失文件的原始快照。 |
| `repaired_archive_restore` | `VERIFIED_LOCAL_RESTORE`。 |
| `historical_review_forensics` | `HISTORICAL_DETAIL_NOT_RETRIEVED / REAL_DATA_AUDIT_PENDING`：7 个历史来源逐分段原始原因未取回；本轮真实本地 review 已通过，该历史项不再冒充本地能力失败。 |
| `unknown_realtime_request` | `QUARANTINED_UNRESOLVED`：本地识别、持久化、UI、预算保护和拒绝盲目重发通过；真实远端结果仍未知。 |
| `phase02_isolated_development` | `READY_FOR_NEW_THREAD`：仅允许新开同目录对话，使用阶段 02 v1.4 完整提示词进入隔离本地开发；本轮未进入阶段 02。 |
| `production_takeover` | `NOT_AUTHORIZED / NOT_READY`：没有生产备份、迁移、写入、部署或接管。 |

### 风险分级测试报告

- L1 Targeted Tests: PASS — 50/50，以及 `npm run build`。
- L2 Module Regression: PASS — `npm test` 890/890；`npm run check` PASS；`git diff --check` PASS。
- L3 Production DB Replay: NOT TESTED — 新分页未在当前生产副本执行；105 条 schema 80 隔离夹具通过，历史只读生产副本证据保留，不能据此声称生产数据已验证。
- L4 Browser E2E: PASS — 真实本地 API + HeadlessChrome 147；正常来源、review、20/50 分页、unknown 隔离和 API 重启持久化通过；控制台 0 error / 0 warning。
- L5 Real Provider Canary: NOT REQUIRED — 未改 Provider/Prompt/Schema，模型调用 0。
- L6 Full Production Replay: NOT REQUIRED — 非正式发布，且本轮禁止生产接管。
- Post-Fix Exploratory Audit: PASS（隔离夹具）— active Job 0、FK violation 0、模型调用 0、review 未误重跑、unknown 预算未变化；历史逐段取证和真实远端 unknown 分别保留。

阶段01本地能力已验收通过，本轮已停止。历史逐段取证和未知实时请求仍独立保留，生产接管仍未授权。请新开同一CMS实际工作目录的对话，使用阶段02 v1.4完整提示词，只进入隔离本地开发。
