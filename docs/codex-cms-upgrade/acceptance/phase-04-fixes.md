# 阶段04：发布链路修正与本地候选交付（2026-09-28）

本轮授权范围完成：**PASS_LOCAL_CANDIDATE / STOPPED**。原04.0的本地PASS及原始证据保留；其中“CI固定值过期”的推测已被真实Git字节核对纠正。没有生产可部署或真实接收端通过结论。本轮完整输入见[归档](../phases/phase-04-fixes.txt)，所有本轮证据集中于[evidence/phase-04-fixes](../evidence/phase-04-fixes)。

DEVELOPMENT；Windows x64 / Node24.14.0 / npm11.9.0；CMS remote `https://github.com/Weapon-Tsang/solo-to-china-CMS.git`，main，HEAD `490dd7464d4beb46d3f89a578337c253917fbf7a`。保留既有01～04.0未提交成果；本轮没有修改应用版本、schema、业务迁移或媒体上传实现。风险分类：LOCAL_LOGIC（制品身份校验及准备工具），恢复兼容属于已有DATABASE_LOGIC的针对性复验。

## 两项风险的实际结论

| 入口 | 原风险/真实原因 | 本轮处理与证据 |
|---|---|---|
| deployment/gce/resume-verified-upgrade.sh 的两个 schema81 断言 | 历史云端“迁移后恢复启动”辅助工具，不是完整快照恢复器；还会读生产凭据、启动容器/Worker | 保留历史行为与81防线，明确退出83计划；DEPLOY.md纠正原schema78说明。不得把数字改83放行。当前本地恢复使用src/backup.mjs的完整快照恢复及应用迁移，结果停在migration-review |
| deployment/gce/code-only-release.sh 的 schema81 检查 | 相邻扫描发现另一历史81入口 | 同样从83候选计划排除，不执行、不删除。当前生产schema未知，不判定CODE_ONLY适用 |
| .github/workflows/release-gate.yml / config/release-gate.json | CI固定b231b1d…并未过期：其真实组合hash恰为历史基线9154dc…；缓存错误标注0c4b327… | **保留CI原commit，workflow最终无diff**；配置增加固定组合hash，verify-cross-repo-contract在sync前验证三个真实文件，并核对持久化hash。合法制品PASS，逐文件篡改/错误hash均拒绝 |

恢复证据：本轮backup、stage03-restore-matrix、article-media及local-runtime回归覆盖当前83完整快照、人工上传原件/暂停块、来源关系、路线骨架/采用/修订、预算、映射、独立目录引用和权限。旧schema78经真实应用迁移至83，源库仍78；未来84在创建target/staging前拒绝，新增源快照DB/manifest字节不变断言。现有v2格式兼容与损坏快照拒绝回归保留。不推断任意旧schema都受支持。

候选自身还生成了新的合成快照并恢复到独立review目录；实际inspect-local-data只读入口检查integrity=ok、FK=0、schema83，API模式被read-only门禁拒绝。没有启用review Worker、自动修订或外联。这里是合成数据恢复，不冒充真实生产全量回放。

回滚：旧81/82程序不能连接83库。代码回退须有精确数据库兼容证据；否则恢复匹配的完整旧快照至另一目录，并保留新写入及媒体/回执供对账，另行授权切换。不得覆盖生产新数据或直接启动旧容器。

## 合同来源核对

| 身份类型 | 实际值/含义 |
|---|---|
| CI保持固定Git commit | b231b1d54915ceef6a7f52b907ba5d7c1d79463d |
| 该commit三文件规范化组合SHA256 | 9154dc68540d9922c11109e4cfe00aee871d850e61124fd7edb624ee20b2c422 |
| 历史缓存标注的commit | 0c4b327287c016aee138f735a8a13eb2baa74542（来源标注不一致，未重写缓存） |
| 0c4b327实际Git三文件组合SHA256 | e19fbc9e00642ea181733dc8167be698d1de337408462fee8b166aaf190a1249 |

算法为SHA256(JSON.stringify([parsed registry, parsed page, parsed publish]))，不同于Git commit、Registry原文件checksum和ZIP hash。实际差异共13个叶子路径：包括商业说明/示例、Registry checksum及publication.status；0c4b327只允许draft，而9154dc对应制品允许draft/publish。详见[来源与差异](../evidence/phase-04-fixes/contract-provenance.json)。这不是换行导致的组合hash差异。固定文件保存在fixed-contract；claimed-commit-contract保存对照，二者均来自已有本机Git对象，只读获取，没有网络checkout或更改公开前端。

`inspectCoverContract`的pinned_cache_verified仅证明缓存自洽及存在形式合法的commit，**不能证明缓存来自所标commit**。原04.0中该状态仍是当时本地结果，但不再据此声称0c4b327与9154dc来源一致。本轮未修改任何缓存冒充权威支持；未来真实接收器必须匹配真实commit和hash，旧错误标注不能直接激活。

实际运行 `node scripts/verify-cross-repo-contract.mjs` PASS；永久用例使用已保存真实三文件，调用同一个严格校验函数测试合法/三个单文件篡改/错误hash。GitHub Actions/Cloud Build：NOT_RUN。push main或codex/**、pull_request会执行npm ci、offline release gate、Docker本地build/smoke；权限contents:read，无云部署步骤。release:check已审核：包含全库测试/本地smoke，本轮按影响范围运行实际合同入口及定向回归，没有执行整套release gate。

## 实际交付制品

- 独立可运行目录：`D:\cms-phase04-candidate-20260928-final`。
- 源码/构建载荷ZIP：`C:\Users\Mloong\Documents\ChatGPT\solo-to-china-CMS\output\phase04-1790609202806\cms-runtime-payload.zip`。
- ZIP SHA256：`82dd3be6733c250fcd6153026aedaada593b30761e92c2a0d19ba31206efb7fd`。
- 172文件清单组合SHA256：`e0c6c81c9c37920f1d9663c0b2dbc803c0d95adc365cf9cacebc1049367ac1c1`，逐文件见[candidate.json](../evidence/phase-04-fixes/candidate.json)。ZIP条目集合与实际解压字节全匹配，[archive.json](../evidence/phase-04-fixes/archive.json)。
- package-lock SHA256：`4a4a87dd5efab1134c6d10e0c688e9ab4020dc372bad8c4b6c8e90a49cea773e`，本轮未更改依赖版本/lock。
- 与04.0载荷逐文件比较，仅config/release-gate.json改变；其余171文件字节保持，见payload-changes.json。源码身份还由final-state.json绑定本轮文件hash及完整workspace-status.txt；HEAD单独不代表候选。

采用既有preflight的独立runtime目录清单和锁定安装步骤；没有调用prepare-local-release的local-production身份晋升，因为本轮只验证development合成根，不接管真实数据。最终安装 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` 退出0，110 packages，使用锁文件既定正常依赖来源和独立npm缓存。检查根package没有install钩子；锁中fsevents/tesseract.js有生命周期标记，本轮统一跳过生命周期。未用用户npm认证配置，未升级工具；Sharp0.35.4的Windows本机模块已实际编解码验证。OCR及其他非启动路径NOT TESTED，不能把启动通过解释为每个可选依赖功能通过。

ZIP不含node_modules，不能称开箱即用。目录已安装Windows x64依赖；依赖、合成DB、原件、临时上传、.env及测试控制端点均未进入ZIP。目标Linux/容器平台未知，image digest=null；Windows依赖不得复制充当Linux制品。原04.0 ZIP保留；本轮中间候选及中间ZIP也保留并以superseded证据标记，最终交付只认上面final目录及hash。

运行验证使用候选自己的src及node_modules，Sharp解析路径在候选内部；环境变量采用OS运行必需项白名单，不加载.env/NODE_OPTIONS/生产凭据；合成DB为空队列，API角色、maintenance关闭，TLS和非回环网络阻断。实际health：2.0.70、策略3.9、schema83、合同1.4.1/b231b1d…/9154dc…；AI、WP等未配置，jobs=0，业务外联0，app.stop完成且子进程退出0。详见[candidate-smoke.json](../evidence/phase-04-fixes/candidate-smoke.json)。没有启动Worker或停止用户服务。

可复现命令（CMS根目录；候选路径必须新建、不能覆盖已有目录）：

```powershell
node scripts/verify-cross-repo-contract.mjs
node --test test/stage04-release-identity.test.mjs test/backup.test.mjs
node scripts/stage04-local-preflight.mjs > docs/codex-cms-upgrade/evidence/phase-04-fixes/artifact-location.json
node scripts/stage04-prepare-candidate.mjs D:/<new-independent-candidate>
python scripts/stage04-archive-candidate.py
```

prepare工具内部真实调用 `node scripts/stage04-candidate-smoke.mjs <candidate> <new-synthetic-root> <evidence>`，以干净环境运行候选createApplication→回环health→Sharp→stop→备份恢复→只读检查；无需运行会加载.env的npm start。上面复验会产生新证据，当前交付无需重跑。首次npm user/global配置重复、首次Registry换行重建错误和空public目录清单问题均保留诊断并已修正；没有降低合同或媒体断言。

## 接收能力边界

| 能力 | 分类与精确入口 |
|---|---|
| 既有新稿交付 | src/pipeline.mjs sync_to_wordpress / src/wordpress.mjs有实际交付实现；真实环境NOT TESTED，本輪未调用 |
| 新选择封面局部刷新 | CMS_CODE_GAP：src/services/cover-delivery.mjs deliverSelectedCover有receiver接口/CAS/幂等/回执状态机；src/server.mjs只有GET cover-delivery计划，生产API/Worker没有接线或真实replaceCover adapter |
| 新人工正文媒体修订外送 | CMS_CODE_GAP：src/services/article-media-delivery.mjs deliverArticleMedia有独立body_media_only接口及unknown对账；生产路径没有refreshMedia adapter或自动dispatch，只有fixture调用 |
| 真实封面/正文接收器 | RECEIVER_UNKNOWN / NOT_TESTED / WAITING_AUTH，各自须核对版本、site、CAS、幂等和落位回执；封面通过不能代表正文通过；不使用整篇覆盖绕过 |
| 卡片文案 | 固定合同不支持cardTitle/deck（RECEIVER_UNSUPPORTED，针对合同）；实际线上RECEIVER_UNKNOWN。featuredMediaId不等于卡片文案支持，不覆盖title/SEO |

已有pipeline的旧媒体刷新分支不等于新人工修订outbox接线。fixture完成不证明生产adapter存在。自动外送关闭、unknown不重发、按钮不能假成功的保护保留；真实模型质量、历史26母图像素语义、完整生产链仍NOT TESTED，预算0。

## 测试与T04映射

| 层级 | 本轮结果与真实范围 |
|---|---|
| L1 | PASS：最终身份1项，backup+identity最终增量27项；分组重叠不相加 |
| L2 | PASS：58项受影响/相邻回归（backup、restore matrix、cover delivery、article media、local runtime、identity）；npm run check含build PASS；最终身份配置再跑真实合同入口PASS |
| L3 Production DB Replay | NOT TESTED本轮；无新数据库/迁移逻辑，复用04.0已获准旧副本回放历史证据，不冒充本轮生产复测。恢复采用合成完整样本 |
| L4 Browser E2E | NOT REQUIRED：无UI改动；04.0真实三块上传/旧会话证据保留，本轮article-media回归通过；本轮另有真实候选回环HTTP启动验证 |
| L5 Real Provider Canary | NOT REQUIRED本次确定性修改；真实Provider NOT TESTED，预算0 |
| L6 Full Production Replay | NOT TESTED；本轮不是正式release，无整套业务链声明 |
| Post-Fix Exploratory Audit | ISSUES FOUND：相邻code-only-release也是schema81；历史缓存commit错标；新媒体生产adapter缺口。均精确登记并保持门禁，无生产修复执行 |

T04-01：旧成果保留、当前schema/制品身份；T04-02：零生产/Git/付费副作用及停止；T04-14：仅CMS目录、固定前端Git对象只读；T04-15：真实合同/篡改拒绝/来源差异；T04-17：上传实现无改变、会话回归；T04-18：恢复/预算/独立body门禁；T04-24：路线完整恢复矩阵复验；T04-25：严格合同、回滚条件与精确授权。没有重跑90+44矩阵或性能专题。

## 下一可授权动作（本轮不执行）

A. 可选择“只提交”或“提交并推送”。本轮精确文件范围见final-state.json的files与下述记录：config/release-gate.json；deployment/gce/DEPLOY.md、resume-verified-upgrade.sh；scripts/verify-cross-repo-contract.mjs、fixed-contract-identity.mjs、stage04-prepare-candidate.mjs、stage04-candidate-smoke.mjs、stage04-archive-candidate.py；test/backup.test.mjs、stage04-release-identity.test.mjs；STATUS、EXTERNAL_DEPENDENCIES、phase-04-0追加、phase-04-fixes报告/输入/证据。workflow最终无更改。若要提交整套01～04成果，必须纳入workspace-status列出的此前合法文件，不能只提交本轮而称整套功能。remote/main如上，push触发离线CI但不自动云部署；本轮未提交/推送。

B. 如选择“指定位置发布”，生产目标、连接方式、当前schema、平台和凭据私密交接仍待核实，不默认选择云端或本机接管。先授权精确生产技术只读（schema/镜像/挂载/入口/接收版本），不包含业务DB导出或秘密值。真实源schema不同83/持久语义变化时才使用DATA_MIGRATION_RELEASE；已是83且无转换才可CODE_ONLY。

C. 生产备份/数据导出、迁移/恢复、Worker暂停/启用、WP具体样本写入、真实模型预算必须分别授权；当前均未获准。模型预算仍0，稿件/对象ID与成本不虚构。新媒体刷新还需要单独CMS adapter实现及接收能力验证，不能仅给生产凭据即激活。

D. 04.2恢复、04.2-ENABLE启用、04.3历史媒体修复、停云/删除均不是本轮后续自动动作。完成本轮不依赖这些完整规格；下一步只需用户选择具体操作，无需手抄路径或重新整理历史文件。

current_authorized_step=NONE；phase_end_stop=true。已停止全部本轮启动的API，未派后台任务；数据/证据/旧候选全部保留。无commit/push/merge/deploy/Cloud Build、新生产私有读取/导出、付费请求、生产WP/迁移/备份/主机切换/停云/删除或跨仓库写入。
