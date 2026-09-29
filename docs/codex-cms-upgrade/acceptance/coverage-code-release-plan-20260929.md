# 覆盖重建与清单无变化跳过：发布方案（已执行）

2026-09-29 17:53 已按用户后续明确授权发布。最终结果、异常恢复及未验证范围以 coverage-production-release-20260929.md 为准。以下保留发布前方案记录。

本次是CODE_ONLY_RELEASE：src/repository.mjs和src/opportunity-family-evidence.mjs的确定性逻辑修改，无schema或历史数据转换。此次“继续”先完成验证与可审查的发布方案；没有执行镜像构建/推送或生产替换。

发布内容：一次重建内复用来源完成状态和来源族映射；WordPress文章清单无变化时不创建全目的地选题重建。保留数据库重任务独占约束、发生变化时的既有刷新行为，以及原发布状态对账流程。扩展的其他未提交修改不应夹带进本次服务端镜像。

发布前条件：35项定向回归和npm run check已PASS；完整工作副本覆盖重建、家族指纹逐条比较和无变化WordPress清单副本验证须成功。AI体验提取token上限不属于这两处确定性逻辑修复，不能将此发布宣传为解决AI失败。

正式发布时：基于现有不可变2.0.72镜像与经过验证的两文件补丁构建一次不可变候选镜像，记录文件哈希与镜像digest；不重跑schema迁移、全量数据库备份或GCE snapshot。保留旧API/Worker和环境文件，暂停并确认在途Worker状态后切换，保留CMS_STARTUP_RECONCILIATION_ENABLED=false。核对readiness、两域名、既有三个扩展允许来源以及队列进展。失败切回同schema旧镜像；不得自动重试历史AI失败任务或写入WordPress。

没有授权git commit/push，因此这两步不属于本方案自动操作。完整重放只在工作副本进行，生产来源不被作为试验库。
