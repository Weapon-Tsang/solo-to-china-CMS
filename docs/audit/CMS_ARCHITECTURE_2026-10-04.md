# CMS 顶层设计与生产可靠性审查（2026-10-04）

状态：本地实现与分层验证完成。DEVELOPMENT 模式；未 commit、push、部署、执行生产迁移或写入正式 WordPress。

变更类别：PIPELINE / AI_PROVIDER / DATABASE_LOGIC。未修改数据库 schema。

## 架构判断

保留现有持久化任务、人工批准、冻结写作包和独立 QA 的主干。主要问题集中在调度公平性、外部调用与业务保存之间的断点、来源用途识别、冻结证据边界以及重复数据读取。直接重写整套系统会引入大量迁移风险，本次将这些共性问题收敛到共享入口。

```mermaid
flowchart LR
  A[人工采集与原件保存] --> B[预检与分段]
  B --> C[Claims 与 Coverage]
  C --> D[Experience 与 Knowledge]
  D --> E[机会与人工批准]
  E --> F[编辑选材与冻结写作包]
  F --> G[草稿与页面组合]
  G --> H[独立 QA 与定向修订]
  H --> I[媒体与交付门禁]
  I --> J[WordPress 草稿]
```

每次实际 HTTP 请求单独受额度控制并记录结果；模型输出先保存断点回执，再提交业务产物。恢复只复用输入和配置均匹配的结果。人工批准、明确生产 owner、版本校验、媒体出处与独立 QA 继续作为硬边界。

## 发现、修改与证据

| 问题 | 修复 | 已取得的证据 |
| --- | --- | --- |
| 持续入库可能让需要独占数据库的重建任务长期等不到空闲窗口 | 重建等待超过一分钟后停止补入普通任务，排空运行任务；保留更早的来源收尾任务优先权 | 定向回归及真实历史任务队列重放通过 |
| 错误使用 `Vertex Gemini`，调度读取 `vertex`，冷却失效 | 规范 Provider 标识；并发失败保留最长冷却时间 | 修复前复现；线上只读记录存在旧别名；修复后回归通过 |
| 旧 worker 失去租约后仍能影响当前限流状态 | 租约检查及持久化失败副作用放进同一事务 | 过期 worker 不再写冷却、诊断或修改任务 |
| 缓存命中被当成 Provider 恢复成功 | 保留缓存成本记录，跳过 Provider 健康状态更新 | 缓存命中不清除失败计数，不虚报成功时间 |
| 一次模型操作的内部纠错、Schema 降级可能产生多个 HTTP 请求，但只扣一次额度 | 四种适配器都在实际请求尝试处取得并结算许可 | 多次请求分别计数；额度耗尽在请求前拒绝；真实图片请求及缓存复用通过 |
| 限流等待忽略取消；排队期间出现的新冷却没有再次检查 | 等待可取消；每次等待后重新检查限流；取消排队不占用请求额度 | 取消、排队顺序、新冷却及无 AbortSignal 场景通过 |
| 图片格式纠错遇到额度等待后可能丢失纠错反馈 | 第一次调用无额度时继续让任务排队；已有响应的内部纠错保留反馈等待额度，仍受预算与取消控制 | 重试携带纠错信息；每次真实请求有独立回执；等待时间不计入 Provider 延迟 |
| 规划、写作和 QA 保存失败后可能重复购买同一模型结果 | 扩展持久化模型步骤回执到覆盖审核、蓝图、诊断、选材、规划、叙事、草稿、页面、审核和修订 | 重启注入测试通过；3 篇真实历史文章、2 个来源诊断在保存失败后各只使用一次模型输出 |
| 编辑专用素材被缺口恢复识别成未完成的研究来源 | 统一排除仅供编辑使用的来源和文章内手动上传图片 | 历史副本的误报从 7 个来源 / 12 个动作降为 1 个真实缺口 / 6 个动作；6 个素材来源不再被补跑 |
| 写作证据去重只保留前三项，可能删除不同票种、日期或条件 | 保留不同语义条件及证据角色；只压缩等价佐证 | 5 种不同条件均保留；31 项含重复的证据缩为 4 项而保留新增条件；真实写作 Canary 保留周末预约条件 |
| 冻结包明确没有路线或事实时，后续流程仍可能借用实时知识 | 草稿、审核依赖与交付读取都尊重冻结空值；损坏的事实快照明确报错 | 新回归先复现旧行为；修复后不借用后来出现的路线或事实 |
| 图片出处校验重复读取同一来源正文、图片上下文 | 按来源合并只读校验；同次同步文章读取共享结果，跨任务、编辑或异步操作不复用缓存 | 同一真实文章 ABBA 对比输出哈希完全一致，平均耗时下降 49.3%；冲突、撤销、版本变化、跨连接与事务回滚回归通过 |

## 性能和成本测量

单篇真实历史文章的数据读取，按图校验对比按来源合并校验，交替运行顺序为前/后/后/前；每次使用独立只读数据库连接。

- 按图校验：5,802 ms、6,733 ms，平均 **6,268 ms**。
- 合并校验：3,016 ms、3,340 ms，平均 **3,178 ms**。
- 平均减少 **49.3%**。四次完整结果均为 1,457,738 字节，SHA-256 均为 `ecdb6fb83fbab61657334fa18409c68983e500283ad1ca9ccc9291276c4a6909`。
- 这是一个真实文章样本的本地对比，不代表全站吞吐或生产 p95 已提高 49.3%。
- 断点重放证明可以避免重复购买已经返回的模型结果；素材来源排除可以避免错误启动额外研究流程。
- 不报告未经账单核对的美元节省。历史调用中存在大量未知成本记录。

## 数据来源与隔离

只读来源为已有本地生产恢复：`C:/s01-restore-20260927/solo-to-china.sqlite`。恢复清单的快照 SHA-256：`e5dede046d15aebf212280c3ec3b5c68fba8a0adeb15dfd81cbf641fd20956ae`。该恢复中最新任务记录是 2026-09-23，不能视为当前线上全量状态。

从此来源建立不可变 baseline，再建立一次性 work 数据库。初始两份 SHA-256 均为 `7bab63440e205d8689fb6a8534c92c46ce19e96889ddf67b68ab28cc8620d05c`；完整性及外键检查通过。只在 work 副本上使用当前 schema。

历史基线含 84 个来源、1,454 个资产、5,334 个 Claims、4,404 个 Knowledge facts、1,425 个机会、12 篇草稿、18,415 个任务和 6,453 条模型调用记录。

生产只读补充检查时间为 2026-10-04 00:51（Asia/Shanghai）：91 个来源，其中 82 个 processed、6 个 media_only、3 个 manual_article_stored；当时无 queued/running 任务、无 processing 且没有活动任务的来源、无未批准 owner 的活动生产任务。旧 Provider 别名记录仍在线上，只有发布本次代码后新的失败记录才使用规范标识。

未创建生产备份或快照，未在生产执行恢复、回填或数据库写操作。

## 风险分级验证

| 层级 | 状态 | 真实覆盖范围 |
| --- | --- | --- |
| L1 Targeted Tests | PASS | 队列、费用许可、取消、冻结空值、条件证据、媒体合并读取；关键回归先复现再修复 |
| L2 Module Regression | PASS | Pipeline 组 73 项；Provider 组 102 项；媒体/冻结/恢复组合 64 项；Content 组 47 项；各组有重叠，不累加宣传总数 |
| L3 Production DB Replay | PASS | 历史真实副本的缺口与队列重放；6 个实际缺失分段任务在 work 中正确入队后回滚；3 篇文章与 2 个诊断断点重放；真实文章完整输出一致的性能对比 |
| L4 Browser E2E | PASS | 本地界面登录 → 内容 → 重试失败审核 → 人工确认 → 审核 → 正确定向修订；后端注入保存失败并重建执行器，模型只调用一次、正文与版本不变 |
| L5 Real Provider Canary | PASS（限定范围） | Vertex 固定短文本、带条件的写作包、固定授权原图；验证结构输出、条件保留、真实请求、额度回执和零额外请求的缓存复用 |
| L6 Full Production-Like Replay | PASS（受控流程） | 2 个固定来源从 Capture 到 Claims/Coverage、Experience/Knowledge、Opportunity/人工批准、规划、Draft/QA、模拟 WordPress；legacy、article bundle、editorial v2 及两种重启恢复，共 5 条路径 |
| Post-Fix Exploratory Audit | PASS（执行范围内） | 检查旧租约、重复请求、缓存健康、错误恢复用途、孤儿分段任务、owner、capture version、冻结上下文与媒体冲突；新发现纳入回归 |

L6 的模型输出和 WordPress 是受控替身，媒体质量结果为固定测试数据；它验证流程连接和业务不变量，不能单独证明真实内容质量。本次因此同时使用 L3 真实副本、L4 实际操作及 L5 少量真实 Provider 验证。完整线上来源库逐篇重新生成、所有 Provider 的真实重试、生产 WordPress 写入和上线后的长期指标：**NOT TESTED**。

第一次真实 Canary 因本机代理未被 Node 使用而失败，保留失败记录。启用现有代理后短文本与写作通过。图片调用最初验证一次，在异步许可改动后又验证一次；累计 5 次网络尝试（1 次传输失败，4 次成功生成），所有批处理关闭。最新图片调用输入 3,337 tokens、输出 656 tokens、Provider 延迟 5,698 ms；缓存读取没有新增实际请求。

历史副本另有 1 个真实来源缺少 6 个分段提取结果。本地恢复已证明会正确补入对应任务，未调用模型填造结果，也未对线上执行该恢复。71 个来源的 261 个旧 Experience blocks 全部属于 superseded 记录，没有被当成当前成功结果。3 篇文章及 2 个诊断重放前后的草稿、Knowledge、任务和回执联合指纹相同，回滚保留完整数据。

## 复查入口

代码入口：`src/repository.mjs`、`src/pipeline.mjs`、`src/ai/request-control.mjs`、四种 Provider 适配器、`src/ai/content-engine.mjs`、`src/repositories/media-bindings.mjs`。

新增常规低成本测试组：`npm run test:fast`、`npm run test:architecture`、`npm run test:pipeline`、`npm run test:content`、`npm run test:providers`。`npm run test:architecture-replay` 只运行受控本地全链路，不调用付费 Provider。Canary 脚本必须显式启用，未接入普通测试命令。

本地证据均位于 `output/architecture-audit-20261004/`：

- `live-readonly.json`：当前线上只读概览。
- `replay-final.json`：历史来源缺口、排队动作和独占任务重放。
- `real-recovery.json`：真实文章/诊断的保存失败与重启复用。
- `package-profile.json`、`package-benchmark.json`：耗时定位与等价输出对比。
- `browser-backend.json`、`browser-after.txt`、`browser-after.png`：界面恢复和后端结果。
- `canary.json`、`canary-proxy.json`、`canary-media.json`、`canary-media-final.json`：包括首次失败在内的真实调用记录。
- `controlled-full-chain/`、`controlled-full-chain.log`：5 条受控全链路的阶段、回执和 owner 证据。
- `pipeline-final.log`、`providers-accepted.log`、`media-freeze-regression.log`、`content-final.log`、`dispatch-final.log`、`check-accepted.log`：回归及构建结果。

验收结论仅适用于本地改动与上述覆盖范围。尚未部署，不能将这些结果表述为线上失败率、全站吞吐或账单金额已经改善。
