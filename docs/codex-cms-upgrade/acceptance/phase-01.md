# 阶段 01 验收记录（v1.4）

**结论：IN_PROGRESS / NOT ACCEPTED。** 原始要求保存在 [`../phases/phase-01.txt`](../phases/phase-01.txt)。本表是执行状态，不缩减原文中的硬要求。`PARTIAL` 表示只验证了列出的部分；`NOT TESTED` 不等于通过。没有据此授权迁移或停用旧主机。

环境：Windows，Node v24.14.0、npm 11.9.0；仓库 `Weapon-Tsang/solo-to-china-CMS` 的起始 `main` HEAD `e9f7c8e82ff760f4d18f2d2e0673452eb8744290`。改动未 commit/push。测试只使用隔离目录和合成数据。详细命令与证据见 [`../evidence/phase-01/local-validation.md`](../evidence/phase-01/local-validation.md)。

| 要求 | 状态 | 已完成和主要缺口 |
|---|---|---|
| LOC-001 基线 | PARTIAL | 核实唯一仓库、remote、HEAD 与工作树；未执行完整迁移前基线。 |
| LOC-002 模式隔离 | PARTIAL | development 身份标记拒绝生产/无标记 DB；migration-review API/Worker 禁写；待真实历史 DB 副本复验。 |
| LOC-003 数据分离 | PASS_LOCAL(CMS_ONLY) | `CMS_DATA_ROOT` 外置；临时源码副本移走后稳定 release API 仍健康；更新代码/重装依赖生成第二 release 时旧 API 仍可用，切换后保留同一数据集。 |
| LOC-004 启停诊断 | PARTIAL | `local:prepare/stable/status/stop/logs/unlock/inspect/promote` 存在，停止幂等、端口冲突有测试；最新代码已重跑隔离 release/API health/同数据根切换演练，完整安装与启动异常矩阵未验。 |
| LOC-005 单主协调 | PARTIAL | 同一根目录 API+Worker 共存、重复角色拒绝；跨文件系统/跨主机条件未验证。 |
| LOC-006 Google 认证 | PARTIAL | ADC 与 GCE metadata 分支及并发刷新 mock PASS；真实权限未验。 |
| LOC-007 主密钥 | PARTIAL | 正确/错误/缺失密钥的本地安全阻断及密文保留 PASS；重录流程未做 UI 验收。 |
| LOC-008 数据盘点 | PARTIAL | 多类文件根、DB 明确路径列、未晋升视觉候选，以及来源/历史采集 JSON 中的 `localPath`、`storagePath`、原图/衍生图引用纳入快照；其他潜在 JSON 键和真实历史路径尚未审计。 |
| LOC-009 一致快照 | PARTIAL | SQLite `VACUUM INTO`、部分媒体 lease、已存 DB SHA-256 与文件字节交叉校验；普通采集分块原子落盘且重试不可覆盖，快照排除尚未提交的 `.tmp` 分块，来源清理保护视觉候选引用。全部写入/清理者和主线程延迟未验。 |
| LOC-010 manifest | PARTIAL | v3 清单增加关键业务行指纹，保留 v2 读取；文件哈希、DB 引用、schema、retention、回滚字段已核对；历史格式和全部用途字段未穷尽。 |
| LOC-011 可移植恢复 | PARTIAL | 新目录恢复、明确存储列及历史采集 JSON 文件路径重映射、旧清理队列重映射、schema 检查、空间预检及符号链接/大小写防护；跨 OS 实测未做。 |
| LOC-012 恢复业务核对 | PARTIAL | v3 清单记录来源、版本、Job、知识、草稿、视觉候选、WordPress 映射、Provider Batch/调用的关键列全行指纹，恢复后复核；另有哈希、DB 完整性、外键、媒体可打开、演练和直接恢复启用前的已知 MIME 文件头核对、离线草稿交付探针。真实历史数据及远端映射对账未做。 |
| LOC-013 多设备访问 | PARTIAL | CORS 仅接受同源或 `CAPTURE_ALLOWED_ORIGINS` 明确配置的扩展来源；未知来源的预检/写请求拒绝测试 PASS。私有代理、Host/CSRF 全流程、扩展权限和移动设备 UI 尚未 E2E。 |
| LOC-014 换主机交接 | PARTIAL | 只读交接检查列出运行中 Job/未决投递；提升要求旧主机停用确认并阻断未对账状态；实际双机交接未演练。 |
| LOC-015 只补缺口 | PARTIAL | 未决远端状态可识别并阻断提升；按 ID 自动对账及断点续跑未完成。 |
| LOC-016 独立交付 | PARTIAL | 独立 HTTP 接收器在 CMS 关闭后仍能提供 JSON/图片；真实 WordPress/PHP 未验。 |
| LOC-017 外部依赖 | PARTIAL | 未知资源如实列于外部依赖清单；无真实合同、账单或设备核对。 |
| LOC-018 说明与版本 | PARTIAL | 本地运行说明、状态版本/schema 输出可用；迁移操作手册仍需补齐。 |
| PERF-001 服务端分页 | PARTIAL | 来源/知识/内容主列表 SQL 分页，异常列表批量查找降到 12 SQL；异常集合仍由 JS 汇总/分页。 |
| PERF-002 路由状态 | PARTIAL | 来源页切菜单和 20→50 条浏览器 smoke PASS；筛选/迟到响应未全验。 |
| PERF-003 预取与轮询 | PARTIAL | 请求协调/隐藏页退避、返回刷新与不重叠定向测试 PASS；后台失焦、慢健康检查 E2E 未验。 |
| PERF-004 API/Worker 分离 | PARTIAL | 进程角色与租约、合成非空 API 基准；Worker 负载下的延迟未验。 |
| PERF-005 可复现基准 | PARTIAL | 1000 来源、10k claims、300 drafts、3000 media、50 系统故障；API 各路 30 次及 Chrome 三个菜单冷/热各 30 次，在 idle 与 CMS Worker＋合成只读/CPU 并发负载下均保存原始样本；真实 Worker 执行业务负载未测。 |
| PERF-006 耗时/费用 | PARTIAL | 模型尝试计量、未知价格为空、429/未知传输结果、确定性错误不继承旧 429 的定向测试 PASS；全阶段耗时和真实账单对照未验。 |
| LOC-019 范围与接续 | PARTIAL | 仅 CMS 仓库改动、提示词与证据落盘；旧阶段证据映射未全面复验。 |

## 25 个用例

| 用例 | 状态 | 当前证据及缺口 |
|---|---|---|
| T01-01 | PARTIAL | 独立 release prepare、release 内 status、API health 200、logs PASS；完整安装/启动矩阵未验。 |
| T01-02 | PARTIAL | 错误 development 数据根、缺生产库的本地拒绝 PASS；真实生产目录替身与 Worker 门禁待复验。 |
| T01-03 | PARTIAL | migration-review 含 queued/running Job 的只读检查，DB 哈希不变；真实历史库及外部调用监控未验。 |
| T01-04 | PASS_LOCAL(CMS_ONLY) | `node scripts/verify-local-release-isolation.mjs`：移走临时源码后启动 release，准备更新版时旧 API 保持 200，更新版启动后数据库身份不变；见 `release-isolation.json`。 |
| T01-05 | PARTIAL | 端口冲突、停止两次、安全日志 PASS；缺依赖和全部启动异常未验。 |
| T01-06 | PARTIAL | API+Worker 与重复角色租约测试 PASS；负载/跨主机未验。 |
| T01-07 | PARTIAL | ADC 与 metadata mock PASS；真实云运行未验。 |
| T01-08 | PARTIAL | ADC 并发刷新、缺凭证 mock PASS；真实错误权限与 429 行为未验。 |
| T01-09 | PARTIAL | 正确/错误/缺失加密主密钥本地测试 PASS；后台重录 UI 未验。 |
| T01-10 | PARTIAL | WAL、多类媒体、v3 manifest、独立列和历史采集 JSON 引用、DB 媒体指纹交叉检查及 v2/DB-only 旧格式测试；全部潜在引用未盘清。 |
| T01-11 | PARTIAL | 异目录恢复和独立列/历史采集 JSON 路径重映射、v3 关键业务行指纹复核、哈希、已知 MIME 文件头检查、离线草稿探针；真实历史业务 ID/远端映射全量对账未做。 |
| T01-12 | PARTIAL | 媒体 lease 冲突、采集分块原子提交/重复上传冲突、快照排除未提交临时分块测试 PASS；全部媒体写入路径/事件循环延迟未验。 |
| T01-13 | PARTIAL | 缺图、坏哈希、manifest 少列 DB 引用、schema 新旧隔离、空间不足预检测试 PASS；真实盘满/部分归档完整矩阵未验。 |
| T01-14 | PARTIAL | 路径穿越、符号链接、大小写碰撞、POSIX 路径在 Windows 恢复、复制中断后同快照续恢复 fixture PASS；另一 OS 和真实盘满未验。 |
| T01-15 | PARTIAL | 精确 CORS allowlist、未知扩展 Origin 的预检/写请求拒绝本地 HTTP 测试 PASS；私有访问/扩展/移动端完整流程未验。 |
| T01-16 | PARTIAL | 未确认旧主机停用及运行中任务阻断提升 PASS；实际交接/重启未验。 |
| T01-17 | PARTIAL | Batch/远端不确定状态被只读列出并阻断提升；按 ID 对账与断点续跑未实现。 |
| T01-18 | PASS_LOCAL(CMS_ONLY) | 独立 HTTP 接收器保存交付 JSON/图片，CMS 关闭并删本地图片后仍可读取；真实 WP 单列 `NOT TESTED`。 |
| T01-19 | PARTIAL | 未知外部资源清单如实记录；真实资源访问未获验证。 |
| T01-20 | PARTIAL | 非空数据集分页及异常批量查询测试；异常仍非 SQL 级分页。 |
| T01-21 | PARTIAL | 来源页切菜单、翻页、改 page size 浏览器 smoke；迟到请求取消/忽略单元测试 PASS；筛选失效 E2E 未验。 |
| T01-22 | PARTIAL | 隐藏页轮询退避、可见时刷新、不重叠和销毁后不恢复单元测试 PASS；后台/失焦/慢模型健康 E2E 未做。 |
| T01-23 | PARTIAL | 同代码/合成数据的 API idle/loaded 各路 30 次见 v8/v7 报告；Chrome 来源/知识库/内容菜单在 idle/loaded 下冷/热各 30 次见两份 browser 报告，冷 P95 idle/loaded 为 270/285、344/351、404/364 ms；真实 Worker 业务负载未测。 |
| T01-24 | PARTIAL | 模型账本 unknown 不冒充 0、429 保留 HTTP 状态/请求 ID、图片变换失败不伪造候选、确定性布局错误不继承旧 429 的 mock 回归 PASS；真实 Provider/账单仍未验。 |
| T01-25 | PARTIAL | 仅 CMS 工作树、无前端仓库修改；旧 CMS 证据映射待核。 |

## 2026-09-27 真实数据与外部系统增量验收

阶段结论仍为 `IN_PROGRESS / NOT ACCEPTED`。生产 v2 快照来自已有备份，通过 IAP 只读取得；原始归档、解压基线均在 Git 仓库外。数据库 `quick_check=ok`，schema 78。对这份快照执行完整 `verifyBackup` 时，5 条派生图引用指向同一个未归档文件，校验按预期拒绝；没有放宽完整快照门槛，也没有以数据库完整性代替系统可恢复性。旧 v2 清单遗漏但归档中存在的来源存储引用及视觉候选引用可通过确切归档路径重建；专门回归证实缺失文件仍会失败。真实快照未做完整恢复演练。

真实数据的只读相邻问题审计发现：84 个来源中 1 个 processing 来源无活动来源 Job；18,415 个 Job 中 1,205 个 failed，66 个 failed 缺 failure class；父 Job 孤儿数和生产 Job 缺 owner 数均为 0。证据见 [`../evidence/phase-01/production-snapshot-audit.json`](../evidence/phase-01/production-snapshot-audit.json)。这些是已有生产数据状态，不计作本地代码修复通过。

真实 Vertex Gemini 固定短文本 canary：1 次请求抵达 Provider，结构化 schema 被接受，1,796 ms，输入 115 tokens、输出 12 tokens，`24h/free` 语义返回正确。Batch list API 只读查询成功；未提交真实 Batch。证据见 [`../evidence/phase-01/vertex-canary.json`](../evidence/phase-01/vertex-canary.json)。未知 Batch 提交结果的隔离和精确输入 URI 对账已通过本地模拟；远端提交后崩溃恢复仍未实测。

本轮 `npm run check`、相关 77/77 定向测试及 `git diff --check` PASS。没有 commit、push、生产部署、生产数据库写入或 WordPress 写入。

随后完成生产快照数据库的可写一次性副本重放：迁移到 schema 79 后，现有来源缺口恢复 dry-run 找到 7 个可处理来源缺口（6 个缺少分段、1 个缺少抽取），执行阶段准确排入 12 个 Job。来源、资产、claims、知识、草稿、WordPress 映射和模型调用记录数量保持不变，没有 Provider 调用或 WordPress 写入。证据见 [`../evidence/phase-01/source-gap-replay.json`](../evidence/phase-01/source-gap-replay.json)。这验证了该恢复路径在真实历史数据库上的排队行为，但由于快照缺媒体，不能代替完整系统恢复和后续 Worker 完成链。公开 WordPress/文章页面只读核对见 [`../evidence/phase-01/public-runtime-audit.json`](../evidence/phase-01/public-runtime-audit.json)；公开文章字段和样本媒体尺寸可见，认证写入与 PHP 版本仍未验证。

验收分级（本轮）：L1 `PASS`；L2 `PASS`；L3 `PARTIAL`（真实数据库副本缺口恢复排队 PASS；完整快照恢复与 Worker 完成链未测）；L4 `PARTIAL`（此前来源页 smoke）；L5 `PARTIAL`（短文本真实 Provider PASS，多图/Batch 故障路径未测）；L6 `NOT TESTED`；Post-Fix Exploratory Audit `ISSUES FOUND`。

追加检查：`npm run local:inspect` 对一次性工作库返回完整性 `ok`、外键违规 0，同时发现 1 个 `analyze_source_image` 的 `outcome_unknown` 媒体投递，按现有安全门槛禁止稳定模式提升。它不是可通过视觉 QA 专用对账接口清除的类型；没有远端回执时未更改其状态。Playwright CLI 在合成数据集上实际操作来源第 2 页、来源详情、关闭详情及 20→50 每页切换，详见 [`../evidence/phase-01/browser-pagination-interaction.md`](../evidence/phase-01/browser-pagination-interaction.md)。完整 `npm test` 886/886、`npm run check` PASS。L4 仍为 `PARTIAL`，因为真实跨设备采集和恢复 UI 未覆盖。

移动视口补测：390×844 的 Chromium 页面中，六项后台菜单可操作，来源→内容→来源切换、来源卡片详情与关闭均通过；截图见浏览器交互证据。未在物理手机或采集扩展上执行配对与上传，因此 T01-15 仍为 `PARTIAL`。

性能与 schema 增量：真实副本剖析发现异常页耗时主要来自扫描含大量原始正文的来源表，以及失败 Job 的后续成功关联查询。schema 80 新增两个索引；真实工作库从 79 迁移至 80 后 `quick_check=ok`、外键违规 0，异常结果仍为 7 条，单次页构建从 1,469 ms 降至 44 ms。定向迁移/恢复/部署门槛回归通过；完整 `npm test` 887/887、`npm run check` PASS。证据见 [`../evidence/phase-01/exception-index-replay.json`](../evidence/phase-01/exception-index-replay.json)。变更类别增加 `DATA_MIGRATION`；L3 对索引迁移 `PASS`，完整系统快照恢复仍 `NOT TESTED`（真实旧快照缺文件）；L6 `NOT TESTED`。异常页仍由 JS 聚合后分页，PERF-001 保持 `PARTIAL`。生产 schema 未迁移。

真实副本在 schema 80 上进一步执行 30 次只读重复测量，异常页构建 P50 18.204 ms、P95 19.707 ms，7 条结果稳定；原始样本见 [`../evidence/phase-01/exception-30-samples.json`](../evidence/phase-01/exception-30-samples.json)。此数值不含 HTTP、浏览器和 Worker 负载。

合成 Worker 负载补测：独立 Worker 进程与读/CPU 负载进程同时运行，完成 69,100 次查询。来源、知识、内容、异常、摘要五条 API 各 30 次 P95 分别为 3.921、7.788、7.616、2.716、5.747 ms；事件循环延迟 P95 15.172 ms。原始样本见 [`../evidence/phase-01/worker-load-20260927.json`](../evidence/phase-01/worker-load-20260927.json)。业务模型/媒体任务并未执行，PERF-004/005 仍为 `PARTIAL`。

## 风险分级

变更类别：`DATABASE_LOGIC / PIPELINE / AI_PROVIDER / LOCAL_RUNTIME`。L1 定向测试 `PASS`；L2 模块回归 `PASS`；L3 生产 DB 副本重放 `NOT TESTED`；L4 浏览器 E2E `PARTIAL`（来源分页 smoke）；L5 真实 Provider Canary `NOT TESTED`；L6 完整生产式重放 `NOT TESTED`；Post-Fix Exploratory Audit `ISSUES FOUND`（异常查询、旧清理队列、未决远端对账等）。没有将 mock 或测试数量解释成生产已验证。

### 2026-09-24 LOC-009 / T01-12 补充证据

手动来源、来源媒体、视觉输出和旧视频上传分块/成品已改为完整写入后原子发布。快照跳过未提交的 `.tmp`、来源恢复临时目录和未完成 `.part`，保留旧视频已提交的暂存分块。定向回归见 `../evidence/phase-01/local-validation.md`。LOC-009 与 T01-12 仍为 `PARTIAL`：所有媒体清理者的跨进程并发和真实 Worker 负载下的主线程延迟尚未验证。

## 2026-09-27 定向收尾补充

详见 [阶段 01 定向收尾映射与决策](phase-01-closeout.md)。原表历史状态保留；修复演练快照恢复通过，但原快照仍损坏，真实图片分析投递仍未知。阶段 01 本地能力与阶段 02 准入保持 `BLOCKED`。
