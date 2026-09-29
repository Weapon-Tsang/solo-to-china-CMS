# 来源排队与覆盖重建阻塞调查

2026-09-29 17:53 此两文件补丁已发布生产，最终验收见 coverage-production-release-20260929.md。以下为按阶段保留的调查记录；早期“未发布”及部分测试状态已由后续记录取代。

## 后续完整重放结果

已完成本次“继续”的验证工作，未发布生产代码。L1/L2 PASS（35项）；npm run check PASS。L3 PASS（本次确定性覆盖重建及WordPress无变化同步范围）：归档生产boundary的schema79来源保持只读，将一次性work库迁移至83后运行完整重庆rebuildCoverageMatrices。任务、模型调用、知识事实、来源族成员、草稿五表逐行哈希前后一致；共1336条内容机会，624条适用来源族投影校验，与未修改的旧算法逐条比较计数和指纹PASS，712条按既有类型/冻结规则跳过。对副本中12条真实WordPress清单重复同步，新任务数0，PASS。

验证过程说明：初次工作库未迁移而被schema检查拒绝；随后对比程序一次读取全表触及1536MB上限，已改为逐行哈希。合并验证在重建、五表校验后触及600秒限时，剩余投影检查单独执行并通过（92.5秒），未重复执行重建。重建阶段0.5CPU，最终检查阶段提升至1CPU；因此不能宣称与生产耗时做了等条件完整基准比较。旧/新3条只读样本对比仍为19.5秒/3.5秒。没有一个完整单进程PASS退出码，但拆分后的必要断言均已完成；证据见output/extension-connection/coverage-replay-result.json及服务器/opt/solo-to-china/replays/coverage-20260929中的replay.log、audit.log、inventory.log。

L4 NOT TESTED（未上线后的真实浏览器流程）；L5 NOT REQUIRED；L6 NOT TESTED（正式发布全流水线）；Post-Fix Exploratory Audit ISSUES FOUND：生产原重建自然结束后，新来源的extract_source/preflight/segment/finalize已成功，source=processed，experience阶段自动三次尝试后以DeepSeek输出token/context上限失败。未手工重试付费模型，未将其误报为排队。此AI失败不由本次两文件补丁解决。

生产只读证据：2026-09-29 16:52:10 WordPress inventory同步启动，16:52:13.524成功读取12条文章清单。replaceWordPressInventory原先无条件给全部目的地enqueue rebuild_topics。重庆父任务job_51815f0ee9934ae1991c8c1189d134b0于16:52:13.537创建，随后生成rebuild_topic_clusters及build_coverage_matrix（job_7672868abc794cbd94e096e943a20488）。后者16:52:35开始，17:09仍running。长沙新来源src_00f770704f8d4635ab3b4a5fe53f963a的extract_source在16:53:14创建且attempts=0。

claimJob明确排除任何数据库重任务运行期间的所有其他作业；这不是普通并发配置问题。重庆1336条内容机会、3413条知识事实。重建逐条selectedFamilyProjection调用completedOpportunitySourceIds，生产只读单次约3212ms，单条projection约4306ms；子进程CPU约97%。保留独占规则以避免未经验证的并发写入冲突。

本地修复：manifest无关；仅repository与family evidence模块。WordPress清单比较site/post/title/slug/status/url/modified字段，忽略同步时间；内容相同时仍更新同步状态和原有publication reconciliation，但不创建全目的地重建。实际变化仍保持既有重建行为。覆盖重建每次创建一个短生命周期来源资格/来源族context，批内复用、下次重建重读；指纹算法不变，无全局缓存。

验证：L1/L2 PASS，共34项相关测试（25项knowledge/family，9项WordPress/topic）。固定20次projection只执行1次来源资格查询，跨DB context拒绝，下一context反映来源族变化。L3 PARTIAL：既有生产boundary.sqlite只读副本抽查重庆3条，新旧完整输出与指纹一致，未缓存19507ms，共用context3472ms。没有运行完整rebuildCoverageMatrices工作副本重放，标为NOT TESTED。L4 NOT TESTED；L5 NOT REQUIRED；L6 NOT TESTED；Post-Fix Exploratory Audit局部PASS（调度独占保留、WordPress发布/取消发布与内容变更回归），生产全量相邻审计NOT TESTED。

未部署、未重启Worker、未取消或修改生产Job、未重试模型、未写WordPress、未git提交推送。现有慢任务不会因为本地修复自动改变。仍需完整覆盖重建工作副本重放、正式发布验证后才能发布此服务端修复。
