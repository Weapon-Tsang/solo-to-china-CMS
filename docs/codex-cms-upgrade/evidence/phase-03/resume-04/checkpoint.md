# 阶段03 v1.4 resume-04 本地验收

结论：**PASS_LOCAL (CMS_ONLY)**。本结论仅覆盖本阶段允许的CMS本地、受控模型边界、合成媒体及独立回环HTTP接收器；不代表真实WordPress、真实模型质量、生产回放或任何搜索效果通过。历史未完成记录保留，下列逐项证据覆盖其本地缺口。

## 范围、身份与新增修复

DEVELOPMENT；Windows/Node24.14，8逻辑CPU、16GiB内存；main，HEAD `490dd7464d4beb46d3f89a578337c253917fbf7a`，remote `Weapon-Tsang/solo-to-china-CMS`。未提交阶段02/03成果保留。完整TXT SHA256 `cdfb039e8d92c5a4c5e1a51a05fce924c71fc45cdb654895a7df3459bebfa91a`。[当前代码身份与逐文件hash](identity-final.json)。本轮开始精确时刻未记录，日期2026-09-28；记录完成时间见identity。应用仍2.0.70/schema83，未伪造外部合同或策略版本。

新增：冲突图原件保留＋批准骨架重编／完整预览／持久预算；SEO库存实体与独立问题及匿名访问证据接线；预览canonical与图谱引用同步；四类时间独立投影；官方爬虫用途分别诊断；媒体字节不再无条件使未变文字审核失效（内部回执route-review-dependencies-v2，旧回执保持严格规则）；封面裁剪完成自动续跑当前人工媒体修订；新母图清除旧活动裁剪但保留历史；交付回执在刷新和本地重试后保持，后台准确显示已确认/未知。

风险分类：DATABASE_LOGIC / PIPELINE / LOCAL_LOGIC / UI_ONLY。没有新增模型prompt、JSON schema、transport或模型配置变更；不添加SEO/GEO付费链。

## 已执行证据与边界

- [189项本阶段相关模块](acceptance-modules.log)：退出0。覆盖SEO、HTML、GSC mock、媒体、路线、审批/恢复、实际CMS生产队列与合同。
- [最终边界32项](final-boundary-regressions.log)、[最终路线11项](final-route-corpus-pass.log)、[同时封面＋正文及HTTP14项](combined-final.log)、[相邻绑定/修复/冻结内容30项](adjacent-audit.log)：退出0。组间重叠，不相加。
- [npm run check](acceptance-check.log)和[diff检查](diff-check.log)：退出0。没有跑全库npm test/release:check/Cloud Build。
- [既有一次性历史work副本回放](acceptance-historical.log)：84 sources / 1454 assets / 5334 claims / 12 drafts；schema和保护表hash完整回滚，committed_writes=0、external_calls=0。副本无历史路线快照、部分原件不可用；不会填造这些数据。合成路线与历史数据验证分别报告。
- [路线浏览器](browser-recompose-latest.log)、[正文浏览器→HTTP](browser-http-chain.log)、[独立封面浏览器→HTTP](browser-cover-continuation.log)、[封面裁剪局部续跑](browser-cover-local-ready.log)、[已有封面与新正文图共存](browser-both-final.log)、[SEO与GSC六状态](browser-seo-latest.log)、[爬虫用途](browser-crawler-purposes-final.log)：均PASS。
- [body接收回执](browser-http-receipt.json)、[cover接收回执](browser-cover-final-receipt.json)、[共存接收回执](browser-both-final-receipt.json)、[停止CMS后HTML/图片字节独立可读](cms-offline.json)。浏览器用正常CMS API；回环专用fixture driver消费持久修订。它不是已部署生产outbox适配器，真实接口缺失时仍门控。共存浏览器场景是先有独立封面，再补正文；一次新批次同时采用两类的本地服务行为另由combined-final.log覆盖。
- [三模式链](chains-final.log)与[混合页面payload](chains/mixed/package.json)／[HTML](chains/mixed/page.html)／[真实PNG](chains/mixed/route.png)／[WebP](chains/mixed/route.webp)：单来源、两来源显式组合、非路线段＋source scene＋示意。现有featuredMediaId来自同一真实合成scene；独立cover-only处理另有上述浏览器链。仅生成和独立审核模型边界受控，不能据此认定真实模型语义质量。

| 分层 | 结论 | 实际覆盖 |
|---|---|---|
| L1 Targeted Tests | PASS | 最终边界与永久regression |
| L2 Module Regression | PASS | 上述189项及最终增量，非全库 |
| L3 Production DB Replay | PASS | 只限既有授权work副本12稿确定性回放；非完整路线生产样本 |
| L4 Browser E2E | PASS | 上传/确认/冲突重编/封面裁剪/接收回执/SEO/GSC，桌面浏览器模拟宽度 |
| L5 Real Provider Canary | NOT TESTED | 用户未授权；本轮确定性修改不需要真实Provider |
| L6 Full Production Replay | NOT TESTED | 完整生产Capture到QA/真实Provider和WP仍为发布前关卡 |
| Post-Fix Exploratory Audit | PASS（上述本地范围） | 发现并修复多owner关系误取、媒体审核过度失效、裁剪等待不释放及交付回执展示/重试覆盖；相邻30项通过 |

## 性能与资源

[原始汇总](performance-summary.json)、[idle API](api-idle.json)、[负载API与RSS时序](api-media.json)、[idle菜单](menu-idle-isolated.log)、[负载菜单](menu-media.log)。数据：1000来源/10000claims/300稿/3000媒体元数据/1000知识/50失败job；每项30样本，nearest-rank。

| 模式 | 冷菜单P95 | 热菜单P95 | API最高P95 |
|---|---:|---:|---:|
| idle |147ms|90ms|9.132ms|
| 上传/hash/finish＋本地路线渲染 |211ms|145ms|12.436ms|

30个负载菜单样本全部与实际上传区间相交；16份23,083,435字节PNG＋535次本地route PNG渲染。峰值API RSS302,694,400 bytes，浏览器JS heap峰值135,131,562 bytes；无负载错误。API测量在菜单后、renderer继续运行期间，不能声称每个API样本均与上传重叠。首次与模块测试并行的menu-idle.log仅诊断，采用独立重测menu-idle-isolated.log。浏览器文件hash worker由实际上传E2E覆盖，后台load driver不是浏览器hash负载。没有宣称真实CWV或物理手机测试。

## 30项需求

以下PASS_LOCAL均是CMS本地实现/检查/安全门控通过；右侧的真实外部待验从未升级为通过。

| ID | 要求 | 本地状态 | 对应用例 |
|---|---|---|---|
| SEO-001 | 成品检查分层而非单个SEO总分【硬要求】 | PASS_LOCAL | T03-01、T03-02 |
| SEO-002 | 标题与H1分开验证【硬要求】 | PASS_LOCAL | T03-03 |
| SEO-003 | Robots按爬虫分组准确解释【硬要求】 | PASS_LOCAL | T03-04、T03-05 |
| SEO-004 | noindex、认证与可爬取性分开【硬要求】 | PASS_LOCAL | T03-02、T03-05、T03-17 |
| SEO-005 | CMS识别真实LCP证据而非首个img【硬要求】 | PASS_LOCAL | T03-06 |
| SEO-006 | CMS准确解析sitemap并报告输出问题【硬要求】 | PASS_LOCAL | T03-07 |
| SEO-007 | CMS规范URL以实际永久链接为准【硬要求】 | PASS_LOCAL | T03-08 |
| SEO-008 | CMS检测SEO多输出源，不修改插件桥接【硬要求】 | PASS_LOCAL | T03-09 |
| SEO-009 | 结构化数据与可见事实对应【硬要求】 | PASS_LOCAL | T03-10、T03-11 |
| SEO-010 | FAQ可选与标记一致性【硬要求】 | PASS_LOCAL | T03-12 |
| SEO-011 | 内链按文章关系而非仅词语重合【硬要求】 | PASS_LOCAL | T03-13、T03-14 |
| SEO-012 | 新文章与更新/合并的轻量判断【硬要求】 | PASS_LOCAL | T03-14 |
| SEO-013 | CMS检查公开图片及语义上下文【硬要求】 | PASS_LOCAL | T03-15、T03-16 |
| SEO-014 | 受限网络检查与缓存【硬要求】 | PASS_LOCAL | T03-16、T03-17 |
| GEO-001 | 面向游客的具体价值而非字段堆叠【硬要求】 | PASS_LOCAL | T03-18 |
| GEO-002 | 可靠来源与事实时间分层【硬要求】 | PASS_LOCAL | T03-11、T03-19 |
| GEO-003 | 同一份有用内容及CMS可读性检测【硬要求】 | PASS_LOCAL | T03-18、T03-20 |
| GEO-004 | 搜索/训练设置与外部功能不擅自启用【硬要求】 | PASS_LOCAL | T03-04、T03-21 |
| GEO-005 | 效果数据与生产数据分离【硬要求】 | PASS_LOCAL | T03-21、T03-22 |
| GEO-006 | 继续控制生产费用和复杂度【硬要求】 | PASS_LOCAL | T03-18、T03-35 |
| INT-001 | CMS全流程与现成接收制品的分层测试【硬要求】 | PASS_LOCAL | T03-23、T03-24、T03-27 |
| INT-002 | CMS性能回归和公开站指标只读观测【工程目标＋范围约束】 | PASS_LOCAL | T03-25 |
| INT-003 | 匿名公开观测及前端依赖不串仓【硬要求】 | PASS_LOCAL | T03-17、T03-26、T03-28 |
| GEO-007 | 人工与来源关联的语义边界回归【硬要求】 | PASS_LOCAL | T03-29、T03-30 |
| INT-004 | 缺图到人工上传确认再交付的完整链【硬要求】 | PASS_LOCAL | T03-31、T03-32、T03-34 |
| INT-005 | 新增数据、性能和恢复不回退【硬要求】 | PASS_LOCAL | T03-33、T03-34 |
| GEO-008 | 路线一致性不等于现实事实已验证【硬要求】 | PASS_LOCAL | T03-35、T03-36、T03-41 |
| INT-006 | 同一骨架派生正文、路线图和图注的全链验证【硬要求】 | PASS_LOCAL | T03-35、T03-37、T03-38、T03-42 |
| INT-007 | 人工补图冲突与已有正文保护回归【硬要求】 | PASS_LOCAL | T03-39、T03-40、T03-43 |
| INT-008 | 路线版本、缓存失效和完整恢复回归【硬要求】 | PASS_LOCAL | T03-42、T03-44 |

## 44个用例

公共模块证据为acceptance-modules.log（Windows Node24，退出0）；最终补充、浏览器/HTTP/恢复/性能对应上方同名证据。真实WP、生产与效果状态在末节独立列出。

| ID | 原输入／操作 | 本地结果与覆盖 |
|---|---|---|
| T03-01 | 仅payload正确但HTML正文缺失 | PASS_LOCAL：HTML初始正文/重要事实与schema分别判断；seo-inspection持久观察及浏览器。 |
| T03-02 | draft/preview/发布但noindex/登录保护 | PASS_LOCAL：draft/preview noindex、已发布noindex、403/认证unknown分别验证，不自动改设置。 |
| T03-03 | SEO title带品牌、H1不同、独立card title | PASS_LOCAL：正式H1/SEO title/card独立；SEO编辑不重跑正文。 |
| T03-04 | Googlebot允许、GPTBot拒绝、特定/通配组并存 | PASS_LOCAL：robots精确UA分组；官方用途独立映射，拒GPTBot不影响Googlebot/OAI-SearchBot结论。 |
| T03-05 | Allow/Disallow最长匹配、空规则、*、$、多robots标签 | PASS_LOCAL：最长匹配、通配符、终止符、空规则及多个meta/header合并。 |
| T03-06 | Logo首图/Hero第二图/多首屏图的fixture及可选浏览器证据 | PASS_LOCAL：首图logo和多个eager不冒充LCP；responsive候选检查；实际CWV仍not_measured。 |
| T03-07 | sitemap index含子图、namespace/转义/超时/预算耗尽 | PASS_LOCAL：sitemap XML/index/namespace/转义、受限递归和超预算unknown。 |
| T03-08 | 分页/永久链接/query/尾斜杠、预览页 | PASS_LOCAL：公开permalink/query/尾斜杠/跳转最终URL及preview单独canonical；私网拒绝。 |
| T03-09 | Rank Math启/停/未知插件的HTML响应fixtures | PASS_LOCAL：Rank Math启用/缺失输出/未知插件冲突响应fixture；不从插件名字推断通过。 |
| T03-10 | 多script、@graph、重复冲突Article | PASS_LOCAL：数组、多script、嵌套graph/BlogPosting及ID引用重连；后续冲突实体不能隐藏。 |
| T03-11 | draft伪日期、真实作者缺失、图片优化后日期 | PASS_LOCAL：真实发表、正文修改、事实证据、优化日期分开；无依据留空。 |
| T03-12 | 可见FAQ有/无FAQPage、隐藏FAQ/不一致文本 | PASS_LOCAL：可见FAQ标记可选；隐藏或与标记不一致失败。 |
| T03-13 | 实体相关内链、Read guide模板、本页anchor、坏目标 | PASS_LOCAL：唯一规范实体关系＋同站已发布身份＋当前匿名观察；Read guide上下文和坏链接/unknown不同。 |
| T03-14 | 同实体不同问题与相似标题已有文章 | PASS_LOCAL：同实体独立问题new/update/merge/claim建议；多owner身份不明返回needs-review，无自动写入。 |
| T03-15 | 封面/正文信息图/OG、WebP伪扩展与不可读URL | PASS_LOCAL：HTML实际图片、尺寸、srcset、魔数与字节检查；正文/独立封面/featured用途及图文关系测试。 |
| T03-16 | allowlist外跳转/私网/大响应/每菜单触发检查 | PASS_LOCAL：allowlist、逐跳DNS/私网、响应预算、无cookie、显式检查缓存；菜单没有抓取副作用。 |
| T03-17 | 公开GET遇403/重定向/需认证 | PASS_LOCAL：403/认证/不可读图片保留unknown，允许的重定向绑定最终URL。 |
| T03-18 | 碎片素材、夸大标题、未知条件、已保存证据 | PASS_LOCAL：既有article bundle/quality评估与证据账本回归；路线主生成＋独立审核各一次，未知条件保留。 |
| T03-19 | 只优化图片和实质事实更新两种情况 | PASS_LOCAL：只换图不改事实核实；已存单条事实verified_at变化只更新该事实，未虚构整篇核实记录。 |
| T03-20 | CMS内容和无JS/桌面/手机HTML样例对比 | PASS_LOCAL：无JS可见HTML/隐藏节点/desktop-mobile样本重要事实对照；仅fixture，不声称物理设备。 |
| T03-21 | 未配置/无数据/未开放报告或AI开关 | PASS_LOCAL：用途只读说明；GSC未配置/未观察/无数据等状态；无虚构AI接口或权限更改。 |
| T03-22 | GSC成功/空/失效mock与AI referrer缺失 | PASS_LOCAL：既有GSC适配及六状态浏览器响应fixture，AI引荐/引用/转化明确unknown。 |
| T03-23 | CMS完整生产到独立HTTP接收器与HTML校验 | PASS_LOCAL：三模式真实CMS jobs＋固定1.4.1合同＋PNG/WebP＋HTTP draft/HTML；人工封面与正文另走实际字节接收器。 |
| T03-24 | 仅封面/格式更新、CMS离线；固定前端制品可用时复验 | PASS_LOCAL：cover-only/body-only/已有独立封面＋正文补图；正文身份不变；停止CMS后独立接收器HTML和图像仍可读。 |
| T03-25 | CMS01关键后台基准重测及可选只读前端指标 | PASS_LOCAL：标准非空30样本idle及真实上传/PNG渲染负载，原始时间窗/内存/分位数齐；无公网CWV声明。 |
| T03-26 | 本地版本与匿名现网观测不同 | PASS_LOCAL：固定commit与实际部署分开；沿用当日匿名首页/robots/sitemap证据，不宣称目标已部署。 |
| T03-27 | 只有CMS/mock环境，真实WP制品或PHP运行不可用 | PASS_LOCAL：真实PHP/WP PENDING_ENV；受控HTTP明确不是WP，生产功能门禁保留。 |
| T03-28 | 已拿到前端列表验收，SEO/尺寸/新字段仍不支持 | PASS_LOCAL：EXT-SEO-HEAD/IMG-LOAD/PURPOSE/REFRESH/CARD/BODY-MEDIA-REFRESH单列，不修改前端。 |
| T03-29 | 来源/人工确认地点但像素无法命名；明显矛盾对照 | PASS_LOCAL：人工当前文章/槽位关系支持普通照片；Day明显矛盾具体阻断，未当作像素识别证据。 |
| T03-30 | 人工图注含来源/拍摄陈述；上传时间与核实时间 | PASS_LOCAL：人工上传/图注不产生官方事实、作者或整篇verified_at；只当前稿关系。 |
| T03-31 | 后台缺图→上传→刷新→确认→队列→附件与draft | PASS_LOCAL：浏览器缺图→分块→确认→持久媒体修订→本地处理→fixture outbox→真实HTTP字节/回执→刷新；封面另经裁剪确认；同时body+cover一次确认的服务回归通过。 |
| T03-32 | 补1/3图、重复确认、丢回执和已发布正文接口不足 | PASS_LOCAL：未齐manifest阻断；重复确认、并发、丢/部分回执和权限/能力拒绝；未知结果不重传。 |
| T03-33 | 含人工关系/原件/暂停块的快照及上传负载性能 | PASS_LOCAL：原件、暂停块、关系、锁、修订、预算和渲染文件异目录完整恢复；review只读；负载性能留证。 |
| T03-34 | 上线权限组合、来源绑定回填和纯本地补图路径 | PASS_LOCAL：development零外联、provider开关边界及source binding/repair回归；局部修复无独立正文/SEO模型调用。 |
| T03-35 | 单来源/证据组合/混合路线走实际CMS链 | PASS_LOCAL：单来源、两个独立来源的证据组合、普通段落＋照片＋路线图混合文走实际CMS链。 |
| T03-36 | 无原整日图或单个stop无照片；关键路线证据缺失对照 | PASS_LOCAL：可缺单站普通照片/原整日图；关键证据或明确required事实图缺失分别阻断。 |
| T03-37 | source路线忠实转译与新目标路线重编 | PASS_LOCAL：真实rendererPNG/WebP，source-target route/transform比较；反向箭头/Day/时长/manifest篡改拒绝。 |
| T03-38 | 黄桷垭/黄桷坪、metadata正确但实际正文或图关系错误 | PASS_LOCAL：黄桷垭/Huangjueya与黄桷坪/Huangjueping相似名替换负例；自报hash/实体ID不掩盖正文或关系错误；独立审核保留。 |
| T03-39 | 已批准稿后台上传相符照片及不符Day图 | PASS_LOCAL：真实后台相符站点照与冲突Day图；原件保存、明确差异及按批准骨架重编替代，4屏宽。 |
| T03-40 | 已发布三日文与新3张图不符，仅媒体修复授权 | PASS_LOCAL：三日旧稿＋三张错Day图本地fixture：全部原件留存，正文/route/调用记录不变；修改路线必须独立提案。 |
| T03-41 | 来源旧交通时间与未知班次，图文却完全一致 | PASS_LOCAL：约15分钟/未知时长/来源陈述条件保留；一致性不等于实时或官方核实。 |
| T03-42 | 路线图渲染失败/旧QA/旧worker返回/无真实WP环境 | PASS_LOCAL：失败预算累积、成功复用、旧worker拒绝、旧alt回执兼容；route-review-dependencies-v2只放开字节/附件变化，文字/合同/路线仍失效。 |
| T03-43 | 已确认正文实际偏离其批准骨架 | PASS_LOCAL：当前正文walk改taxi会ROUTE_TEXT_MISMATCH；媒体权限不能保护已知错误为通过。 |
| T03-44 | route改版与仅换图两组快照/上传渲染负载 | PASS_LOCAL：媒体、等价英文别名、Day顺序快照；等价别名不暗改冻结正文；route改变拒绝旧回执；图片字节可复用未变文本审核，页面/图片另验。 |

## 固定合同、外部待验与未激活范围

前端合同来自既有已核验只读制品：1.4.1，commit `0c4b327287c016aee138f735a8a13eb2baa74542`，artifact SHA256 `9154dc68540d9922c11109e4cfe00aee871d850e61124fd7edb624ee20b2c422`。它不证明线上接收端部署了该版本。

- 真实PHP/WordPress：PENDING_ENV；没有实际附件/草稿/publish写入。独立HTTP fixture不代替这一层。
- EXT-PURPOSE / EXT-REFRESH / EXT-BODY-MEDIA-REFRESH：PENDING_FRONTEND/VERIFICATION。限定cover/body刷新需要实际接收器精确能力、CAS和幂等对账；当前生产适配器未验证，自动外送仍关闭，未知回执不会重传。
- EXT-CARD / EXT-SEO-HEAD / EXT-IMG-LOAD / EXT-CONTENT-RENDER：按实际文章与固定接收制品另验；没有修改外部PHP/CSS/JS、插件、robots/WAF或合同源。内部字段不透传未支持合同。
- GSC私有读取、真实模型／图片／Batch：WAITING_AUTH / NOT TESTED。本地测试不证明索引、排名、AI引用或转化改善。
- 历史原件实际像素语义、真实Provider输出质量、完整生产回放、物理设备与浏览器矩阵：NOT TESTED。来源事实仍是source assertion，不冒充官方或实时验证。

用途说明于2026-09-28按[OpenAI官方爬虫文档](https://developers.openai.com/api/docs/bots)和[Google官方爬虫文档](https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers)核对。搜索、训练及用户触发访问分开；Google-Extended属于用途控制，不能用于推断Google搜索排名。没有改变站点选择。此前匿名现网三次GET仅保留resume-01原证据范围，本轮新增网络读取仅官方资料/常规工具依赖，无生产私有读取。

## 副作用、复验与交接

CMS commit：否；push/merge：否；deploy/Cloud Build：否；生产私有读取/导出：否；真实模型/生图/Batch：否；生产WordPress写：否；生产迁移/backfill/backup/snapshot：否；停云/删除：否；独立公开前端代码修改：否。

可复验：`node --test test/stage03-route-chain.test.mjs test/manual-route-media.test.mjs test/stage03-restore-matrix.test.mjs`；`node scripts/stage03-browser-delivery-fixture.mjs`（只启动私有临时目录和127.0.0.1，输出STOP路径）；加`--cover-only`或`--with-existing-cover`分别验证；浏览器驱动为scripts/verify-stage03-browser-{cover-}delivery.js。向该次输出的STOP写空文件即可停止其服务，不能使用通用kill停止用户进程。历史回放只接受既有精确work副本路径。未提交变更回滚应按identity-final.json逐文件审查，不使用reset/clean覆盖既有阶段02成果。

完整规格、原30/44台账和失败诊断日志保留；本轮早期失败均由对应final/pass日志复验，不删除测试或放宽业务阈值。下一建议阶段仅CMS04-0预检，需要用户新对话明确启动，不自动执行。

current_authorized_step=NONE；phase_end_stop=true。测试进程清理证据见cleanup.json（仅本轮自建进程）。
