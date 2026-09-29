# 模型调用费用优化：开发验收

状态：已实施并完成下述验证，尚未发布生产。用户本轮请求为“实施”，按 AGENTS.md 属于 DEVELOPMENT。未运行 Cloud Build、生产迁移/回填/任务重试、WordPress 写入或 Git 提交推送。

变更分类：AI_PROVIDER / PIPELINE。无 schema 变化，后续发布属于 CODE_ONLY_RELEASE。

## 最终实现

1. 图片请求公共上下文只携带来源正文、完整性信息和图片 ID；逐图完整 metadata/document locator/occurrence/segment/hash 只在对应图片前发送一次。manifest 不再重复 nearby/alt。保留所有原始正文块与逐图证据，没有截短文本、删除图片或合并不同图片的身份。
2. extract_segment_claims、extract_media_batch、extract_source_experience 使用已有 pipeline_step_receipts 保存成功返回的模型结果。业务提交失败后可恢复结果，不重复付费；输入、模型策略、输出校验值变化时拒绝复用。没有新增全局跨来源缓存。
3. 持久化记录的配置身份改为读取任务冻结的提取路由，避免误用写作模型或当前设置的配置。提取 Router 提供实际 artifactContract；请求格式有版本标记。
4. DeepSeek 在自身有限结构修复耗尽后，INVALID_MODEL_OUTPUT 标为不原样重跑；MODEL_OUTPUT_LIMIT 同样不原样重跑。429/网络故障继续按现有退避机制处理，多图批次仍可拆成不同输入恢复。
5. 保留上一任务完成的“DeepSeek 不发送 max_tokens、体验短引用、完整 Schema、nullable 校验修复”。没有为节省费用降低体验思考强度或设置新的输出 token 上限。

这不意味着把七张不同图片当成一张，也不保证请求结果尚未持久化前的进程终止可以无损恢复。外部模型与数据库之间不是原子事务；持久化记录完成后的恢复才受本次机制保护。

## 生产来源副本测量

来源 src_6dc34bb235f94932be6587cd906ce317（截图中的七张图）。既有生产只读归档 boundary.sqlite 复制为独立 /opt/solo-to-china/replays/model-cost-20260929/work.sqlite；仅工作库迁移到当前 schema 并写测试记录。生产库未写。

| 重放路径 | 请求数变化 | 文字字符数变化 | 说明 |
| --- | --- | --- | --- |
| 七图合批 | 1 → 1 | 18794 → 10731 | 减少约 42.9% |
| 七图逐图（当前 DeepSeek 调度方式） | 7 → 7 | 27260 → 19503 | 减少约 28.5% |

逐图证据对象和公共正文块逐项深比较一致。以上是输入文字字符体积，不是 token、图片推理成本或总账单下降比例。

同一工作副本验证了结果记录跨 Repository 实例重载、capture 变化拒绝命中、配置变化拒绝命中。回归测试另通过真实 SQLite 模拟 segment/experience 模型成功后业务提交失败，换一个 Pipeline 恢复后总模型调用仍为 1；体验结果成功持久化并创建 resolve_entities 下游。

## 真实模型验证

固定同来源的一张图，单并发，最多两次请求。实际仅一次 DeepSeek 调用，成功返回 26 条 Claim，全部图片/片段 ID 匹配；输入 2939 token，输出 3154 token，延迟 9927ms。没有向生产保存结果或更新任何 Job。

仅这个固定图片场景做了真实 Provider 验证。其他图片、其他 Provider 真实调用：NOT TESTED。mock 图片/文本请求入口与证据一致性通过定向回归，不能替代所有模型语义质量验证。

验证过程中，初次 replay 对 JSON 转义后的整段文本使用错误字符串断言，改为正文块深比较后通过；初次 canary 缺少实际 sourceUploadsDir，模型请求数为 0，补齐测试路径后一次成功。未为这些测试失败重复付费调用。

## 分层验收

- L1 Targeted Tests：PASS。
- L2 Module Regression：PASS，合计 49 项（图片上下文/API、缓存、持久化恢复、artifact、路由、体验输出及重试策略）；npm run check PASS。
- L3 Production DB Replay：PASS，以上七图来源输入与持久化记录范围；未重放整库业务流水线。
- L4 Browser E2E：NOT REQUIRED，本次没有 UI 修改；生产浏览器链路未重测。
- L5 Real Provider Canary：PASS，仅上述固定一张图；此前体验提取案例结果见 experience-output-limit-20260929.md。
- L6 Full Production Replay：NOT REQUIRED，本次非正式发布；Capture→QA 全流程未执行。
- Post-Fix Exploratory Audit：ISSUES FOUND。新回归确认输入/配置变化不会错误命中、429 仍可重试、成功结果不被限流失败污染、恢复继续下游。此前生产历史中的体验/实体解析失败未被本开发任务改写；不能宣称生产失败均已解决。

证据：output/model-cost-regression.log、output/model-cost-check.log、output/model-cost-validation/replay-result.json、output/model-cost-validation/canary-result.json。源图/响应明文仅保留于测试输出目录，不纳入源代码。

## 生产发布更新

2026-09-29 已发布。生产镜像 `sha256:4f85ae895d0b7745a0607b65178ff78df9066f4c1721cf376e2812a98827579f`。发布范围、回滚信息及未验证项目见 [生产发布验收](model-cost-production-release-20260929.md)。上述开发阶段状态保留作历史记录；历史失败任务未批量重跑。
