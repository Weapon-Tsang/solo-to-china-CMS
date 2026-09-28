# A2 独立本地能力验收

2026-09-28；**A2_LOCAL_ACCEPTED / READY_FOR_B_NEW_THREAD / STOPPED**。

仅表示phase-02-a2.txt第八节划定的A2独立本地能力通过；不表示阶段02整体完成、现实路线可行性、真实模型质量或完整生产链通过。阶段01、02-PRE、A1及此前A2全部成果/历史记录保留。未进入B/C/D或阶段03。

## 本轮完成的最后增量

1. 混合媒体真实恢复：已完成来源照片槽与失败的required本地示意槽共存，使用真实Recovery→Worker→SQLite恢复。原照片文件逐字节一致、完整槽记录（除更新时间）、回执/尝试次数/预算不变；正文、revision、content hash、冻结manifest不变，主写作仅一次。照片是明确合成的测试输入，来源分析响应受控；不冒称真实像素实体识别已验。
2. 页面组合期间媒体变化：实际ContentEngine页面请求已发出、受控外部响应返回期间修改图注；真实Worker拒绝晚到结果，原页面不被覆盖。为触发新组合而非缓存复用，仅在测试savepoint中移除该stage旧缓存，随后回滚；没有SQL伪造Job成功。
3. 新page/text_review route artifact、媒体/页面dependency hash经过真实backup/restore，恢复为migration-review，交付门禁重新核对通过，没有运行中Job。未来D事务/outbox不在该恢复证据中。
4. 真实createApplication装配的WordPress adapter/deliveryGuard：批准v2而正文v1时，普通draft和contract draft两个真实适配器入口均在网络前拒绝；fetch计数0。既有Worker各下游阶段v2/v1拒绝证据保持。没有WordPress写入。
5. 知识/mixed实际主请求和独立review对照：知识稿不带route bundle/table、不产生路线示意图义务；显式mixed带冻结route hash和路线表，claims仍可表达实用说明。每个方向1主请求+1独立review，均在真实ContentEngine请求构造器运行，只有completeJson边界受控。
6. route field_evidence保留value/applies_to/approximate；提取Schema明确unknown/null，既有来源提取请求直接携带，不另增模型链。相同明确适用范围的同一实体/有向连接存在不同字段值或不同约数精度时，报告双方expected/actual/source locators。不同适用范围不自动合并为冲突；不会凭照片推算时间或交通。
7. 非关键未知仅限duration/visit_duration/photo_tip白名单：省略输出值，保留原source snapshot及warning。身份、方向、交通方式、有效性等不能用optional标志降级。真实后台区分可继续的非关键说明与关键阻断，原始来源可展开，批准路线不显示不确定分钟数。
8. 两份独立真实SQLite来源经实际提取请求构造/保存、明确组合范围进入Worker，字段冲突在主写作前拒绝，0正文请求/0草稿。source ID不同有断言。显式批准fragment检索不再依赖其来源必须进入普通知识共识事实；仍核对current capture/input hash，旧片段不能混入。

## 文件身份与保留范围

app2.0.70、schema82、HEAD `e9f7c8e82ff760f4d18f2d2e0673452eb8744290` 未改变。`a2-integration-baseline.json`与`a2-integration-files.json`记录前后SHA256；部分未在入口采集的文件以前轮完成快照作before，明确标注来源。`a2-integration-git.txt`为最终全工作树status/diff stat，含历史未提交成果，不能把整份diff归于本轮。

本轮产品文件：`src/route-bundle.mjs`、`src/route-composition.mjs`、`src/ai/route-contract.mjs`、`src/repository.mjs`、`frontend/src/workspaces/route-preview.jsx`。新增/扩展证据：`test/route-production.test.mjs`、`test/route-composition.test.mjs`、`test/route-decisions.test.mjs`、`test-support/route-production-fixture.mjs`、`scripts/stage02-route-media-browser-fixture.mjs`、`scripts/verify-stage02-route-conditions-browser.js`。其余此前产品代码保持；代码身份文件也记录了未改的受检pipeline。

## 验证分层、命令和实际限制

变更类别 DATABASE_LOGIC / PIPELINE / AI_PROVIDER（来源Schema和提示约束）及小范围UI。用户禁止付费模型，依阶段第八节以真实请求构造和受控边界验证，本轮不执行真实Canary。

| 层级 | 结果 |
|---|---|
| L1 / L2 | PASS：101/101相关模块回归，`a2-integration-final.log`。最终仅增加精度比较与相应断言后，7/7受影响route-composition回归PASS，`a2-precision-final.log`；不把重复子集计成108项覆盖。 |
| check/build | PASS：`a2-integration-check.log`；最后精度改动另过node --check及相关测试；git diff --check PASS。 |
| L3 | PASS：`a2-integration-historical.log`；既有获准work.sqlite的12历史稿manifest及13批准owner限定回放，保护表指纹不变，schema82事务回滚至81，无历史route补造、无新Job或预算重置。 |
| L4 | PASS：`a2-integration-browser.log`、`output/playwright/a2-route-conditions.png`。真实CMS登录→内容详情→查看警告→展开来源；批准duration=null、原来源约15分钟仍保留、FROZEN且review_draft排队，已视觉检查。 |
| L5 | **NOT TESTED**：Schema的远端接受度、真实提取/翻译/文本与视觉质量均未验；按用户禁付费和A2第八节单列，不伪称Provider通过。 |
| L6 | **NOT TESTED**：完整生产链、真实WordPress、现实交通/票务/开放时间未验。 |
| Post-Fix Exploratory Audit | PASS（本轮限定范围）：同scope冲突/不同scope合法、约数差异、optional不能降级core、旧capture/input筛除、成功照片恢复不变、晚页面不覆盖、适配器0网络、恢复不自动运行、历史无伪造route。不是全库生产健康认证。 |

```text
node --test test/route-production.test.mjs test/route-composition.test.mjs test/route-bundle.test.mjs test/route-decisions.test.mjs test/route-media.test.mjs test/publication-eligibility.test.mjs test/content-pipeline.test.mjs test/content-recovery.test.mjs test/media-delivery.test.mjs test/content-engine.test.mjs test/provider-schema.test.mjs
node --test test/route-composition.test.mjs
npm run check
node scripts/stage02-route-historical-replay.mjs D:/cms-phase02-media-replay-xiKzH1/work.sqlite --schematic --decisions
node scripts/stage02-route-media-browser-fixture.mjs --optional --unknown-duration
npx --no-install --package @playwright/cli playwright-cli -s=a2conditions run-code --filename=scripts/verify-stage02-route-conditions-browser.js
```

单项调试日志：`a2-mixed-media.log`、`a2-page-backup.log`、`a2-mode-requests.log`、`a2-multisource-worker.log`、`a2-integration-contract.log`。测试输入曾发现URL含连字符被XHS adapter按同一externalId处理，现第二来源使用独立合法ID并显式断言source ID不同。无更改生产adapter来迁就fixture。

## ROUTE-001～012 独立/组合证据

| ID | A2独立本地结论 | 后续组合/外部限制 |
|---|---|---|
| ROUTE-001 | PASS：知识/route/mixed分类、实际写作审核请求及批准范围消费 | 实际模型语言质量未测 |
| ROUTE-002 | PASS：fragment有向连接/occurrence/locator/panel与请求构造，歧义不猜值 | 原图理解质量未测 |
| ROUTE-003 | PASS：冻结route、批准、source/target hash、实际SQLite和旧正文快照 | D采用事务消费待验 |
| ROUTE-004 | PASS：关键连接/实体/城市岸侧时序门禁；跨来源同scope逐字段/精度冲突；非关键未知省略 | 实时现实可行性NOT VERIFIED |
| ROUTE-005 | PASS：冻结骨架和媒体义务后一次主生成，独立review保留，无新增diagram/SEO模型链 | 真实模型质量未测 |
| ROUTE-006 | PASS：整日/子路线/实拍不同匹配；optional省略与管理反馈；required不放宽 | 人工采用完整组合待D |
| ROUTE-007 | PASS：faithful/recomposition与source/target差异请求、panel计划不冒充产物 | B/C实际crop字节与远端视觉质量待验 |
| ROUTE-008 | PASS：真实可解码PNG、render manifest、文章slot/图注与批准路线绑定、真实页面组合 | B通用衍生/C封面接收组合待验 |
| ROUTE-009 | PASS：实际文字/视觉请求约束、错误文本/箭头负例、媒体/page/text回执及当前版本门禁 | 真实远端QA语义质量未测 |
| ROUTE-010 | PASS：A2路线身份/权限/diff/提案/批准拒绝接口及浏览器 | 完整上传→采用锁/outbox→自动续跑PENDING_D |
| ROUTE-011 | PASS：已发布正文只读；v2批准不自动改v1正文；真实Worker/adapter拒绝混用 | 生产修复未执行 |
| ROUTE-012 | PASS：仅图恢复、混合成功槽保留、累计预算、迟到拒绝、新page依赖和migration-review恢复 | D尚不存在的事务/outbox恢复待D |

## T02-71～90 子行为矩阵（原68项/90用例编号不变）

| ID | 独立本地证据/未验组合 |
|---|---|
| T02-71 | PASS：知识/mixed实际writer/reviewer对照；知识无整日图义务 |
| T02-72 | PASS：原有向/重复访问occurrence/证据定位；真实理解未测 |
| T02-73 | PASS：两SQLite来源实际提取入参/字段持久化/Worker预写作冲突；同scope约数差异 |
| T02-74 | PASS：整日拓扑差异拒绝、可选冲突图明确省略 |
| T02-75 | PASS A2：连续子路线/panel用途与覆盖；实际crop产物PENDING_B/C |
| T02-76 | PASS：普通缺照片不等于缺路线，required媒体与核心连接分别门控 |
| T02-77 | PASS：真实PNG/manifest/slot、相关来源照片与真实页面组合；实拍来源语义质量未测 |
| T02-78 | PASS：同实体跨日普通照片合法，整日图严格；旧回归保持 |
| T02-79 | PASS：route缺口/required图片/optional冲突分别处理；恢复不重写 |
| T02-80 | PASS A2：source/target模式hash与实际本地示意；真实crop/远端转译待B/C |
| T02-81 | PASS：实体/Day/箭头/约数负例与独立QA请求；远端质量未测 |
| T02-82 | PASS：1主请求+1独立review；0额外路线/SEO/diagram调用 |
| T02-83 | PASS：旧draft/media/QA/page回执拒绝、组合期间媒体变化晚结果不覆盖 |
| T02-84 | PASS：既有已发布三日正文只读、明确批准不自动重写；生产未操作 |
| T02-85 | PASS A2：route/批准/媒体/PNG/预算/page/text回执真实恢复；PENDING_D组合 |
| T02-86 | PASS A2：已有审批/图片恢复及本轮警告真实浏览器；完整上传采用PENDING_D |
| T02-87 | PASS A2：真实renderer输入/输出检查、缺站/箭头/旧图负例与仅图恢复；远端视觉QA未测 |
| T02-88 | PASS：optional不加硬门槛，required事实图不能被示意图替代 |
| T02-89 | PASS：同hash错误路线表拒绝、缺独立审核拒绝、依赖变化审核失效；真实语言判断未测 |
| T02-90 | PASS A2：现有城市/岸侧/时序/过时限制门禁，非关键未知警告；现实可行性未核实 |

## 正向追踪、负例和预算

复用 `a2-schematic-trace/request-trace.json`、`a2-schematic-article.json/png` 的来源→批准→实际主请求/独立审核→真实PNG/manifest证据，renderer未改；当前101回归再次实际运行该路径。本轮另有知识/mixed请求对照、真实页面组合/回执/备份，以及双来源提取字段冲突在Worker发出正文请求前失败。

所有外部模型completeJson、图片分析和WordPress上传响应受控，真实远端请求0；本地sharp/OCR质量审计不收费。主写作失败未用虚构成功字段掩盖；混合恢复没有替换Pipeline/Recovery。原三次本地恢复预算、成功产物复用、新Job/路线变更不洗预算测试保持。请求质量不以hash自报代替真实语义；AI真实语义质量仍属于上表未测范围。

## B/C/D接口与停止

B接收source asset/route contract/use/approved_route_hash、实际本地PNG及render manifest、required媒体义务；实现通用原件/母图/网页衍生及实际crop字节。C消费同一目标路线和QA依赖，负责封面及接收能力。D复用已有A1共享上传与A2明确路线diff/决策接口，完成采用锁、outbox和续跑。crop计划、UI省略提示、批准记录均不代表上述组合已完成；A1 PDF与共享上传不重做。

Playwright会话a2conditions已关闭；隔离服务PID20424通过 `C:/Users/Mloong/AppData/Local/Temp/cms-a2-media-browser-Y7YejA/STOP` 停止，exec84567退出0。测试库排队review未消费，无后台agent。数据、截图及旧证据保留；未停止用户其他进程。

commit/push/deploy/生产数据库读写/新生产导出/真实付费模型/生产WordPress/公开站前端修改均0。只有本地CMS代码/测试数据与获准副本回滚事务。current_authorized_step=NONE；phase_end_stop=true。

**A2独立本地能力已完成验收，本轮已停止。阶段01、02-PRE和A1既有通过记录保持；真实Provider与B/C/D组合待验已单列。下一步可在同一CMS实际工作目录的新对话进入B，不重做已完成部分。阶段02整体尚未完成，生产权限仍未授予。**
