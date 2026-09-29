# 04.0 发布与迁移计划（v1.4，本地准备；不授权执行）

代码：CMS main / 490dd7464d4beb46d3f89a578337c253917fbf7a，加当前未提交阶段02/03/04成果；应用2.0.70、schema83。仅HEAD不能标识本候选，必须同时核对 artifact-manifest.json 的逐文件hash与组合hash。没有生成容器镜像，不存在可用的生产image digest。

## 当前可用范围与外部门禁

本地人工上传/断点、确认关系优先锁、批准路线保护、媒体局部处理、SEO检查、固定1.4.1严格合同消费可复用。新路线结构、cardTitle/deck仍内部保存，不能额外塞入严格payload。使用现有正文/表格/图片组件，不扩展PHP或权威schema。

封面刷新、正文媒体刷新分别保持关闭：需要各自真实receiver的版本、CAS、附件ID/公开URL、页面落位和幂等只读对账证据。已有featuredMediaId字段不能证明以上能力。未知远端结果不重发；已发布正文/title/H1/slug/canonical/时间元数据不因更新代码被重写。真实SEO head、图片加载和无JS渲染仍需具体文章观测。

## 制品、Git和workflow

本地运行 `npm run check` 已包含Vite构建；无prebuild/postbuild钩子。precheck只进行语法检查，boundaries:check只读源码。没有执行npm安装生命周期、release:check或部署脚本。新预检命令 `node scripts/stage04-local-preflight.mjs` 不读.env、不开数据库、不联网，拒绝错误remote、路径越界和符号链接，产生带hash的runtime payload；它只报告库存，不能输出发布许可。

payload包括src/config/dist/extension/vendor/public、content-strategy文档、package和lock、三个本地状态/检查/晋升脚本；不含业务库、媒体原件、认证文件或node_modules。它不是已安装的独立发行版，也不是已验证Linux容器。现有 `scripts/prepare-local-release.mjs` 会安装依赖并标记local-production，故本轮没有用于真实数据根。

未来若获准提交：仅暂存经审核的CMS文件，不使用git add .；包含已有02/03成果，不能只提交04文件却声称发布整套功能。当前dirty清单见initial-status.txt。push/PR会触发 `.github/workflows/release-gate.yml`：CMS和固定外部合同checkout、npm ci、offline release gate、本地Docker镜像构建及容器测试；该workflow无云部署步骤。其旧固定SHA b231b1d…与本轮缓存0c4b327…不同，需在真实发布准备时明确统一固定制品和复验，不跟随main。未改变workflow、未触发CI。

## schema与回滚

生产当前schema没有重新读取。历史阶段01基线78，后续隔离工作副本经历80/81/82；本代码要求83。不能据旧历史状态认定现在生产是78，也不能把本候选当普通UI代码发布。

- 若真实生产schema≠83或持久字段/数据语义发生变化，使用DATA_MIGRATION_RELEASE：精确全量快照→验证→独立恢复演练→迁移rehearsal→业务指纹→受控单主切换。先保留旧应用及其匹配快照，不能旧schema82应用直接写新83数据库。
- 只有实时核对schema83且无持久化转换，才可采用CODE_ONLY_RELEASE；不为代码发布额外执行整盘snapshot或完整迁移。
- `deployment/gce/resume-verified-upgrade.sh`仍硬编码81，**禁止用于本候选**。本轮只审计、不更新或执行生产恢复脚本。`verify-upgrade.mjs`使用当前SCHEMA_VERSION，但不证明其全量业务覆盖或当前目标已验证。
- 切换前失败：新环境保持migration-review，无Worker/外联；旧主机继续承担生产。切换后有新写入：先隔离写入、保留新DB/媒体/回执；不得直接以旧快照覆盖。能否回切依精确授权和数据对账决定。未知Provider/WordPress结果继续隔离，预算不清零。

## 完整数据边界

SQLite及WAL一致性；来源原件/预览/衍生图；生成母图与网页衍生图；未晋升visual_candidates；route_bundles批准记录和route_artifacts/render manifest；media_occurrences/media_bindings、来源版本；article_media_uploads会话JSON/已提交分块/原件；article_media_revisions、采用/撤销、人工锁、封面选择/历史；质量审核、预算、模型调用/Batch、WordPress映射和unknown回执全部保留。

备份实现已引用人工上传JSON路径和route_artifacts路径；本轮实际恢复回归覆盖暂停分块、新鲜管理员认证、媒体修订、路线改版、等价别名和Day顺序。恢复不复用bearer token，不自动跑模型或交付。未提交.part/.tmp不是有效已接收分块。不得把人工上传目录当无用缓存清理。

密文凭据及MODEL_CREDENTIAL_ENCRYPTION_KEY、ADC/服务账号、ADMIN/SESSION/CAPTURE/WP/Tunnel等秘密需独立私密移交与解密自检；报告只保留变量名，不复制值。不因密文形式把备份加入Git。旧损坏快照继续INVALID_PRESERVED；修复副本可恢复不等于生产接管。历史26个母图不可达，真实像素不能由合成图片替代。

## 上传链路

当前应用PUT上限8 MiB；会话管理器范围512 KiB～8 MiB；默认人工分块8 MiB。新增 `ARTICLE_MEDIA_CHUNK_BYTES`，可在明确配置的运行环境设1048576（1 MiB），不限制总文件/批次张数。浏览器已实测3请求上传2,885,976字节。旧会话保持原块大小和hash，设置改变不会重切旧块。若旧会话的8 MiB请求不能穿过新代理，保留旧会话/已上传部分，待原入口或获准代理变更后续传；不能声称配置会无损重分块旧会话。

线上代理尺寸/超时、私有入口、可用磁盘/内存、上传并发和出口未知；当前1 MiB仅本地验证，不能保证适合所有入口。入口小于512 KiB时当前manager下限不兼容，保持明确阻塞，不修改未授权代理。磁盘预检、解码像素约束、串行分块、分页和原件保全继续有效。

## 四个上线canary方案（全部NOT TESTED，当前预算0）

| 样本 | 授权后的最小范围 | 核对与停止 |
|---|---|---|
| C1 手动实拍零模型恢复 | 1篇指定稿、1张已授权实拍、1槽；只确认与补图，不买模型 | 正文/路线前后hash相同，原件/母图/衍生hash、管理员锁、真实接收回执；未知结果停止 |
| C2 需翻译/QA素材 | 1篇、1张固定信息图；独立费用许可后最多1次转换+1次QA、并发1、Batch关 | schema接受、token/延迟/费用、QA、预算持久化；400/429/unknown停止；金额上限须先依实际模型单价核实，本轮不猜 |
| C3 来源路线→英文正文/示意 | 1个固定来源、1条批准骨架；若需生成最多1次主生成+1次独立语义审核 | days/stops/顺序/交通条件、render manifest、相关普通照片、合同字段、实际渲染；关键证据缺失停止 |
| C4 已批准路线收到错误Day图 | 1篇已批准稿、1张错Day图；只上传/确认差异，不买模型、不改正文 | 原件保留、差异可见、正文/路线/发布时间hash不变，自动改正文即失败 |

真实稿ID、资产hash、receiver版本尚未获准读取，以上是固定数量的计划而非已定位生产执行清单。不能批准一个未定位目标的WP写入。先取得必要只读授权，由Agent自动填入对象及最终计划hash，再申请精确写入/费用许可；不用用户手填模板。

## 后续关卡与精确许可边界

附件只有04.0完整规格。04.1、04.2、04.2-ENABLE、04.3、04.4、04.5均未提供完整输入，不能自行编造其需求ID和通过结论。用户要求整个04开发，已整理可确定的共同本地准备；以下外部动作均不执行：

| 动作 | 已知目标/范围 | 缺口与停止点 |
|---|---|---|
| CMS commit/push | 本仓库main，artifact-manifest绑定的dirty源码 | WAITING_AUTH；提交与推送分别许可，push前核对workflow |
| 生产只读预核实 | 历史名solo-to-china-engine；精确project/zone未在脱敏盘点中固定 | WAITING_AUTH；需确定资源ID，只读schema/镜像/挂载/入口能力，不读秘密值、不导出业务DB |
| 云端CMS发布 | 本地payload已hash；生产image digest尚不存在 | WAITING_AUTH/NOT_READY；先真实schema、固定receiver证据和完整发布验证 |
| 迁移/恢复/新主启用 | 沿用旧云主生产是合法选项；本地生产目标尚未选择 | WAITING_AUTH；源/目标/完整快照hash、秘密渠道、单主交接及unknown对账未齐，不停旧Worker |
| 已发布媒体修复 | 未来只限具体稿件/槽位/资产，正文不改 | WAITING_AUTH；cover/body能力各自复验，零模型和付费样本分开 |
| 停云/删除/清理 | 当前没有确认可停或可删的资源 | WAITING_AUTH；现有5VM/3桶等历史数字不证明归属；不估算节省、不删除资源 |

可申请的下一步是提供后续关卡完整规格并选择相应本地/生产范围；此文不是用户已确认的授权。即便后续批准部署，也不包含前端仓库、WordPress主题插件、DNS/IAM/桶/磁盘或计费修改。

## 实际存在的本地复验命令

在本CMS根目录：`npm run check`；`node --test test/stage04-preflight.test.mjs test/article-media.test.mjs`；`node scripts/stage04-local-preflight.mjs`。

浏览器：`node scripts/stage04-browser-fixture.mjs`，用输出的127.0.0.1地址登录stage04隔离测试账号，内容→Cover selection fixture→上传图片补齐，再执行 `npx --no-install @playwright/cli -s=phase04 run-code --filename scripts/verify-stage04-chunk-browser.js`。停止只向该进程输出的STOP文件写空文件，关闭该session；不得通杀其他服务。

已有的检查/恢复工具：`node scripts/local-runtime-status.mjs status`、`node scripts/inspect-local-data.mjs`（migration-review）、`node src/backup.mjs --verify <snapshot>`、`--drill <snapshot>`、`--restore <snapshot> <new-root>`。尖括号为授权后才可填入的目标，不是本轮已执行命令。生产恢复、晋升与回滚不提供可误运行的猜测路径。当前本地代码回滚按本轮文件diff逐项撤回，保留阶段02/03未提交工作；不使用reset/clean。


## 2026-09-28 当前计划修正（原04.0记录保留）

以[阶段04发布链路修正交接](../../acceptance/phase-04-fixes.md)为当前执行边界。resume-verified-upgrade.sh及相邻code-only-release.sh为历史schema81入口，不进入83候选执行路径；使用src/backup.mjs完整快照隔离恢复及inspect-local-data只读检查，保持migration-review，不自动晋升/启用。旧81/82应用不得直连83库。

原CI b231b1d实际对应9154dc，不需要换commit；错误是缓存的0c4b327来源标注。已增加固定组合hash并通过真实Git校验/篡改拒绝，workflow原值保持。不能用9154dc缓存宣称0c4b327或线上receiver已验证。新封面/正文修订生产adapter缺口单列CMS_CODE_GAP，不能仅等待外部环境。

最终候选D:/cms-phase04-candidate-20260928-final已在Windows/合成根通过启动/Sharp/停止；源码ZIP及manifest见../phase-04-fixes/archive.json和candidate.json，依赖不在ZIP内。生产平台/image digest/schema/连接仍unknown。下一次集中选择只提交、提交推送或指定目标发布；生产只读、数据/迁移、Worker、WP写入及模型费用分别未授权。04.2/ENABLE/04.3/停云不自动进入。本轮完整输入已满足本地范围，不再以缺04.1作为本轮阻断。
