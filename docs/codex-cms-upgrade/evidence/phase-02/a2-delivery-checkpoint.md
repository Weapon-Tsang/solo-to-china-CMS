# A2 可选图片、页面依赖与当前版本门禁检查点

2026-09-28；DEVELOPMENT；**A2_PARTIAL / NOT_READY_FOR_B / STOPPED**。

以本检查点接续。此前 `a2-schematic-checkpoint.md`、`a2-decisions-checkpoint.md`、`a2-resume-checkpoint.md` 及阶段01、02-PRE、A1证据保留；不重做已验证审批、截图、恢复和历史回放。app2.0.70、schema82、HEAD e9f7c8e82ff760f4d18f2d2e0673452eb8744290 未改变。未提交成果全部保留。

## 实际增量与代码身份

前后 SHA256：`a2-delivery-baseline.json`、`a2-delivery-files.json`。本轮未在入口单独采集的文件，before 明确为 null，不能伪称其相对 HEAD 的全部差异属于本轮。`a2-delivery-git.txt` 保存整个脏工作树 status/diff stat，包含历史成果。

- `src/visuals/route-schematic.mjs`、`src/route-bundle.mjs`、`src/repository.mjs`：本地示意图默认可选，只有持久批准中的 `kind=schematic/use=route_overview/required=true` 才是必需槽；该义务无需虚构源图。已有冻结 manifest 不追溯放宽。
- `src/publication-eligibility.mjs`：manifest区分可选与required；省略槽只在slot fingerprint/route contract/省略记录一致且非required实拍时通过。仍校验未省略的可选图，坏图不能交付。ready只统计必需槽失败，不出现负数。
- `src/route-media.mjs`：可选冲突地图保留原source asset、route differences和 `route_omission`，状态使用现有 `skipped`，不静默删除。普通必需事实照片仍阻断。注意来源地图在通用归一化中也会设 factual 标志，所以此分支按地图用途及明确required义务判定。
- `src/pipeline.mjs`：可选本地renderer失败写入省略记录后继续独立审核；必需图继续失败并保留原恢复预算。媒体阶段不再因未来文本QA缺失而重复归一化。正文修订后有route bundle时先排媒体阶段，即使付费visual provider关闭也冻结新revision manifest。
- `src/content-blocks.mjs`、`src/media-delivery.mjs`：省略图不进入新页面AST及交付媒体集；required不因此放宽。
- `src/repository.mjs` 的 `assertDraftRouteCurrent`：下游操作同时要求最新冻结路线、当前同capture的source input/fragment，以及正文自身对应route artifact。只读详情仍允许明确展示批准v2/正文v1。
- Worker在generate_visuals、compose_frontend_page、review_draft、revise_draft、compose_commercial、compose_publish_page、push_wordpress_draft、publish_wordpress_post调用上述校验。`src/server.mjs`直接发布入口及WordPress deliveryGuard也调用。`uploadVisualMedia`即使WordPress关闭也先校验。
- 页面编排前的媒体上传只跳过尚未发生的文本QA；最终delivery仍强制文本QA，不可用 `requireRouteReview=false` 绕过。
- 页面保存有媒体输入版本比较；实际页面保存写入 `route_artifacts(kind=page)`。独立审核回执绑定当前slot状态/图注/alt/route contract/文件hash及页面payload、contract checksum、draft版本；晚到审核拒绝旧依赖。最终delivery核对当前页面组合回执，不能用新文字回执补盖旧页面。没有改schema。
- `src/route-bundle.mjs` 分类不再因来源存在fragments把知识稿自动强制为mixed；显式批准route_scope才进入mixed，itinerary仍要求路线证据。
- `frontend/src/workspaces/route-preview.jsx`、`frontend/src/App.jsx`：真实详情展示省略原因、错误码及保留正文/预算说明；没有伪造D的采用/续跑按钮。
- `test/route-production.test.mjs`、`test/route-media.test.mjs`、`test/route-decisions.test.mjs`、`test-support/route-production-fixture.mjs` 增加上述回归。浏览器fixture增加 `--optional`；`scripts/verify-stage02-route-omission-browser.js` 保存实际操作。

## 实际执行和覆盖

变更类别 PIPELINE / DATABASE_LOGIC，附小范围UI反馈；遵守AGENTS L1/L2/L3/L4及相邻问题扫描，无付费调用。

| 层级 | 结果与范围 |
|---|---|
| L1/L2 | PASS；最终90/90相关测试，日志 `a2-delivery-final.log`。这是测试执行数量，不是原T02-01～90整表验收。 |
| check/build | PASS；最终 `npm run check` 包含build与服务边界检查，日志 `a2-delivery-check.log`。另存 `a2-delivery-build.log`。 |
| L3 | PASS；既有获准work.sqlite的12历史稿manifest限定检查，schema81→82事务→回滚81，9类保护表指纹不变，无route补造/新Job/预算重置。`a2-delivery-historical.json`为命令合并输出，开头有SQLite实验警告，并非纯JSON文件。 |
| L4 | PASS；真实隔离CMS API/SQLite/Worker，登录→内容→详情→展开省略原因；API持久状态skipped、attempt_count=1、review_draft排队，与页面一致。`a2-delivery-browser.log`、`output/playwright/a2-optional-route-feedback.png`，已视觉检查。 |
| L5 | 本轮NOT REQUIRED；真实Provider质量NOT TESTED，未调用。 |
| L6 | NOT TESTED；未运行完整生产链或真实WordPress。 |
| Post-Fix Audit | ISSUES FOUND；本轮修复页面回执依赖、修订后媒体排队和未来QA导致重复归一化；下列A2缺口仍明确保留。 |

最终命令：

```text
node --test test/route-production.test.mjs test/route-media.test.mjs test/route-decisions.test.mjs test/route-bundle.test.mjs test/route-composition.test.mjs test/publication-eligibility.test.mjs test/content-recovery.test.mjs test/content-pipeline.test.mjs test/media-delivery.test.mjs
npm run check
node scripts/stage02-route-historical-replay.mjs D:/cms-phase02-media-replay-xiKzH1/work.sqlite --schematic
node scripts/stage02-route-media-browser-fixture.mjs --optional
npx --no-install --package @playwright/cli playwright-cli -s=a2optional run-code --filename=scripts/verify-stage02-route-omission-browser.js
```

前两轮新增回归曾发现：可选地图被归一化为factual导致未省略；v2负例错误地要求失败状态不变、以及SQLite null-prototype对象比较。已修正产品分支和测试断言，最终90/90通过；不把旧失败日志当最终验收。

可追踪正例复用 `a2-schematic-trace/request-trace.json` 与真实PNG/manifest旧证据；本轮actual Worker页面组合再跑实际ContentEngine主请求→route draft→renderer→媒体上传边界→真实FrontendContractConsumer组合，产出page receipt、排独立review。只有模型completeJson与WordPress网络边界受控；WordPress URL是example.invalid，不是外部写入。旧常规路径计数1主写作+1独立审核，0额外路线/SEO/diagram模型；本轮页面测试先断言主请求1，再另外调用实际review请求构建器作回执负例。回执负例人为控制审核响应通过，不作为真实语义质量证据。

负例：same-capture summary变化在review前拒绝；批准路线v2/正文v1在6类真实Worker任务全部失败ROUTE_VERSION_STALE，0模型/上传调用，正文/hash/revision不变，仅失败状态更新；可选省略后图注改变使旧审核失效；页面checksum变化使旧审核失效，新文字回执仍不能绕过缺失当前page receipt。required示意图故障恢复、三次预算、缺PNG重建、实际备份恢复仍在最终回归内通过。

## ROUTE-001～012 增量/剩余

| ID | 当前独立证据及确切剩余 |
|---|---|
| ROUTE-001 | 知识/显式mixed真实Repository规划分流新增PASS；知识与mixed实际writer/reviewer的完整对照矩阵仍待补。 |
| ROUTE-002 | 既有fragment/locator/panel证据保持；真实像素理解未测。 |
| ROUTE-003 | 既有批准持久化、只读旧正文保持；D组合仍待验。 |
| ROUTE-004 | 关键条件旧回归保持；多来源逐字段冲突和非关键未知降级仍是A2自身缺口。 |
| ROUTE-005 | 主请求与renderer隔离、页面组合后独立审核排队PASS；真实语言质量未测。 |
| ROUTE-006 | 可选冲突图保留省略记录，optional renderer不阻断正文，浏览器管理反馈PASS；required事实图负例旧回归保持。 |
| ROUTE-007 | 图用途/crop语义门禁保持；实际crop字节、转译质量PENDING_B/C。 |
| ROUTE-008 | 实际PNG/manifest和页面组合PASS；真实Provider与最终生产链未测。 |
| ROUTE-009 | 当前source/route/draft/media/text/page回执门禁新增；仍需补媒体在页面组合期间变化的实际异步负例及最终适配器组合证据，不能只凭入口代码宣称全链。 |
| ROUTE-010 | 已有审批/权限证据保持；D采用锁/outbox/完整上传续跑PENDING_D。 |
| ROUTE-011 | 新v2与旧v1真实Worker拒绝PASS；无隐式正文重写。 |
| ROUTE-012 | 原预算/备份恢复PASS；混合成功实拍/转译槽+失败槽的真实恢复矩阵、新page receipt备份恢复对照仍待补。 |

## T02-71～90 子行为，不提升整行

| ID | 当前证据/剩余 |
|---|---|
| T02-71 | 知识与mixed规划分流PASS，完整主请求/审核对照待补。 |
| T02-72 | 既有有向/重复站次证据保持，真实Provider未测。 |
| T02-73 | 已批准组合/缺连接拒绝保持，多来源逐字段冲突矩阵待补。 |
| T02-74 | required冲突拒绝与optional地图省略记录PASS。 |
| T02-75 | 可靠panel计划门禁保持，真实crop字节PENDING_B/C。 |
| T02-76 | 示意图媒体义务可选/required区分PASS，不强制逐站实拍。 |
| T02-77 | 既有真实PNG与本轮真实页面组合PASS。 |
| T02-78 | 跨日实体照片合法复用旧回归PASS。 |
| T02-79 | optional省略/required恢复/route版本失效区分PASS。 |
| T02-80 | source/target谱系保持；真实crop与远端视觉质量待验。 |
| T02-81 | 既有箭头/实体/manifest负例保持。 |
| T02-82 | 无新增主请求链；页面为确定性组合，独立review保留。 |
| T02-83 | v2旧正文Worker、媒体/页面变化的晚QA拒绝PASS；组合期间媒体变化异步负例待补。 |
| T02-84 | 已发布旧正文只读保持，route v2不触发重写。 |
| T02-85 | 原槽/PNG/预算真实恢复PASS；新增page receipt恢复对照待补，D组合待D。 |
| T02-86 | 真实省略原因展开PASS；既有审批/重试浏览器证据保留，完整上传采用PENDING_D。 |
| T02-87 | 真实renderer恢复保持；独立视觉Provider未测。 |
| T02-88 | optional图不增硬门槛新增PASS；旧manifest不追溯删required。 |
| T02-89 | 媒体/页面依赖变化后旧审核失效PASS；真实语言质量未测。 |
| T02-90 | 现实可行性仍NOT VERIFIED；非关键未知条件降级待补。 |

## 精确接续动作

1. ROUTE-012：扩展真实Worker/SQLite仅恢复图片测试到另一个成功实拍或转译槽保持原字节/receipt/attempt_count/预算，只有失败槽恢复。现有测试只充分覆盖同一个成功本地PNG复用和缺PNG重建，不能冒称混合媒体已验。
2. ROUTE-009/012：补页面组合运行期间媒体变化的晚结果负例；检查最终adapter/deliveryGuard入口的直接集成；新增page artifact与审核page dependency的真实backup/restore对照。现有代码已加校验，不需要重写整个审批链。
3. ROUTE-004：`normalizeRouteFragments`当前field_evidence不保留显式value，且无refs即拒绝；`routeConstraintDiagnostics`仍把所有不确定field/constraint当阻断。需在原要求内保留逐字段来源/约数/未知，对可省略的非关键值明确降级，同时关键身份/方向/方式/有效性不可用optional标志绕过。不要凭同实体就合并不同天/条件下合法连接，勿引入照片推算时长。
4. ROUTE-001：已修知识分流，但需要完整ContentEngine writer/reviewer对照证明：知识说明不产生整日路线义务，显式mixed仅保留批准路线部分。现有新测试只到真实getPlanningPackage。
5. 以上完成后按phase-02-a2.txt核对独立要求，才能A2_LOCAL_ACCEPTED。B/C真实crop及媒体组合、D采用锁/outbox、真实Provider质量继续单列，不进入这些阶段。

## 停止与副作用

浏览器会话a2optional已关闭。隔离服务PID17244通过 `C:/Users/Mloong/AppData/Local/Temp/cms-a2-media-browser-QTvfSL/STOP` 停止，exec会话33036已返回exit0；未停止用户其他进程。该测试库review_draft仍排队，没有Provider且服务已停止，未消费。测试库/截图/历史证据保留。

commit/push/deploy/生产DB读写/新生产导出/真实付费模型/生产WordPress/公开站前端修改均0；无子agent。仅CMS工作树、本地测试库和获准历史副本可回滚事务有操作。历史副本最终schema81。

current_authorized_step=NONE；phase_end_stop=true。A2已保存检查点，本轮停止；不退回A1，不进入B/C/D或阶段03。
