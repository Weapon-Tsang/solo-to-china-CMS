# 2026-09-28 阶段04发布链路修正（当前）

- EXT-RELEASE-CONTRACT：真实Git证明CI的b231b1d…对应9154dc…；历史缓存标注0c4b327…不正确，后者真实hash为e19fbc…。保留缓存及原CI commit，新增严格组合hash检查；不把本地自洽误当来源证明或线上版本证明。[差异与证据](acceptance/phase-04-fixes.md)。
- EXT-RELEASE-SCHEMA：resume-verified-upgrade和code-only-release是历史81入口，退出83计划；本机完整快照恢复/旧78升级/未来schema拒绝通过。生产schema UNKNOWN，生产回滚/启用未授权。
- EXT-REFRESH / EXT-BODY-MEDIA-REFRESH：CMS_CODE_GAP（新服务只有receiver接口和fixture，生产API/Worker未接线）；真实接收器另为RECEIVER_UNKNOWN / NOT_TESTED / WAITING_AUTH。既有新稿交付及旧pipeline媒体分支不等于新人工媒体修订外送。保留自动外送关闭、CAS/幂等/unknown保护，不整篇覆盖绕过。
- EXT-CARD：固定合同不支持cardTitle/deck；featuredMediaId不能代替，正式标题/SEO不覆盖。真实线上能力仍UNKNOWN。
- 本机Windows候选已安装运行依赖并通过API/Sharp/停止验证；Linux/容器digest及实际生产仍未验。当前完整输入已足够完成本轮本地任务，不再以缺04.1阻断本轮。
- 真实模型预算0，历史26母图像素与完整生产链NOT TESTED。生产只读/备份/迁移/Worker/样本WP写入/费用/停云各自WAITING_AUTH；无公开前端修改。

---

# 2026-09-28 04.0预检增量

- EXT-RELEASE-SCHEMA：当前代码83；实际生产schema未读。旧resume-verified-upgrade.sh断言81，不可直接使用。发布类型须以真实schema/持久语义确定；schema改变必须完整隔离恢复演练，不以CODE_ONLY绕过。
- EXT-UPLOAD-INGRESS：新增ARTICLE_MEDIA_CHUNK_BYTES，本地1 MiB真实浏览器上传PASS；线上/私有代理尺寸、超时、磁盘/内存NOT TESTED。旧会话仍保留旧块，不承诺自动重切或无限物理容量。
- EXT-RELEASE-CONTRACT：已校验缓存1.4.1/0c4b327…，CI仍固定b231b1d…；不代表线上能力，未来发布前统一固定制品并复验。未更新权威合同或CI。
- EXT-REFRESH、EXT-BODY-MEDIA-REFRESH、EXT-CARD保持关闭；真实PHP/WP为PENDING_ENV；真实模型canary预算0/WAITING_AUTH。
- EXT-PHASE04-SPEC：仅04.0完整规格已提供；04.1～04.5缺失，整个04未完成；不能从开发授权推导真实操作。

[完整数据/四个canary/资源授权计划](evidence/phase-04-0/release-migration-plan.md)。历史证据不升级为本轮生产实测；没有新生产私有读取、认证、WordPress写入或付费调用。

---

# 2026-09-28 阶段03 resume-04 外部依赖最终状态

CMS本地验收为PASS_LOCAL (CMS_ONLY)，[逐项证据和边界](evidence/phase-03/resume-04/checkpoint.md)。本轮已补齐CMS侧冲突图替代、SEO/GEO接线、媒体组合和恢复矩阵；以下外部状态没有升级：

- 真实PHP/WordPress：PENDING_ENV。固定合同1.4.1及独立回环HTTP字节/HTML验证不是实际WordPress，也不证明线上部署版本。
- EXT-PURPOSE / EXT-REFRESH / EXT-BODY-MEDIA-REFRESH：PENDING_FRONTEND/VERIFICATION。真实接收器的能力、CAS、幂等与对账仍须验证，生产自动外送门禁保留；测试outbox driver未作为生产适配器启用。
- EXT-CARD / EXT-SEO-HEAD / EXT-IMG-LOAD / EXT-CONTENT-RENDER：待固定接收制品与具体文章复验。未改外部仓库、PHP/CSS/JS、插件、robots/WAF或权威合同。
- GSC私有读取及真实Provider：WAITING_AUTH / NOT TESTED；完整生产回放NOT TESTED。没有索引、排名、AI引用或转化改善的结论。

用途说明仅按官方文档分别解释搜索/训练/用户触发访问；没有修改站点选择。本轮未做生产私有读取或写入、提交推送、部署、付费调用。下方历史依赖记录保留。

---

# 2026-09-28 阶段03 resume-03 外部依赖增量

- 从既有获准本地work副本只读取得未改动的公共合同JSON作为永久测试依赖：1.4.1、commit `0c4b327287c016aee138f735a8a13eb2baa74542`、组合hash `9154dc68540d9922c11109e4cfe00aee871d850e61124fd7edb624ee20b2c422`。没有新生产私有读取或前端仓库修改。
- 单来源/三日证据组合/mixed scope经过真实CMS队列、固定合同验证、实际PNG/WebP、本地HTTP接收器保存draft和HTML回读；接收器仍是fixture，不是实际PHP/WordPress。真实接收版本unknown，不能解除EXT-PURPOSE/EXT-REFRESH/EXT-BODY-MEDIA-REFRESH/EXT-CARD门禁。
- 真实WP保持PENDING_ENV；GSC和真实模型没有授权，没有新增匿名公网观测或索引/排名/引用结论。其余SEO/图片加载/渲染依赖保持前次范围。
- CMS本地的冲突图可执行替代、混合媒体同链、SEO/GEO接线和完整恢复矩阵仍由CMS完成，不归因于前端。[本轮检查点](evidence/phase-03/resume-03/checkpoint.md)。

---

# 2026-09-28 阶段03 resume-02 外部依赖增量

- CMS后台已接显式公开页面检查及GSC已存状态；菜单不会自动抓站点。本轮浏览器检查源是provided_artifact，GSC为受控响应，没有读取实际私有账号或虚构AI引用/索引数据。
- 独立回环HTTP接收器验证body-only成功、丢回执对账、部分回执拦截及真实WebP/HTML。其fixture合同不是权威前端制品，不能解除EXT-PURPOSE / EXT-REFRESH / EXT-BODY-MEDIA-REFRESH / EXT-CARD门禁。真实WordPress保持PENDING_ENV。
- EXT-SEO-HEAD / EXT-IMG-LOAD / EXT-CONTENT-RENDER保持待具体文章与固定制品复验；没有新增匿名现网GET、真实公网LCP或物理设备测试。前轮三个公开GET仅保留其原始范围。
- CMS内部未完成的路线全链、冲突图替代动作、SEO/GEO接线/矩阵和上传渲染负载由CMS继续处理，不归咎于前端。详见[resume-02检查点](evidence/phase-03/resume-02/checkpoint.md)。未修改公开前端、生产配置或权威合同。

---

# 2026-09-28 阶段03 resume-01 外部观测增量

- 有界匿名GET：首页、robots.txt、sitemap_index.xml返回200；[时间/URL/头部/hash](evidence/phase-03/resume-01/public-observation.json)。无认证/Cookie/生产私有读取。sitemap自身noindex不能归到文章。此证据不确认文章HTML、部署commit、合同版本、索引/排名或AI引用。
- EXT-SEO-HEAD、EXT-IMG-LOAD、EXT-CONTENT-RENDER仍待具体文章与固定接收制品复验；本轮没有浏览器LCP、真实设备或PHP/WP。不得从公开首页可读推导兼容成功。
- 真实本地WP保持PENDING_ENV；限定封面/正文媒体刷新、新展示字段等原门禁保持。没有修改权威前端合同或公开前端代码，没有伪造VERIFIED_COMPATIBLE。
- CMS本地接线/完整组合缺口由CMS继续处理，详见[本轮检查点](evidence/phase-03/resume-01/checkpoint.md)。以下历史证据保留。

---

# 2026-09-28 阶段03首批开发检查点

- EXT-SEO-HEAD（SEO-006～010）：PENDING_FRONTEND/NOT_TESTED。CMS检查器本地修复有fixture证据，尚未取得本轮实际接收端HTML/headers/robots/sitemap，不宣称线上有故障或已修复。最小复验材料为固定接收制品身份、同文章合法payload与匿名实际响应；用T03-07～12对照。不得改PHP/插件/robots。
- EXT-IMG-LOAD（SEO-005/013）：PENDING_FRONTEND/NOT_TESTED。去除了首img=LCP错误假设，但本轮没有实际浏览器LCP或srcset/sizes接收证据；需固定版本页面和位置/Performance观测，T03-06/15复验。
- EXT-CONTENT-RENDER（GEO-003）：PENDING_FRONTEND/NOT_TESTED；需要匿名初始HTML及无JS/桌面/手机事实对照；fixture不证明实际设备。
- 真实本地WP：PENDING_ENV。没有新安装或实测；T03-23/24/27及路线最终渲染待补。当前真实接收版本unknown，不冒充VERIFIED_COMPATIBLE。
- EXT-PURPOSE/EXT-REFRESH/EXT-BODY-MEDIA-REFRESH/EXT-CARD及固定合同身份沿用阶段02记录。未获取新制品，未重算/更改权威合同，受影响生产交付门禁继续保持。
- 本轮只读官方Google文档不属于本站匿名现网观测；真实GSC/私有数据/付费模型未授权。CMS本地未完成项见[阶段03报告](acceptance/phase-03.md)，不得将本地缺口推给前端。

---

# 2026-09-28 C/D 本地交接时的外部依赖

C/D 的封面和正文媒体受控接收器协议已在CMS实现并使用受控接收器验证。**真实接收端仍未连接/验证**：固定1.4.1缓存仅证明`page.metadata.featuredMediaId`可出现在schema，不能证明线上已支持限定封面刷新、媒体落位或条件更新；`EXT-PURPOSE`、`EXT-REFRESH`、`EXT-BODY-MEDIA-REFRESH`仍开放。默认交付门禁关闭，未知远端结果只能只读对账，不能重传或覆盖旧公开文章。`cardTitle`/`deck`已在一次bundle及本地draft中实现，但缓存严格schema不支持，故仅内部保留。阶段03/04需核对schema83快照、迁移review与旧应用兼容策略；历史26母图不可达，真实Provider Canary未执行。详见[本地验收](evidence/phase-02/cd/local-acceptance.md)。

以下保留旧检查点记录。

---

# 2026-09-28 C封面选择增量

- 既有固定缓存1.4.1/0c4b327287c016aee138f735a8a13eb2baa74542的组合artifact hash已复算一致（9154dc68540d9922c11109e4cfe00aee871d850e61124fd7edb624ee20b2c422）。featuredMediaId存在；cardTitle/deck不存在。此结论只针对缓存，不推断线上版本。
- EXT-PURPOSE / EXT-REFRESH仍NOT TESTED：当前本地选择在任何WordPress媒体上传前阻断，旧公开文章不变；没有假造cover-only/条件更新/特色ID回执支持。支持接收端分支尚待C实施，不能只靠外部状态掩盖本地待办。
- EXT-CARD：严格缓存不接受新展示字段，继续保留现有title/excerpt。内部bundle字段仍是C待办。
- EXT-SIZES继续消费既有能力；本轮不注册WordPress子尺寸。R2暂缓。
- 本轮无新生产读取、模型调用或真实WP操作。完整限制见[C检查点](evidence/phase-02/c-selection/checkpoint.md)。

---

# 2026-09-28 C入口检查点增量

C已获授权并开始；下方B记录“C/D未执行”仅为历史状态。C只读审计没有启用对外交付。

- EXT-PURPOSE / EXT-REFRESH / EXT-CARD：PENDING_FRONTEND / NOT TESTED。历史缓存1.4.1、commit 0c4b327287c016aee138f735a8a13eb2baa74542的字节身份见evidence/phase-02/c/historical-final.json；不等于线上版本或cover-only/防并发封面刷新/卡片字段能力。当前封面审计execution_enabled=false，已发布旧稿保持。
- 最小复验请求：固定权威制品与校验清单；特色图是否独立于正文Hero；封面刷新白名单、条件版本和特色图ID回执；卡片title/deck精确字段。没有修改CMS合同缓存/公开前端来放行。
- 本地历史像素仍NOT TESTED（26不可达路径）；不新增生产导出。C未完成的内部代码详见[C检查点](evidence/phase-02/c/checkpoint.md)，不把本地待办混同外部阻塞。

---

# 外部依赖台账 · 阶段 01

## 2026-09-28 阶段02 B 增量（仅本地）

- EXT-SIZES：本地已消费WordPress实际返回的尺寸，过滤异比例/放大候选；缺480/768/1200仅记录外部依赖。没有新增生产GET，原2026-09-27采样不作本轮实测。
- EXT-MEDIA-SERVED-IDENTITY：回环HTTP受控接收器的二次转码/丢回执/500/私有URL与独立文件读取已验；真实WordPress/CDN、附件最终hash与公共可达性 **NOT TESTED**。未读最终字节时served hash保持unknown。未知上传停止自动重试，D完整对账/outbox待对应阶段。
- EXT-PANEL-PROVIDER-QA：B本地panel真实裁剪与实际请求构造通过；裁剪后真实模型输出及独立视觉QA语义质量 **NOT TESTED**，用户禁止付费。
- R2继续暂缓：未来若卸载媒体，保留WP附件身份，公开媒体与私有备份分离，稳定媒体域名/历史URL/回滚/缓存需独立验证；本轮无桶、插件、DNS或订阅配置。

本轮完整边界：[B验收报告](evidence/phase-02/b/local-acceptance.md)。C/D未执行。

## 2026-09-27 只读实测

公开站点 `https://www.solotochina.com` 的 WordPress REST 文章与媒体 GET 均返回 200。采样 10 个媒体对象观察到 `stc-guide-card-2x` 及 WordPress 常见尺寸；一篇已发布文章的 HTML 返回 200，存在 canonical、description、Open Graph title/image 和 JSON-LD，4 张图片中 3 张有 srcset/sizes/alt。robots.txt 与 wp-sitemap.xml 返回 200。证据见 [`evidence/phase-01/public-runtime-audit.json`](evidence/phase-01/public-runtime-audit.json)。这只证明所采样公开输出；PHP 运行版本、私有前端合同版本、认证写入兼容性、每种 cover/body/social 用途及全站媒体行为仍为 `NOT TESTED`。未修改外部系统。

同日 gcloud 只读资源盘点：当前项目共有 5 台 RUNNING VM、3 个 Cloud Storage bucket、2 个 Artifact Registry 仓库、0 个 Cloud Build trigger；`solo-to-china-engine` VM 为 RUNNING。项目绑定了启用的计费账号，但未读取账单用量或费用，也未把其他 4 台 VM 自动归属 CMS 或判定可停用。现有生产 v2 快照来自 CMS VM 已有备份，未新建云快照或备份。证据见 [`evidence/phase-01/cloud-readonly-audit.json`](evidence/phase-01/cloud-readonly-audit.json)。

历史记录（2026-09-24，Asia/Shanghai）：当时没有读取或修改独立公开前端仓库，没有访问真实 WordPress、云资源或账单。下列旧状态均为 `UNVERIFIED`，请结合上方 2026-09-27 只读实测理解。

| ID | 关联 | 待核实能力 | 安全回退 / 阻断 |
|---|---|---|---|
| EXT-SIZES | LOC-016 | WordPress 实际响应式子尺寸 | 保持已支持的媒体交付，不伪造尺寸 |
| EXT-CARD | LOC-016 | 独立卡片 title/deck 接收与渲染 | CMS 内部保存；不得覆盖正式 title/excerpt |
| EXT-PURPOSE | LOC-016 | cover/body/social 用途分离 | 新用途交付须门控，不强塞正文 |
| EXT-REFRESH | LOC-015/016 | 封面局部更新及 revision 回执 | 不执行无保护整篇覆盖 |
| EXT-SEO-HEAD | LOC-016 | 公开 head/robots/sitemap | CMS 只验证合法 payload，外部输出待验 |
| EXT-IMG-LOAD | LOC-016 | 公开图片 srcset/sizes/首屏优先级 | 不改公开站 CSS/PHP |
| EXT-CONTENT-RENDER | LOC-016 | 初始 HTML、来源和图文对应 | 既有组件范围内交付；外部结果待验 |
| EXT-PUBLIC-RUNTIME | LOC-016/017 | 公开工具是否依赖 CMS 在线 | 不据此宣称可以停云 |

固定合同制品、checksum、实际接收版本与真实响应：`unknown / NOT TESTED`。复验需固定发布制品和受控 WordPress 测试接收端；本轮没有相关证据。

## 资源与成本矩阵

| 资源 | 当前判断 | 依据 |
|---|---|---|
| WordPress 计算、DB、公开媒体、DNS/CDN | 保留 | 公开交付依赖，未做在线检测 |
| 模型项目/计费、视频与 Batch 桶 | 待核 | 本轮未访问真实云资源 |
| CMS 云端进程 | 待核 | 未完成真实迁移或公共运行依赖验证 |
| 共用 VM、磁盘、IP、快照、制品 | 待核 | 无资源清单/账单，不估算节省额 |
| R2 | 本轮不启用 | 阶段规格暂缓 |

当前节省金额：`unknown`。可在取得账单后按“被确认停用资源的实际月费用减去本地新增成本”计算；不能把云端进程停止等同于整台 VM 停止。


## 2026-09-27 阶段 02 A1 检查点

- `EXT-PHASE02-PROVIDER`: NOT TESTED / NOT AUTHORIZED。本轮仅 mock 验证统一图文请求；没有新付费调用。真实 schema 接受、生成语义、token/延迟仍未知，不能用阶段 01 的短文本 canary 替代。
- `EXT-PHASE02-WP`: NOT TESTED。没有真实 WordPress 写入、媒体更新或 PHP 能力验证；正文补图的 `EXT-BODY-MEDIA-REFRESH` 能力仍需后续核对，不能假定已有封面刷新等于正文刷新。
- `EXT-PHASE02-CONTRACT`: 阶段 02 完整合同制品/接收端兼容性尚未验收；本轮没有修改前端仓库，没有上传未支持字段。
- `EXT-PHASE02-RELEASE`: NOT AUTHORIZED / NOT READY。schema 81 只在本地测试与一次性数据库上迁移；未来生产 schema 升级需要 DATA_MIGRATION_RELEASE。部署脚本只更新兼容性断言，未执行。
- `LOCAL-PHASE02-REPLAY`: 已复用阶段 01 保存的历史数据库快照，不是最新生产状态。经本地写入批准，在 D: 新建三次隔离重放目录；最终 `D:\cms-phase02-media-replay-pPPWln`。C: 空间不足，不应默认再次生成大型副本。数据库留在仓库外。
- 本轮停止原因为上下文检查点，绝大多数剩余本地开发工作已经在阶段 02 范围内；不是要求用户逐项重新授权本地工作。继续使用完整 TXT，不跳到下一阶段。


## 2026-09-27 Phase 02 A1 context-readback continuation

- No external dependency status was upgraded. Real Provider, fixed real PHP/WordPress and deployed receiver compatibility remain NOT TESTED; no fresh production read or paid call was made.
- No external contract/schema was changed. The new context endpoint is CMS-admin-only. Source viewing does not implement manual article upload or authorize delivery.
- Local historical replay: retained disposable directory D:/cms-phase02-media-replay-xiKzH1. Final dry-run compares 627 binding rows without differences; original and baseline hashes were preserved. Database files remain outside Git.
- Binding policy is now source-media-binding-2. Earlier evidence is retained; stale policy/context cannot silently satisfy a new publication gate. Historical repair remains scoped and requires its proper local/production boundary.
- Overall phase 02 stops at a context checkpoint, not a request for new local-development permission. Remaining CMS scope and exact external boundaries: [continuation checkpoint](evidence/phase-02/a1-readback-checkpoint.md).
# 2026-09-29 原云端接收器实测

公开只读合同端点返回 1.4.1，组合 SHA 为 `9154dc68540d9922c11109e4cfe00aee871d850e61124fd7edb624ee20b2c422`，与当前 CI 固定的 b231b1d 制品一致。现有公开 PHP 路径支持新 draft 的既有完整 package；已发布文章只见有限的整体 package 媒体刷新保护，没有本轮封面和正文分别限定的 CAS、幂等回执及对账接口。因此 EXT-REFRESH / EXT-BODY-MEDIA-REFRESH 仍为接收端缺口，CMS 不向旧文章执行无保护覆盖。最小外部请求：提供独立 `cover_only` 与 `body_media_only` 操作，要求 draft/article ID、预期 revision、幂等键、媒体用途，返回持久 revision 与可查询回执；过期 revision 必须拒绝，重复键返回原回执，未知结果可只读对账。公开前端仓库未修改。本轮新稿既有通路与原云端升级可独立推进。

---
