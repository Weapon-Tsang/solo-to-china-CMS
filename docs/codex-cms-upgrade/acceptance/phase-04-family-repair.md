# 2026-09-29 来源族计数定向修复

## 最终结果：2.0.72 已发布到原云端生产

**2026-09-29 12:52:10（北京时间）发布完成；schema83，策略3.9。** 唯一维护窗口从12:44:40至12:52:10，450秒（7分30秒），未超过批准的15分钟，没有生产回滚或第二次构建。API、Worker使用下文同一固定镜像；原域名 [CMS](https://engine.solotochina.com) 与 [采集入口](https://capture.solotochina.com) 的 readiness 均为HTTP200、`ready=true`、version2.0.72。

六条正式修复分别为14→12、3→2、18→17、31→30、24→23、3→2，仅改两个获批来源族计数字段。正式预览指纹 `99ff31599ba2992ba56279841c075011a0c86c8aa7c602d14c82017d5bd419e0`；首轮changed=6，执行器内第二次apply断言changed=0通过（结果文件的 `idempotent:false` 描述首轮实际发生变更，不表示二次幂等测试失败）。六条仍为recommended、未批准、未绑定candidate。停机后的完整门禁与上线后只读复验均为hardViolationCount=0、integrityViolationCount=0。

上线前后来源84、source_assets1454、Claims5465、草稿12、Jobs19382、model_call_metrics6535、media_dispatches58均相同；所有受保护内容指纹、媒体SHA及生产环境文件SHA对照通过。Jobs为failed1230/succeeded18152、queued/running=0；相对于准备时固定副本，没有新增模型调用，未新增Canary或重发历史失败。正常Worker已恢复，沿用既有预算，未来正常业务消费仍可能产生正常费用，不能把此次观察写成永久免费。

后台只读GET覆盖health、ready、dashboard、sources、recommendations、content、exceptions、maintenance、commercial，全部200。浏览器真实审批操作在隔离环境通过，生产没有为了验收再执行一次审批或生成。旧失败/证据缺口仍保留：完整审计范围内134个EVIDENCE_GAP、31个readiness=0、7个未完成来源；UI总览的140个证据缺口属于更广口径，不能与134直接相减认作新增故障。原未知媒体投递未重投。模型健康仍显示历史 `MODEL_OUTPUT_LIMIT` 降级，最后失败记录为2026-09-28T20:14:40.714Z；历史费用未知，不宣称这项独立模型问题已解决。封面/正文独立刷新仍按接续指令保持关闭，未修改独立前端仓库或向正式WordPress写入。

| 验收层级 | 最终状态 | 实际覆盖 |
|---|---|---|
| L1 Targeted Tests | PASS | 来源族独立预期、写入/准入/修复边界、只读收件箱、部署顺序及失败传播 |
| L2 Module Regression | PASS | 应用1118项测试、50项离线强制门禁；后续宿主机probe 6项测试及两次PR CI通过，数量不累加 |
| L3 Production DB Replay | PASS | 留存同源库及当前生产只读副本，79→83、精确六条修复/幂等、保护指纹、完整门禁及恢复演练 |
| L4 Browser E2E | PASS | 隔离登录→建议→批准→立即移出收件箱；另有生产只读API/公网验收 |
| L5 Real Provider Canary | NOT REQUIRED | 未修改模型/Prompt/transport；未主动发起真实模型测试 |
| L6 Full Production Replay | PASS（离线范围） | 固定fixture真实Pipeline至QA和mock WordPress，legacy/article_bundle_v1两路径；当前整库发布演练及正式发布门禁 |
| Post-Fix Exploratory Audit | PASS（定向范围） | 上线后完整机会审计零硬违规、数据/任务/模型调用对照；上述历史独立问题保留 |

**NOT TESTED：** 真实模型产出质量、历史生产来源实际Capture→QA全链、正式WordPress写入、用户Chrome扩展安装/真实小红书采集、SEO排名效果。离线L6通过不扩大为这些外部验收通过。

旧容器 `engine-before-b65794b`、`engine-worker-before-b65794b` 已停止并保留，旧镜像、上轮快照和失败库全部保留。当刻一致数据库位于 `/opt/solo-to-china/upgrades/b65794b42bc25d11ca92e0f21e31456e72eaabb3/boundary.sqlite`，SHA `f4bd035c5dff61b42825dae3fb897df0eca916cc0e34f9ab4c444aa3d72b64db`，与本次已完整恢复演练的媒体快照配对。公开服务后禁止自动用它覆盖后续新写入。开机metadata已改为仅核对固定镜像并启动已验证容器，不重复迁移/启动补排；回读与本地字节一致，SHA `2048b3cd31a9bb705347776658434f7bf095145d23fc35ae9f93dfec31d300ed`，未为测试重启VM。原startup脚本私有留存。

扩展2.0.72已打包至 `output/phase04-cloud-extension-2.0.72.zip`，默认入口capture.solotochina.com，保留用户已存token且不内嵌凭据；SHA `3e823097bfda6a469c2fc30a83e05b68ff6c0471ef9fb64fb2728dac68e6edd3`。未操作用户浏览器profile，安装状态NOT TESTED。

机器证据：[发布结果](../evidence/phase-04-family-repair/production-release-result.json)、[上线后数据对照](../evidence/phase-04-family-repair/postflight-result.json)、[上线后审计/API](../evidence/phase-04-family-repair/post-release-summary.json)、[公网](../evidence/phase-04-family-repair/public-endpoints.json)、[测试范围](../evidence/phase-04-family-repair/validation-scope.json)。诊断中的Python默认UA公网403已用正常Node客户端确认两个域名200；只读副本伴随文件问题通过不可变只读提取摘要解决，两者都不涉及修改生产业务数据或放宽业务门禁。

`current_authorized_step=COMPLETE`；本次有限发布完成，下面未授权/停止描述均为历史记录。

## 有限发布授权后的执行记录（覆盖下文历史停止点）

用户已回复“批准”，同意文末具体计划中的提交/推送/必要合并、一次 Cloud Build、六条两个字段修复、最多15分钟维护以及成功/回滚后的 API 与 Worker 恢复及既有正常生产费用。候选版本2.0.72，schema83，策略3.9。不得追加第二次构建、提高模型预算、重发历史失败或写正式 WordPress。

旧流程的完整备份/恢复演练约18分钟，不能原样放入15分钟维护。因此先在现行生产数据库只读来源副本上，以准确候选镜像离线执行完整备份、恢复演练、迁移、修复和完整业务审计。生产卷只读挂载。维护开始后保存当刻数据库；媒体引用及字节必须与已完整验证/恢复演练的备份一致，六条记录与依赖必须与预检一致，否则中止。当前数据库（包括准备期间的新合法任务/内容）与已验证媒体备份配对保留，不以准备前数据库覆盖增量。正向步骤最多600秒，保留300秒用于未公开时回滚；候选容器超时必须先停止，再恢复库。

新增 `prepare-family-release.mjs`、`family-release-boundary.mjs` 及真实离线 probe 回归验证：准备之后的业务更新能跨迁移失败/回滚保留，媒体同名同大小篡改、引用变化、记录/依赖/批准变化均拒绝。只导出既有备份模块的只读媒体引用收集函数，没有改变日常备份行为。

固定应用镜像构建后，首次维护计时演练在副本完成边界备份227秒、迁移164秒、六条修复41秒，但独立审计容器将副本目录只读挂载，SQLite无法创建伴随文件（ERR_SQLITE_ERROR 14），因此未通过，未触发生产维护。演练目录改为可创建伴随文件，审计程序仍保持 readOnly/query_only；调整仅限一次性副本。另将部署 probe 的备份库指纹读取与另一个数据库文件的迁移并行，仍须两份完整指纹一致才能通过；子进程失败会阻断父流程，容器退出/超时同时结束子进程。该 probe 属于宿主机部署脚本，不在 Docker 运行镜像内；应用镜像摘要及303个已验证运行文件保持不变，没有新增 Cloud Build。新增子进程失败传播及配对恢复回归通过，新的实际计时演练结果待追加。

浏览器测试发现并修复相邻问题：readOnly 建议收件箱仍展示已批准但遗留 ACTIONABLE 标记的记录。查询现在同时限定可决策 lifecycle；隔离浏览器登录→建议→批准后收件箱立即清空，确认提示与总览一致。永久回归禁止只读列表依赖一次额外 reconciliation 才移除已批准项。等待证据的已批准机会允许刷新派生就绪度，保持 approved_at 与 selectedFactKeys；绑定生产 owner 的内容仍冻结。

第二次完整边界演练：备份115秒、迁移201秒、六条修复42秒，含完整审计的正向共402秒；配对恢复59秒，硬违规0。额外设置的420秒“正向加回滚”余量检查未满足（实测461秒），不将该检查报告为通过。补测全媒体哈希7秒、完整数据库隔离API启动3秒后，按真实步骤预算复核：正向402 + 两次哈希14 + API启动3 + 停止/拷贝等预留60 = 479秒公开前预算；再留60秒启动Worker，总539秒，小于既有600秒正向上限。回滚59秒加旧服务启动预留120秒为179秒，小于300秒回滚预算。业务门禁、540秒公开前上限、600/900秒运行限制均未放宽。计时与独立预算判断分别留存，不用一个“演练通过”掩盖原余量检查失败。

应用源提交 `b65794b42bc25d11ca92e0f21e31456e72eaabb3`，PR #19；宿主机部署probe后续提交经PR #20合并至 `faacbc20676ea53d29eb5cedabe71034d5b5cfe1`。两次PR CI均通过。唯一Cloud Build `585607a9-f3bd-48c3-b055-06513e20e35a` 成功，固定镜像 `sha256:3fe1cc4459a4346a753f4ffa88a36845e63a5c1e107e173f8172e2a165418d80`。镜像内303个运行文件与应用源归档逐一SHA一致；宿主机probe不在该镜像内，单独验证及记录身份。

当前只读来源副本的完整备份含1449文件、3,018,436,807字节；完整恢复演练通过。schema79输入SHA `f5aacc20c6e4db29eb97cf484a49539881579eae1f17a39da980f1d4321d9cb6`；79→83迁移、六条修复和完整机会门禁通过，预检库SHA `14af5f12a84a9e8505b0ff1e7aab78f0ef3b6383c2825ffae83e64e2d1a9bbbf`。停机前再次检查当前六条及依赖、媒体引用与预检一致，running jobs=0；随后以准确镜像强制预检通过后才停止旧服务。维护结果与线上读验结果见后续最终记录。历史回放与历史“未授权/停止”原文保留。

风险：DATABASE_LOGIC + 发布控制流程。工作区 `docs/cloud-release-result`，HEAD `ed6efd01cbd621ccdbc7f83a7bb3748a87a2682c`；承接候选 `a11bcf1711c6b31b52725cdc925c4817629037f3`。保留进入本轮时已有的文档/证据差异，没有 reset、stash、pull、commit、push 或 merge。完整输入留存于 [phase-04-family-repair.txt](../phases/phase-04-family-repair.txt)。原发布 [BLOCKED / ROLLED_BACK 记录](phase-04-cloud-release.md) 保留。

## 已证实原因

`Repository.rebuildKnowledgeOpportunities` 原先先从整个 cluster 的 completed facts 统计族与来源，再排除 historical/conflicted facts。最终 `selectedFactKeys` 只含 usable facts，但 `readiness.sourceFamilyCount` 仍来自筛选前集合。审计按最终 selected facts 重算，正确揭示了两套事实集合被错误比较。不是本轮 schema 迁移丢图、事实损坏，亦不能仅称为缓存过期。

在留存失败库的单个只读事务中，逐项读取实际机会、所选事实、cluster、来源成员关系及版本规则，结果如下。六条均 `recommended`、`approved_at=null`、`candidate_id=null`，反向 `topic_candidates` 和 `editorial_assemblies` 关联数亦为 0；写作包经 brief/candidate 关联，未发现六条的冻结生产包。

| 机会 ID | 保存值／筛选前重算 | 所选事实重算 | 被排除历史事实数 | 多出的族数 |
|---|---:|---:|---:|---:|
| opportunity_859f07766f1202a7b54f3058 | 14 / 14 | 12 | 4 | 2 |
| opportunity_9d066affac5209dd820dae5e | 3 / 3 | 2 | 1 | 1 |
| opportunity_e76caea56f5914a2d27a8f85 | 18 / 18 | 17 | 1 | 1 |
| opportunity_716a5d141a6a239055100d06 | 31 / 31 | 30 | 1 | 1 |
| opportunity_0ad2ce3a8a6125aa07ee8be4 | 24 / 24 | 23 | 3 | 1 |
| opportunity_c1f5ed8caac9df16e20abf27 | 3 / 3 | 2 | 1 | 1 |

六条 created_at 均为 `2026-09-13T04:55:03.682Z`，updated_at 均为 `2026-09-28T14:25:41.461Z`。原记录没有独立修订号或保存时完整来源族集合；历史集合 UNKNOWN。本轮提供的是同一留存版本的独立拓扑重建，不能冒充曾经保存过的集合。私有细节在忽略 Git 的 `output/family-repair/topology-final.json`；脱敏结论在相应 evidence 目录。

规范口径：以所选可用事实为边界；可见、非 conflicted、current/unknown、有值，证据来自 complete、processed/needs_ai、当前 capture 的成功非 degraded Experience、原媒体齐全的来源。每 source 的当前唯一 membership 映射到 `family:<id>`；未归族/NULL family 采用 `source:<id>`；无 source_id 不制造虚构来源；重复证据与同族多来源去重。不把历史成员和旧 consensus 缓存键混作当前族。人工 resolved 值覆盖冲突状态，冻结包不按实时集合改写。

## 代码及有界修复

- `src/opportunity-family-evidence.mjs`：版本 `selected-usable-facts-v1`，统一族键、completed-source 查询及只读所选证据投影。写入器先筛选再计数，selectedSourceIds 同样只由入选事实组成。
- 普通 coverage 更新与知识机会写入留存依赖指纹；批准前和完整审计重新比较。依赖改变时拒绝使用旧投影，待合法重算；不增加菜单读取时的全库写入，不新增模型任务。已批准/绑定生产对象的知识机会不被这两个自动重算入口覆盖。
- `scripts/audit-opportunity-qualification.mjs`：所有表处于同一读事务，统一 source/family 语义，继续保留全部原门槛，并将过期依赖指纹纳入阻断。
- `scripts/repair-opportunity-families.mjs`：默认 readOnly dry-run，精确 ID（1–20 个）；预览包含字段白名单、before/after、当前族集合、依赖/记录指纹、资格变化与保护状态。CLI apply 还要求明确隔离数据库路径/设备/inode、预览文件和隔离 manifest。
- 历史六条只修 `content_opportunities.readiness_json.sourceFamilyCount` 与 `content_opportunities.coverage_json.readiness.sourceFamilyCount`。不改 selected facts、原始来源、族关系、人工决定、草稿、冻结包、任务、预算或未知投递。旧 coverage_matrices 历史行保留；当前仓库对该表只有写入/清理入口，没有业务读取入口，新合法重算按新口径写入。
- 事务内重算并核对预览；身份错误、未知 ID、事实缺失/不可用、低于真实门槛、资格变化、已批准/反向生产关联、过期记录均拒绝；异常全部回滚；同一预览重复 apply 为 no-op。

隔离操作示例（IDS 必须来自预览计划，不接受全库默认）：

```sh
node scripts/repair-opportunity-families.mjs --database /isolated/work.sqlite --ids "$IDS" > preview.json
node scripts/repair-opportunity-families.mjs --database /isolated/work.sqlite --ids "$IDS" --apply --preview preview.json --isolation-manifest isolation.json
```

`isolation.json` 的 kind 必须为 `disposable-family-replay`，identity 必须与该 CLI dry-run 的 identity 完全一致。正式库 apply 本轮未执行，也不能将正式数据库伪装成隔离 manifest。

未来正式发布若获授权，发布协调器可在已固定写入边界内使用同一模块导出的 `previewRepair(db, exactIds, actualIdentity)` / `applyRepair(db, approvedPreview, actualIdentity)`：先 BEGIN 只读事务生成预览、ROLLBACK，再向 apply 传入当次明确的正式句柄和核准预览；不能把隔离 CLI 的 manifest 改名当作授权。两个函数均已在真实隔离库执行，apply 自带事务与二次核对，不导入 Repository 或启动任何业务任务。

## 同源证据与验证

输入为上轮已保存 schema79 快照，SHA256 `7af3b10dc9196f6efba54b8a4b35eb7577ca9c75282be505625317e19bb6d32a`。失败 schema83 库绝对路径来自原发布日志的 rollback-database 记录，经固定 Docker 卷路径映射为 `/var/lib/docker/volumes/solo_to_china_data/_data/failed-database-1790625139987/database.sqlite`，本轮只读校验 SHA256 `8f161a73545bccba6d6bdac659f8bd089126e175895728b20655874760ae28b4`。

云端 `/tmp/stc-family-replay-20260929` 是本轮独立 0700 诊断目录。空间检查约 32 GB 可用；只复制一次快照 DB 为 work DB，没有将 2 GB 整库下载本机。容器 `--network none`，原快照和失败库仅只读挂载，无生产凭据、无 Worker/server bootstrap。重用已存在候选镜像的 Node runtime，覆盖挂载本次代码只用于离线测试；**没有更改固定镜像内容，也不把覆盖挂载称为已构建新镜像**。最终代码逐文件 SHA256 manifest 与容器内读取字节比对。

真实 schema79→83 隔离迁移完成。六条修复 changed=6，原预览第二次执行 changed=0。完整机会门禁 hardViolationCount **6→0**，integrityViolationCount=0。修复前后 127 张表指纹对照，只对六条两个白名单字段做归一化；其余字节投影一致。评分、ready/editoriallySufficient、事实数量及准入结果未变。完整性 ok，foreign_key_check 无错误。最终代码门禁与迁移输入对照详见 evidence 中 final-validation 和 replay-summary。

最终217个源码/脚本文件逐项校验无差异；14张原始输入表的跨迁移指纹一致。最后一次真实坏/好门禁均及时退出，分别6/0；已不存在本轮运行中的隔离容器。机器可读证据：[最终门禁](../evidence/phase-04-family-repair/final-gates.json)、[迁移/最终修复](../evidence/phase-04-family-repair/final-validation.json)、[精确隔离修复计划](../evidence/phase-04-family-repair/repair-plan.json)。隔离预览指纹为 `292f4815778b55594681b82fee997277302b15075a0f88ae32aa5d0eb062986c`，不可用于正式库。

相邻审计：原 134 个 EVIDENCE_GAP、31 个 readiness=0、7 个未完成且无 active job 来源仍保留，没有把这些历史状态重试/清零作为本次门槛。原未知媒体投递不触碰。归档库中的 active queue=0 只是该固定版本观察。

| 层级 | 状态 | 范围 |
|---|---|---|
| L1 Targeted Tests | PASS | 历史事实膨胀、独立预期族集合、去重/NULL/变更、修复边界及发布顺序 |
| L2 Module Regression | PASS | 47 项非重复相关测试；npm run check；diff check |
| L3 Production DB Replay | PASS | 上述真实同源快照迁移、六条 apply、幂等、完整业务门禁及受保护数据对照 |
| L4 Browser E2E | NOT TESTED | 本轮没有执行新版登录后的浏览器操作；后端批准边界有回归 |
| L5 Real Provider Canary | NOT REQUIRED | 不修改模型/Prompt/transport，不发新付费请求 |
| L6 Full Production Replay | NOT TESTED | 完整 Opportunity 门禁不等于 Capture→QA 全链验收 |
| Post-Fix Exploratory Audit | PASS（定向范围） | 无新增硬违规；已知历史证据缺口保留；线上 Provider 降级另列 |

定向验收映射：FAM-01 六条真实留存拓扑复现 PASS；FAM-02 独立集合/去重/NULL/当前 capture/成员变化 PASS；FAM-03 实际写入、coverage 更新、批准校验与审计接线 PASS（非真实 Worker 全链）；FAM-04 dry-run/精确 apply/幂等/过期拒绝/异常回滚 PASS；FAM-05 低门槛、不可用事实、人工批准保护 PASS；FAM-06 同源迁移与完整门禁 PASS；FAM-07 坏样本与执行顺序 PASS；FAM-08 只读留存文件及受保护内容 PASS（配对备份恢复演练复用原已验收证据）；FAM-09 禁外联/无生产动作 PASS；FAM-10 相关回归/check/diff PASS。以上不延伸为新版浏览器、模型或 Capture→QA 全链 PASS。

## 发布门禁前置与后续唯一授权清单

`upgrade-existing.sh` 在任何 service 动作前要求 `STC_UPGRADE_PREFLIGHT_DIR`，以将发布的准确镜像运行 `scripts/preflight-opportunities.mjs`。核对镜像/revision/version、固定输入 SHA、迁移 schema、checkpoint 后数据库 SHA，然后运行完整强制审计；不新增 skip 开关。原正式写入边界后的门禁仍保留。坏样本事件日志只有 preflight，正常样本先 preflight 再抵达模拟服务动作；测试不会执行真实 systemctl。

最后的真实坏样本复验另发现预检工具退出问题：审计已打印6条违规，外层 Node 进程仍停在退出等待；本轮只停止已核实的隔离测试容器 `8bc8c6fbeb77`，未动正式容器。原错误日志留存。改为同步分块哈希和显式传播子进程退出码，并对审计设置180秒、整段 Docker 预检设置300秒及10秒强制结束上限。本地真实 CLI 的成功、违规、身份篡改三条路径均可及时退出。没有以超时当成通过，任何非零/超时仍阻断；未根据等待位置断言 Node/V8 的内部根因。

本地修复触及运行时代码，旧固定镜像不能用改 tag 或现场覆盖方式用于正式上线，需 **1 次新不可变镜像构建**。下次申请范围仅为：

1. 明确授权提交/推送本次代码、必要的 PR 合并与 release identity（本轮尚未提交），在原 project/repository 构建 1 次镜像；不自动追加失败重构建。确切提交及镜像摘要应由实际构建结果填入，不预造。
2. 在停机前用准确新镜像和新固定输入完成迁移/修复预览/完整门禁。旧快照通过不能替代当前增量；原服务期间的新任务和内容必须保留。镜像预先拉取，不在停机后才发现缺制品。
3. 六条 ID 及两个字段如上。当前隔离预览指纹在 evidence；正式库必须在新固定窗口重新生成并核对，不能套用 `/work` 身份/旧指纹。任一依赖、审批/生产关联或资格变化则停止对应步骤、重新评估，不能直接套六个数字。
4. 一个最多 15 分钟的有限维护窗口：协调 API 写入与 Worker 消费边界；当前一致备份、迁移及精确派生修复、完整门禁、隔离 readiness、再公开切换。到时仍未达门禁则在未公开条件下回滚；不继续延长。若停机前演练表明无法在预算内完成，先修改计划，不启动维护。
5. 保留旧容器/镜像及本次一致备份；exposed=0 才可配对恢复库与旧代码；公开接收新写入后禁止自动用旧快照覆盖新业务，须另行保全增量。
6. API 恢复、Worker 启动/任务消费、付费生成许可分别记录。新候选既有启动门控可避免启动补排；旧 2.0.70 没有同等门控，回滚后启动旧 Worker 可能重新排任务并产生费用，不能写不存在的开关。未获得明确消费/计费许可时，必须在计划中明确暂停消费者的维护影响，不能以“零模型验收”偷换正常生产费用。

拟请求的消费范围：成功切换后恢复 API 和正常 Worker，关闭候选的启动补排，沿用既有生产预算消费合法任务；允许因此发生正常生产模型费用，但不新增 Canary、重发历史 MODEL_OUTPUT_LIMIT 或提高预算。若需回滚，旧 Worker 恢复及其已知启动补排/费用风险属于同一项显式审批，不能隐去；用户未接受此项时不得进入会触发该恢复策略的维护窗口。

这份计划尚未授权执行。接续输入明确“不新增 Cloud Build、commit/push/merge、部署、维护窗口、正式数据修复”，而本次消息同时要求“发布上线”；需针对上述具体有限计划解除冲突后才能生产操作。下一次仍需按实际发布范围补齐必要候选运行/E2E/全链验证，不能将本轮数据库定向回放写成全生产链通过。

## 外部状态与副作用

原域名仅做一次普通健康 GET，观察到 API/DB ready、版本 2.0.70；没有读取现行生产 SQLite，没有确认新的 schema 指纹。健康响应的 providerRuntime 为 degraded、MODEL_OUTPUT_LIMIT；这证明模型故障仍存在，不证明具体 token/字节/解析根因。既有留存遥测中的三次 experience_extraction 时间分别为 `2026-09-28T19:53:29.372Z`、`19:54:29.951Z`、`19:55:45.669Z`，HTTP200/response_received、cost_usd=null。原日内 12 条不全归到最后恢复；缺少 finishReason/输出预算等字段，具体抛出原因 UNKNOWN，费用 UNKNOWN。未重发任务或提高输出预算。

本轮 Git 提交/推送/合并 0；Cloud Build 0；现行库写入 0；服务重启/停机 0；主动 Provider/WordPress 请求 0。云端写入仅独立诊断代码与副本，隔离临时容器退出后自动移除，诊断证据保留；没有启动第二个消费者，没有删除旧镜像、备份或失败库。新增构建额度未从上轮继承。

副本操作单列：完整DB复制1次、迁移1次；随最终指纹保护/退出处理改动，在同一work DB上执行4轮精确apply（每轮6条及一次0变化幂等复验），后三轮先仅在副本恢复原错误计数。共运行6个无网络隔离容器，其中1个退出等待容器被明确停止，其余自然退出；这些不是正式API/Worker重启。模块测试按最终47个唯一用例报告，不累加中间重复运行。

封面/正文独立刷新仍缺正式 dispatcher 与接收端限定 CAS/幂等/回执，本轮不扩展实现；公开前端仓库未访问/修改。扩展 2.0.71 候选包及用户浏览器更新状态沿用原报告，未操作 profile/存储/endpoint。

`current_authorized_step=NONE`；`phase_end_stop=true`。新版尚未重新部署。
