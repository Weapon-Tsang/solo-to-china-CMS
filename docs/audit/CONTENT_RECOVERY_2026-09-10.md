# 内容恢复与建议数量排查

requirementsVersion=1.3；status=in_progress；基准 HEAD=812ec76。

## 线上只读核对

`/api/recommendations?limit=500`：74条建议，74个不同来源；文章候选66、需补研究5、仅知识库2、低价值1。
人工决策：待处理54、批准文章16、先研究2、仅知识库1、忽略1。
底层机会269条：授权改编121、跨来源综合75、专题73；237条ready。
状态：recommended232、ignored2、knowledge_only4、research_required15、qa_failed13、producing2、drafted1。
不同实体及不同读取时点的状态不能混用，机会数量不是文章数量。

## 数量形成与准入

saveIntakeAnalysis用sourceId哈希作为建议ID，每个来源固定保存一条分析建议；没有按潜力评分先过滤。
主机会之外还写入多个production_paths；机会key含sourceId，不同来源相近选题仍是独立记录。
article_potential、information_density、topic_completeness、duplicate_likelihood在此路径不是硬门槛。

素材准备度以关键词匹配required/important槽位，covered和dated都计入覆盖。
基础分＝必需覆盖率×75＋重要覆盖率×25；再加min(事实数,10)、减dated槽位数、减冲突槽位数×8，上限100。

- 授权改编：非冲突事实≥3，至少命中1个必需槽位。
- 窄题专题：非冲突事实≥4、必需覆盖≥50%、来源家族≥1。
- 多来源综合：必需槽位全部覆盖、来源家族≥2。
- 以上均要求冲突槽位为0，正式生产仍须人工确认。

这只是素材准备门槛，不检查每个大纲承诺、页面完整性、图片可交付性及逐句事实支持。
前置门槛偏宽和同题重复候选可能放大返工，但不是400/403等故障的直接原因。

## 本地修复与未验证事项

新增恢复面板/API，支持指定阶段执行、原图对应原文、已采集授权图预览绑定、
人工正文/台账/备注修订、无规划候选的归属修正。保留历史，拒绝活动任务与陈旧修订竞争。
修正历史QA显示、实际队列阶段、阻塞优先展示、编号加说明的核验备注匹配、6A等出口标识与daytime切词。
媒体/页面问题不再自动触发正文改写；逐张保存上传进度；改写请求不带完整媒体二进制字段。
没有调整或删除74条建议/269条机会，没有重跑线上草稿。

测试：基线358/358；新增恢复测试9/9；最终npm test 367/367；npm run check与git diff --check通过。
隔离SQLite覆盖只读报告、定点入队、活动任务与陈旧版本拒绝、历史QA隔离、
素材原文与绑定、人工修订保留历史及不入队、嵌套事务回滚。

断点：尚未做浏览器端到端、目的地修正完整集成及手动阶段流水线回归、发布检查。
本地代码尚未提交、推送、部署；付费模型、真实重采集和WordPress交付未验证。
下一步完成入口端到端验证再发布；不要把当前367个本地测试通过写成线上异常已清除。

## Final local workflow release checkpoint

The earlier 367-test checkpoint above is historical. App 1.17.25 / Strategy 1.9 now adds shared proposal approval/freeze, version-guarded batch decisions, honest object counts/coverage, scoped plan references, separate prose/delivery QA and upgrade-safe historical preservation.
Final offline release gate: 50 required checks passed, 0 failed; full suite 379 passed. Browser desktop isolated approval flow passed (3 sources, 6 paths, exactly 3 approved, 0 production jobs with absent evidence). Real mobile device, real paid model, recapture and production WP remain unverified.
No old 403 or genuine factual gap is declared fixed by a UI/code test. The common recovery entry supplies source URLs, authorization/retained-byte status, editorial correction and explicit named-stage actions. See EXECUTION_LOG.md for commit/deployment checkpoint.

## Deployed result

App 1.17.26 / Strategy 1.9 deployed from ab30840; verified pre-upgrade system snapshot and healthy persistent database. Final gate: 380 tests, 50 mandatory checks, no failures. All 17 production recovery endpoints returned 200 (one sample median 1.216 s); the prior timeout case returned in 1.285 s after eliminating whole-workspace recomputation from a single draft read.
The 28 historical exception rows remain deliberately auditable; external missing media and genuine factual gaps still require the deployed correction workflow. No paid production job or WordPress write was triggered by this verification. Full-list content read in the same sample took 8.733 s, so further whole-list latency work must be measured separately rather than claimed fixed.
