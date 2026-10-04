# CMS 历史生产中断审计与流程验证

本轮发现并在本地修复了三处遗漏：实体归一写入冲突、标题业务校验失败后缺少有界纠错、明确余额不足的错误归因不准确。另修正了只读审计脚本未加载运行配置导致的阶段误判。未部署、未提交或推送，未修改生产数据库、生产队列或 WordPress。

变更分类：**DATABASE_LOGIC / PIPELINE / AI_PROVIDER**。线上状态不是“全部恢复”：仍有两篇活跃文章的配图阻塞、两个来源缺少当前版本 Experience，以及一个尚无后续成功记录的标题任务。

## 审计范围与逐条记录

生产数据库通过 SQLite `mode=ro`、`query_only` 和只读事务读取，未执行完整备份。最新历史导出时间为 **2026-10-04 02:25:18（北京时间）**。另交叉读取已有的本地生产历史副本，以及现存生产/回滚容器保留的日志。没有日期截断或条数上限。

- 36 张相关表；20,489 条 Job，其中 1,264 条目前标记 failed。
- 7,005 条模型调用、384 条失败诊断、146 条 failure lessons、131 条归档尝试、15 条回滚记录。
- 153 条媒体 dispatch、13 个 Batch run、539 个 Batch item、546 条输出关联异常。
- 40 个容器保留的 18,088 行日志，包括 1,524 条结构化警告/错误及 3 条非结构化错误记录。
- 合并为 **6,232 条可追溯证据记录**。这些记录相互重叠，包含自动降速、鉴权拒绝和质量门禁，**不能称为 6,232 次独立生产事故**。

本地证据位于 `output/interruption-history-20261004/`：

| 文件 | 用途 |
|---|---|
| `history-ledger.jsonl` | 每条证据的原始 ID、阶段、错误、时间、归类、当前关联 Job 状态、处理结论、代码与回归测试位置 |
| `signature-review.json` | 相同阶段/错误签名汇总，保留每条原始记录 ID |
| `history-summary.json` | 全量数量与覆盖范围 |
| `live-history.json` / `retained-history.json` | 线上只读导出和历史副本导出；不含模型凭据、完整正文或模型输入输出 |
| `runtime-history.json` | 容器运行状态及保留的诊断日志 |
| `live-production-configured.json` | 按线上实际功能配置读取的生产状态与恢复入口 |
| `exploratory-audit.json` | 当前缺口、归属、孤儿任务、遗留产物与待处理项 |

分类没有剩余未分配记录，但**不等于原因全部已知**：75 条证据行只保留空白/粗略原因，另有 442 个执行次数大于一次的任务找不到保留的失败原因。多次执行也可能是主动让出执行权或 Batch 轮询，不能将这 442 个任务直接判为失败重试。同一故障可能另有完整证据；被轮转删除的日志和早期覆盖掉的错误不能凭推测补写。现有 `failJob` 已逐尝试保存失败诊断，本轮保留这一机制。

## 新修复及生产证据

### 1. 实体归一时相同键值导致整批失败

18 个失败 Job、29 条数据库诊断、2 条容器日志包含 `UNIQUE constraint failed: claims.source_id, claims.normalized_key, claims.value_text`，共 49 条证据。

同一来源的两个主张可能值相同、条件或引用不同。原逻辑将它们改成同一个 canonical key 时触发唯一约束，中断实体归一及下游知识整理。

修复：写入前检查实际约束冲突；冲突时保留原主张键，同时更新实体身份。不会删除其中一个主张，也不会覆盖引用、条件或证据 ID。不同主张仍保留各自知识键，不能把该修复描述为“所有重复事实已合并”。

验证：永久回归先复现原错误，再验证同值不同条件和重复执行。已有生产副本中 **38 份真实实体模型回执各重放两次**，其中 8 份关联历史 SQLite 失败，全部通过。仅在一次性 work 数据库内操作，逐次回滚；主张、Knowledge、草稿、WordPress、Job、回执联合指纹前后相同。真实 Provider 调用 0 次。

相关代码：`src/repository.mjs`；测试：`test/entity-resolution.test.mjs`；证据：`entity-replay.json`。

### 2. 标题 JSON 合法但业务不合格时直接终止

9 个失败 Job、9 条诊断、9 条容器日志，共 27 条证据。最新失败发生于北京时间 2026-10-04 00:00:59，Job 为 `job_f90875c47df54507a8ee0b55d4c5de6a`。

问题包括遗漏 opportunity、引用别的机会的事实键，以及标题退化为通用信息列表。Provider 的 JSON schema 通过后，本地业务校验仍失败，原逻辑直接结束，人工重试又没有携带修正要求。

修复：仅 `INVALID_OPPORTUNITY_TITLE` 获得一次携带校验反馈的纠错机会；最终仍必须通过原来的严格校验。最多两个业务生成结果，不放宽证据要求。402、超时等请求失败不进入内容纠错。并发相同输入共享最终校验结果，纠错成功结果可缓存，避免重复购买。底层协议兼容/结构修复仍遵守各自上限，不把“两个业务结果”误称为所有情况都只发送两个 HTTP 请求。

验证：缺项、错误事实键、模板化标题、二次仍失败、402、并发合并及缓存回归均通过。固定 6 个线上机会的真实 Vertex Canary 使用 **1 次请求**得到 6 个合格标题：26,056 输入 tokens、1,321 输出 tokens、9,244 ms；重复调用命中缓存，新增请求 0。真实请求未触发纠错分支，该分支由故障注入测试覆盖，不宣称已真实触发。

相关代码：`src/ai/client.mjs`、`src/ai/content-engine.mjs`；测试：`test/interruption-history.test.mjs`；证据：`title-canary.json`、`title-canary-output.json`。

### 3. 明确余额不足被当作普通生产失败

历史 DeepSeek Job `job_e4e3d543ea884b5daa63590069e3a7f2` 返回 `402: Insufficient Balance`，相关证据 4 条。原说明没有指出计费阻塞，容易诱导无效重复执行。

修复：明确 402 / 余额不足 / 计费停用归为配置问题，说明应先核对对应服务计费，再恢复失败步骤；普通 429 仍归为容量压力，不推断余额不足。

验证：永久回归和本地浏览器页面均显示正确原因。此修复改善归因，并不充值或保证外部账号当前可用。

相关代码：`src/services/content-recovery-policy.mjs`；证据：`billing/browser-billing.txt`、`billing/browser-billing.png`。

### 审计工具误判的修正

直接构造 `Repository` 会默认关闭可选生产功能。旧检查脚本没有像服务器那样配置 capabilities，曾错误地漏掉配图阶段，并把恢复目标指向正文复核。

`scripts/audit-live-production-state.mjs` 新增 `--runtime-config`，在运行容器中读取实际功能配置；离线副本则按持久化产物推断。没有启动应用、后台任务或联网适配器请求。重新只读核验确认，两篇活跃文章的线上恢复目标本来就是 `generate_visuals`，未把审计脚本的问题当作产品故障修改。

## 其他历史原因逐类结论

下表数字为证据行，可能来自同一个故障；逐条 ID 见 ledger。代码和测试的映射表示覆盖位置，不表示本轮每一个映射测试均重跑。

| 原因族 | 证据行 | 审查结论 |
|---|---:|---|
| Batch 输出关联 | 1,078 | 历史无输出/未知 transport key；现有关联、隔离与实时回退测试通过，不重新提交整个旧批次 |
| 限流/容量 | 971 | 429、配额、MEDIA_RATE_WAIT；保留有界退避、每次请求计量，不当作图片质量失败 |
| 原始媒体访问 | 956 | 包括过期来源链接 403；缺原图须恢复正确原图，不反复请求失效链接 |
| 输出/上下文预算 | 459 | 已有输入引用压缩、实体分页缩小、输出溢出停止同输入循环；两个历史 Experience 结果仍未补齐 |
| Provider schema | 313 | 保留兼容路径和本地校验；本轮标题真实 schema 接受，未逐一真实重测所有 Provider |
| 结构化输出 | 185 | 有界修复与校验；错误输出不可作为成功缓存 |
| 网络/超时 | 125 | 重试前区分请求结果不明、已完成响应和可安全重试 |
| 图片质量 | 114 | 文字、标签、遗漏等实际质量问题，不能为提高成功率强制通过 |
| 内容质量 | 109 | 证据、事实值、正文结构门禁和有界修订继续保留 |
| 数据库争用 | 101 | 旧并发写入/锁等待；队列、事务与持久化断点回归覆盖；未从通用 SQLite 错误推断锁争用 |
| 媒体交付 | 89 | 必需媒体/manifest/交付校验仍是阻塞条件 |
| 媒体选择/预算 | 80 | 无相关图或预算耗尽不能当作正常完成 |
| 页面合同 | 74 | 按当前 Frontend Contract 校验和重编排，不绕过合同 |
| 实体键冲突 | 49 | 本轮修复，真实历史回执重放通过 |
| 已替代/旧输入 | 39 | superseded 等状态属于历史失效，不重复计作当前中断 |
| 范围/归属 | 30 | 目的地、生产 owner、已发布刷新范围门禁保留 |
| 商业组合过期 | 28 | 从当前页面重新组合；不使用旧组合覆盖新正文 |
| 标题业务校验 | 27 | 本轮增加一次有界纠错 |
| 外部结果不明 | 19 | 先核对精确 dispatch，不盲目重发或删除记录 |
| 历史回滚 | 15 | 已记录的回滚事件；不能算新的生成错误 |
| 未收尾 artifact 标记 | 8 | 6 条后续 Job 成功、2 条旧诊断已标为确定性复用替代；无活跃任务，不据此启动收费重跑 |
| 编辑输入边界 | 8 | 媒体上下文/用途约束，避免错误插图 |
| 采集页中断 | 5 | 页面关闭、frame removed；现有页面重试及暂停/恢复测试通过 |
| 明确计费问题 | 4 | 本轮修复错误说明；账号状态需外部核对 |
| 图片格式 | 3 | 已有 WebP 等格式处理，不降低媒体完整性要求 |
| 合同快照键冲突 | 1 | 已有复合身份规则与相关回归 |
| 认证拒绝 | 1,148 | 登录/采集令牌边界，不等同于内容生产失败 |
| 自动降速/恢复控制事件 | 118 | 运行控制日志，不等同于新的中断 |
| 字体环境警告 | 1 | 历史警告，未证明导致当前致命退出 |
| 留存不足 | 75 | 原因不足，保留未知状态，不硬判已修复 |

## 当前仍需处理的真实状态

只读检查得到 19 个唯一生产 owner：14 个已完成/已投递、2 个需要处理、3 个历史记录（2 个归档、1 个删除）。原始草稿表的 5 个 `needs_review` 不能直接当成 5 个当前生产阻塞。

1. **人民大礼堂文章**：`opportunity_404fe8f839bcdc3a1feb3678`；`MEDIA_DISCOVERY_NO_RELEVANT_IMAGE`。当前恢复目标是配图。仍缺可通过图片内容核验的相关原图；不能用无关图片代替，也未宣称库中绝对不存在可用图。
2. **重庆步行文章**：`opportunity_0ad2ce3a8a6125aa07ee8be4`；`VISUAL_QUALITY_QA_FAILED`。当前恢复目标是配图。路线图片存在标签/翻译/位置问题，原质量拒绝必须保留。
3. **两个长沙来源缺当前版本 Experience**：`src_6dc34bb235f94932be6587cd906ce317`、`src_00f770704f8d4635ab3b4a5fe53f963a`，均 capture version 2。最后失败是 DeepSeek `MODEL_OUTPUT_LIMIT`，没有后续成功回执。相关输出预算与引用压缩代码于 9 月 30 日已有修复；这不代表旧数据自动补齐。未收费重跑或写生产恢复任务。
4. **一个最新标题失败**：`job_f90875c47df54507a8ee0b55d4c5de6a` 没有后续同阶段成功。上述本地修复尚未部署，该历史失败没有被改成成功。
5. **一个遗留媒体结果不明 dispatch**：`bc3eda67-f65a-47c4-b82a-adde1b6d41e2`。保存了完成时间的旧识图超时；现有代码已有预算内恢复能力，未在生产强行清除状态或重复请求。

重庆动物园与罗中立美术馆的两个失败文章已归档，归档记录应保留。另一个原始 `needs_review` 草稿已有 WordPress 草稿投递基线，不能仅据该字段回滚整条生产链。

91 个来源中 82 个 processed、6 个 media_only、3 个 manual_article_stored；2,366 个分段记录均 complete。但 processed 并不保证 Experience 已完成，所以另外逐一核对 capture version。活跃 queued/running Job 为 0、processing 且无活跃任务的来源为 0、活跃孤儿分段任务为 0、未批准 owner 的活跃生产任务为 0、重复活跃任务组为 0、重复生产 owner 为 0。

## 测试与验收边界

| 层级 | 状态 | 实际覆盖 |
|---|---|---|
| L1 Targeted Tests | PASS | 最终定向 24 项；新回归先复现再修复；`npm run check`、Python 语法检查和 diff 检查通过 |
| L2 Module Regression | PASS | 变更相关组合 65 项；生产流程/Batch/媒体预算/合同/状态组合 72 项；采集恢复与 Experience 预算组合 33 项。各组有重叠，不累加宣传总数 |
| L3 Production DB Replay | PASS（限定范围） | 38 份真实实体模型回执，重复应用和回滚指纹验证；最新线上历史只读扫描。没有在整个最新数据库上重新生成所有内容 |
| L4 Browser E2E | PASS | 本地登录 → 内容 → 重试失败复核 → 确认 → 恢复 → 定向修订；模型响应后注入提交故障，重建执行器后只调用模型一次、正文不变、下游只创建一次。另验证余额不足页面说明 |
| L5 Real Provider Canary | PASS（限定范围） | 固定 6 个线上标题输入，Vertex 1 次真实请求、结构与业务校验、缓存复用。其他 Provider、真实二次纠错和图片重制：NOT TESTED |
| L6 Full Production-Like Replay | PASS（受控流程） | Capture → Claims/Coverage → Experience/Knowledge → Opportunity/人工批准 → Assembly/Plan → Draft/QA → 模拟 WordPress，legacy、article bundle、editorial v2 及两种重启恢复，共 5 条路径 |
| Post-Fix Exploratory Audit | ISSUES FOUND | 两篇配图阻塞、两条缺 Experience、最新标题失败、一个遗留结果不明媒体调用；历史原因留存不足单列 |

L6 使用受控模型输出及模拟 WordPress，验证流程连通与不变量；不能替代真实内容质量。**全库真实 Provider 端到端重生成、生产 WordPress 写入、两个旧 DeepSeek 失败来源的真实恢复、线上部署后的长期失败率和费用变化：NOT TESTED。** 构建只有现有大 bundle 体积提示，没有构建错误。

## 可重复执行

- `npm run test:interruptions`：故障、实体、缓存、标题和内容恢复定向组，默认不调用真实 Provider。
- `npm run test:interruption-replay -- output/interruption-history-20261004/history-work.sqlite`：仅允许专用 output 目录中的 work 副本，重放真实回执后回滚。
- `npm run audit:interruptions -- output/interruption-history-20261004`：从已有只读导出重建逐条 ledger，不连接生产。
- `python scripts/audit-interruption-invariants.py output/interruption-history-20261004`：从导出数据检查当前缺口。
- `scripts/canary-interruption-titles.mjs` 默认关闭；需要显式开关、短期凭据，串行、禁用 Batch、最多 2 次请求。

生产数据恢复和部署不属于本轮 DEVELOPMENT 授权范围。保留这些真实待处理项，而不通过修改状态、放宽质量门禁或重跑全库来制造“全部成功”。
