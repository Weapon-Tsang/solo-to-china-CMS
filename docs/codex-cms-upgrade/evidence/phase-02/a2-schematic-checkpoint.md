# A2 示意图文章槽位与图片独立恢复检查点 · 2026-09-28

**A2_PARTIAL / NOT_READY_FOR_B / STOPPED**。按 phase-02-a2.txt 第十节保存接续点，本报告不是完整A2验收。阶段01、02-PRE、A1及此前A2证据保持；原68项/90用例不改号、不整行提升。上一份 a2-decisions-checkpoint.md 的不变证据继续有效。

## 身份与实际修改

工作目录 C:/Users/Mloong/Documents/ChatGPT/solo-to-china-CMS；main，HEAD e9f7c8e82ff760f4d18f2d2e0673452eb8744290；app2.0.70/schema82不变。修改前身份见 a2-schematic-baseline.json、a2-schematic-state-baseline.json、a2-schematic-policy-baseline.json；修改后文件SHA256见 a2-schematic-files.json。未记录修改前SHA的脚本不声称有逐字节前像。git status/diff --stat见 a2-schematic-git.txt（包含所有既有未提交工作，不能视为本轮独占diff）。未reset/clean/stash、覆盖旧证据或回退代码。

- src/visuals/route-schematic.mjs：新增可信代码派生的文章槽位、caption/alt/route_summary及route_contract；新增持久artifact、实际绘图操作、SVG hash、PNG hash、图注和摘要核对。local_route_qa不是伪造的独立AI视觉QA，仍保留visual_review=NOT_TESTED。
- src/repository.mjs：新稿route schematic进入article_visuals；renderDraftRouteVisual验证当前来源、路线与正文receipt后生成/复用真实PNG；saveGeneratedVisual再次验证持久receipt，拒绝只报local QA成功。固定manifest的路线媒体恢复不重新选材，保留slot、attempt_count、recovery_budget；丢失的PNG可按原文件身份重建。已有文件字节冲突仍安全拒绝，不擅删坏文件。ensureRouteSchematic不再是主写作前置。
- src/pipeline.mjs：article_bundle写作成功后排generate_visuals；即使未配付费图片Provider也能运行本地renderer。图片异常保留真实错误；预算耗尽不假装再次发生渲染。路线稿的独立文字审核排在媒体完成后，含已完成stage复用的下游续接；媒体阶段完成检查可不要求尚未执行的文字QA，最终delivery始终要求文字QA。
- src/publication-eligibility.mjs：required manifest携带route contract；验证slot依赖未被改变。本地路线图须通过持久renderer回执与当前路线核对，不能靠model自报QA通过。
- src/services/production-state.mjs：本地路线槽位不随付费visual Provider关闭而隐藏；修复恢复目标误指质量审核。
- src/services/content-recovery-policy.mjs：明确本地渲染目录、回执/标签错误、三次预算耗尽；只恢复图片，不建议重写正文。
- test/route-production.test.mjs：真实Worker/SQLite的媒体阶段、真实executeContentRecovery、预算耗尽、新Job不洗预算、成功图片复用、缺PNG重建、备份恢复及错误图注门禁。
- 新增 scripts/stage02-route-media-browser-fixture.mjs、verify-stage02-route-media-browser.js；历史脚本新增--schematic，限定旧稿manifest兼容读取并回滚。

## 验证与真实覆盖

Change class: PIPELINE / DATABASE_LOGIC；未改Provider请求prompt/schema；真实付费调用0。

| 层级 | 本轮状态与范围 |
|---|---|
| L1 Targeted Tests | PASS：7个route-production测试，含真实恢复服务、Worker与SQLite；最终模块集合包含这些测试 |
| L2 Module Regression | PASS：95/95，a2-schematic-final.log；npm run check（含build）PASS，a2-schematic-check.log；check后最终后端调整经95测试及node --check覆盖；git diff --check PASS，仅既有CRLF提示 |
| L3 Production DB Replay | PASS，限定历史兼容：a2-schematic-historical.json；仅D:/cms-phase02-media-replay-xiKzH1/work.sqlite，事务migration82后回滚81；12稿manifest无伪route contract，无自动新增路线图；既有9类表指纹不变。历史库无路线快照，不能证明真实历史route恢复 |
| L4 Browser E2E | PASS，限定图片恢复：a2-media-browser.log。登录真实隔离CMS→图片失败详情→关闭详情→重试失败步骤→确认重新执行→真实Worker渲染→刷新→PNG预览；正文/hash/revision、slot和累计预算不变；pageErrors=[]。最后的错误文案映射、缺PNG重建和manifest routeContract增量由后端测试覆盖，未重复浏览器 |
| L5 Real Provider Canary | NOT REQUIRED，本轮未改Provider请求；真实图像语义质量仍NOT TESTED |
| L6 Full Production Replay | NOT TESTED：完整A2页面组合/最终交付未贯通；未运行生产或WordPress |
| Post-Fix Exploratory Audit | ISSUES FOUND：修复Provider关闭隐藏本地阶段、媒体阶段提前要求文字QA、复用stage漏续接、本地缺PNG不可恢复；剩余A2缺口见下方精确动作 |

执行命令：

```text
node --test test/route-production.test.mjs test/route-bundle.test.mjs test/route-media.test.mjs test/route-decisions.test.mjs test/publication-eligibility.test.mjs test/content-recovery.test.mjs test/production-state.test.mjs test/content-recovery-policy.test.mjs test/visuals.test.mjs
npm run check
node scripts/stage02-route-historical-replay.mjs D:/cms-phase02-media-replay-xiKzH1/work.sqlite --schematic
node scripts/stage02-route-media-browser-fixture.mjs
npx --no-install --package @playwright/cli playwright-cli -s=a2media run-code --filename=scripts/verify-stage02-route-media-browser.js
```

浏览器脚本假定已登录并打开失败详情；完整登录、列表/详情操作记录可从本轮工具日志和output/playwright/a2-media-before.yml、a2-media-after.yml核对。前两次浏览器自动化因未确认恢复弹窗/定位精确标题失败，没有调用Provider；修正后才记录PASS，不把失败尝试当业务通过。

真实历史基线保持：84 sources、1454 assets、12 drafts、26 visuals、12 packets、18415 jobs、6453 model metrics、12 publications、151 extraction runs；所有指纹及schema81在finally回滚核对。未重跑此前13owner审批回放；复用原证据。

## 可追踪正例、负例与恢复

正向链1：seedRouteProduction当前capture/Experience → getPlanningPackage冻结route → ContentEngine实际articleBundle请求 → 实际independent review请求 → renderer真实PNG/manifest。a2-schematic-trace/request-trace.json保存请求构建入参；该测试为记录trace单独再次执行，1主写作+1独立文字审核，0额外路线/SEO/diagram调用。模型仅在completeJson外部边界提供受控响应，Repository/Worker/SQLite/renderer没有整体mock。

正向链2：真实Worker保存正文→generate_visuals因缺目录失败→executeContentRecovery生成新图片Job→真实renderer生成并晋升article_visuals→冻结manifest门禁通过。浏览器采用合成已保存稿并真实运行图片Worker，未声称其正文是远端AI产物。a2-schematic-article.json与a2-schematic-article.png保留该浏览器实例的正文、槽位、manifest、Job；output/playwright/a2-media-recovered.png已可视检查重复East Hall站次、箭头和about 15 minutes。

负例：缺核心路线证据不调用writer；缺渲染目录只失败图片；错误caption不能通过交付媒体门禁；第三次本地失败后，新恢复Job在预算门禁停止，attempt_count/预算仍3，正文不变；旧路线/来源的迟到结果沿原负例拒绝。不能把示意图当required factual photo（本地slot factual_image_required=false，原实拍槽仍独立）。

备份恢复：真实createBackup/restoreBackup把已恢复的article_visuals、required manifest、route artifact、PNG、累计预算带到migration-review；重新核对媒体门禁通过、正文和槽位身份保持、没有运行中的Job。D采用锁/outbox未实现，未伪造测试。

## ROUTE-001～012 当前增量及剩余

| ID | 本轮新增/复用 | 独立或组合剩余 |
|---|---|---|
| ROUTE-001 | 原分类/审批证据保持 | 知识/混合完整分流矩阵未补 |
| ROUTE-002 | 原来源fragment/panel证据保持 | 真实图片理解NOT TESTED |
| ROUTE-003 | 原冻结/审批持久化保持；图片contract入manifest | D消费组合待验 |
| ROUTE-004 | 原条件诊断保持 | 多来源逐字段冲突/非关键条件仍待补 |
| ROUTE-005 | 主写作不再被本地渲染错误阻断；请求无新增付费链 | 完整页面/文字QA组合待验 |
| ROUTE-006 | 示意图进入实际文章媒体槽；不替代实拍 | 可选示意图/冲突图省略及管理反馈尚待完成 |
| ROUTE-007 | 原crop计划不冒充字节保持 | B/C实际crop与独立QA；远端质量未测 |
| ROUTE-008 | PNG、文章槽、caption/alt/摘要和manifest同hash；真实Worker/浏览器PASS | 页面实际组合/SEO与全部交付入口仍需验证 |
| ROUTE-009 | 媒体门禁核对renderer持久回执、图注及slot route contract | 所有入口当前source/route/text QA/page receipt的完整门禁待补 |
| ROUTE-010 | 原明确审批与media_only拒绝保持 | 完整D采用锁/outbox/续跑PENDING_D |
| ROUTE-011 | 图片恢复正文/hash/revision不变；历史无快照不补造 | 新v2与正文v1在所有页面/交付入口拒绝仍待贯通 |
| ROUTE-012 | 真实恢复服务/Worker、预算累积与耗尽、缺PNG重建、槽位文件备份恢复 | 混合媒体成功产物保持矩阵、完整依赖传播尚待补 |

## T02-71～90 子行为矩阵（不提升整行）

| ID | 本轮证据或待验 |
|---|---|
| T02-71 | 原路线主请求保持；知识/混合完整矩阵待补 |
| T02-72 | 复用fragment/站次/panel证据；真实像素理解未测 |
| T02-73 | 复用组合审批与缺连接拒绝；逐字段多来源冲突待补 |
| T02-74 | 冲突整日图旧回归PASS；可选省略管理反馈待补 |
| T02-75 | 计划不冒充crop产物旧回归PASS；实际字节PENDING_B/C |
| T02-76 | 真实写作后本地示意槽位；不把示意槽记为实拍 |
| T02-77 | 真实PNG接article_visuals/manifest、浏览器解码PASS |
| T02-78 | 原跨日普通实拍合法复用回归PASS |
| T02-79 | 缺目录/预算耗尽与正文错误区分；真实恢复入口只排图片 |
| T02-80 | source/target route hash及renderer manifest持久；真实crop待B/C |
| T02-81 | 原错误箭头/输入/manifest负例及实际图可视检查PASS |
| T02-82 | 请求trace：1主写作+1独立文字审核、0额外diagram请求 |
| T02-83 | 新Job不洗预算，已完成图复用，缺PNG重建；完整版本失效待补 |
| T02-84 | 原发布正文只读审批证据保持；新图片恢复不改正文 |
| T02-85 | 文章槽/required manifest/route artifact/PNG/预算真实恢复PASS；D组合待验 |
| T02-86 | 本轮实际浏览器确认仅图片恢复PASS；完整上传采用PENDING_D |
| T02-87 | 真实Worker只恢复renderer，不重写；独立视觉Provider NOT TESTED |
| T02-88 | factual与schematic分开；可选图不增加硬门槛尚未完成 |
| T02-89 | 图注篡改拒绝、预算耗尽不重买正文；完整正文局部修复/QA待验 |
| T02-90 | 来源断言免责声明保持；现实可行性NOT VERIFIED |

## 精确下一动作（从这里继续，不重做以上证据）

1. 先解决ROUTE-006/008/T02-88的策略缺口：现在draftMetadata对冻结路线默认追加render_route_schematic，而freezeRequiredMediaManifest沿旧实现把全部槽记required。这仍会把可选示意图变成硬门槛；必须按实际批准媒体义务区分可选与required，省略只影响对应图并给出管理反馈，不能删真正required实拍槽。不要因本轮PNG已接入就将ROUTE-008整项标绿。
2. ROUTE-009/011/012：补实际compose_frontend_page、uploadVisualMedia、独立review、compose_publish_page/push各入口的依赖门禁。当前generate_visuals完成允许requireRouteReview=false以避免要求未来QA；最终delivery强制文字QA。**uploadVisualMedia仍在页面编排前用默认文字QA门禁，存在组合顺序循环风险**，需要按正确阶段依赖解决，不能简单全局关闭最终QA。
3. 检查所有route/source校验的一致性：Repository.assertCurrentRoute会核对同capture的source input/fragment，而publication eligibility目前只直接核对source capture version；不能据此宣称同capture来源变化的最终交付门禁完整。新批准v2和正文v1必须保持明确拒绝，不自动重写。
4. 扩展仅图片恢复矩阵到“另一成功实拍/转译槽保持、未完成槽恢复”；本轮已验证同一成功PNG/manifest复用、缺文件重建、预算耗尽。已有PNG字节损坏/冲突目前安全拒绝；不要删除旧文件强行绕过。预算耗尽无新增人工增额接口，本轮不会重置预算。
5. ROUTE-001/004：知识/混合文分流、多来源逐字段冲突、非关键条件降级矩阵，继续原A2范围。
6. B/C真实crop字节/视觉质量、D采用事务/outbox继续按原边界单列；A2剩余1～5不得推给它们。共享A1上传能力不重做。

## 副作用与停止

commit/push/deploy/生产数据库读取写入/新生产导出/真实付费模型/生产WordPress/公开站前端修改均0。无子agent。只有CMS本地文件、测试临时库与既有获准历史work.sqlite的已回滚事务。

自己启动的隔离服务PID13800已通过C:/Users/Mloong/AppData/Local/Temp/cms-a2-media-browser-lTCaKx/STOP停止，终端退出0；Playwright会话a2media已关闭。数据库、图片、截图和历史证据保留。其他用户进程未停止。该fixture后续review_draft仍排队，服务已停且没有Provider，未消费；恢复测试的范围不包含完整文字QA生产完成。

current_authorized_step=NONE；phase_end_stop=true。不进入B/C/D或阶段03。下轮以本检查点及phase-02-a2.txt接续。
