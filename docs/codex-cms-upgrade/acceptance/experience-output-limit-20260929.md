# 体验提取输出限制修复（开发验证）

变更类别：AI_PROVIDER / LOCAL_LOGIC。当前请求为修复，没有新的生产发布授权；不修改生产 Job，不部署、不提交或推送 Git。

## 实际故障

来源 src_00f770704f8d4635ab3b4a5fe53f963a，capture version 2：生产三次 experience_extraction 输入均 52309 token，输出均 12000 token，reasoning_tokens 均 12000，finish_reason=length。应用 config/model-stage-policy.json 将体验提取 maxOutputTokens 配为 12000，DeepSeek Client 将其作为 max_tokens 发送。三次相同参数未产生合格结构化结果。

## 用户确定的修复原则

不以人为压低输出 token 或降低体验质量控制费用。最终方案移除 DeepSeek 请求的 max_tokens，保留原 LOW 思考模式；有效 policy 的 maxOutputTokens=null，反映采用提供商默认行为。未把默认值伪装为无限输出：DeepSeek 自身的模型、上下文及服务默认边界仍存在。其他提供商未在本次改动中调整。

依据：[DeepSeek Chat Completions 官方文档](https://api-docs.deepseek.com/api/create-chat-completion/)与[思考模式文档](https://api-docs.deepseek.com/guides/thinking_mode/)。费用控制针对重复证据引用、无效结构修复和相同固定上限错误的重复调用。

## 实现

- DeepSeek completeJson 不再发送 max_tokens，保留正常思考；配置哈希反映有效策略。
- 仅 DeepSeek 体验输入将长 segment/claim/span/media ID 替换为短引用；所有证据正文、顺序及条数保留，模型返回后恢复原 ID。映射为单次请求独立映射，碰撞检查与无损往返测试覆盖。
- 给体验提取提供完整 JSON Schema，包含枚举与可选路线结构；不要求压缩体验细节或限制输出 token。
- 修复通用校验器对 nullable:true 的处理：未知 region/duration 的合法 null 不再触发付费修复；非空错误类型、必填字段、enum/const 约束仍校验。
- 体验请求若仍触及提供商自身的输出边界，失败明确终止，不再自动用相同输入和参数执行三次付费请求。未触发任何历史失败重试。

## 实验记录

1. 初始关闭思考试验：2 次调用。首次生成 10670 token，但枚举/路线结构不合格；修复请求在 12000 token 截断。此方案已撤回。
2. 短引用与完整 Schema 试验：2 次调用。输入从约 52K 降到 35743 token；两次均正常 stop，输出 11383 token，但本地校验器误拒绝 nullable region，发现并修复。此试验仍关闭思考，非最终方案。
3. 保留 LOW 思考、不发送 max_tokens 后：一次调用生成 26243 token（思考 18503、最终结果 7740），正常 stop、Schema 通过；15 个体验块有一处 span ID 混入 Claim ID 字段，严格 grounding 检查 FAIL，未判为验收通过。短引用随后改为显式 segment/claim/span/asset 类型标识。
4. 最终方案：一次调用 PASS，输入 38453 token、输出 26639 token，其中思考 14335、最终输出 12304；耗时 78720ms。13 个体验块所有 segment/claim/span 引用均匹配输入；路线归一化通过，四天 21 地点、17 连接。离线重放逐一比较四天地点顺序，并验证 City walk、周一闭馆、预约、19:00 亮灯及三天两晚替代方案保留。未丢弃任何输入 Claim 或证据，输出未发生截断。

总计真实调用 6 次（2+2+1+1），单并发，每轮最多 2 次，不循环扫描来源库。最终验收覆盖这篇固定 16 图片来源的已提取文字与 263 条 Claim/263 条证据，不代表所有来源的体验质量均已验证。仅隔离测试目录写入；生产库只读打开以读取已配置凭据，未启动 Worker，也未把测试输出写回生产。

## 最终验证状态

- L1：PASS，69 项定向/provider/schema/frontend 回归。
- L2：PASS，37 项路线、provider schema、体验持久化及下游语义回归。
- npm run check：PASS。
- L3：NOT REQUIRED，无 SQL/schema/历史数据改写；使用生产来源完整输入做模型 replay，未把 fixture 宣称为全库重放。
- L4：NOT TESTED，本次未发布/未进行真实浏览器流程。
- L5：PASS，固定真实失败来源单次请求完成，Schema、引用、路线顺序及重点条件检查通过。其他 Golden Sources：NOT TESTED。
- L6：NOT REQUIRED，当前非正式 Release；全生产流程未重放。
- Post-Fix Exploratory Audit：ISSUES FOUND，历史中两篇来源存在 experience 输出限制失败，当前 2 篇 processed 来源没有同版本成功体验结果；另有 destination_entity_resolution 等历史失败，不能宣称本次修复已覆盖这些阶段。

证据在 output/experience-*；真实生产输入与模型响应仅存工作输出目录，不纳入源码或公开交付附件。

## 生产发布更新

2026-09-29 代码已发布到生产，详见 [生产发布验收](model-cost-production-release-20260929.md)。历史失败体验任务未因本次代码发布自动重跑。
