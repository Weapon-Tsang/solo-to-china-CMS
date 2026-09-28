# A2 路线审批与局部覆盖检查点 · 2026-09-28

**A2_PARTIAL / NOT_READY_FOR_B / STOPPED**。这是 phase-02-a2.txt 第十节允许的接续检查点，不是完整 A2 验收。阶段01、02-PRE、A1成果保持；原68项/90用例不改号、不整行提升。上一份 a2-resume-checkpoint.md 的未变证据继续有效，本报告记录本轮增量。

## 身份与实际改动

工作目录 C:/Users/Mloong/Documents/ChatGPT/solo-to-china-CMS；main，HEAD e9f7c8e82ff760f4d18f2d2e0673452eb8744290；app2.0.70/schema82不变。开始身份见 a2-decisions-baseline.json，结束 hash/status/diff 见 a2-decisions-files.json、a2-decisions-git.txt。未记初始 hash 的文件不声称掌握修改前字节。所有先前脏工作树和历史证据保留。

- 新增 src/repositories/route-decisions.mjs：从当前数据库证据编译提案，持久化字段差异、原因、来源指纹、base version；明确批准/拒绝，事务版本检查、幂等、旧来源拒绝。
- src/repository.mjs：提取 currentRouteFragments 供规划和审批共同使用；新增三个审批方法。审批不写正文、writing packet、QA、图片槽位、job、budget或WordPress。
- src/server.mjs：真实管理员 GET/POST /api/content/:ownerId/route-decisions 与 POST /api/content/:ownerId/route-decisions/:proposalId；沿用登录与origin保护。
- frontend/src/workspaces/route-decisions.jsx、route-preview.jsx、App.jsx：现有详情内提案、顺序选择、差异、批准/拒绝、错误刷新和只读旧正文快照；新路线不冒用旧示意图。
- src/route-bundle.mjs、src/route-media.mjs：subroute_diagram 必须是同日连续批准站次；日图只含日内连接；合同target使用实际选定范围。panel必须有同asset/panel、合法归一化区域及完整片段证据。裁剪计划保留 source hash/范围，但强制 crop_bytes_and_qa_pending，不将整张拼图当作已裁剪产物。
- 新增 test/route-decisions.test.mjs、test-support/route-decision-fixture.mjs；扩展 route-media 测试、三日生产fixture、browser fixture、历史回放 --decisions；新增实际浏览器操作脚本 verify-stage02-route-decisions-browser.js。

权限边界：使用项目既有管理员身份。authority=route_revision 是明确操作意图门禁，media_only拒绝；它不是新增的独立用户角色/RBAC系统。D以后必须消费这一边界，不能把媒体许可提升为路线许可。

## 验证、真实覆盖与副作用

Change class: DATABASE_LOGIC / PIPELINE / UI；未改模型prompt/schema。本轮付费调用0。

| 层级 | 状态与证据 |
|---|---|
| L1 Targeted Tests | PASS：6个审批真实SQLite/HTTP测试，子路线/panel范围正负例；a2-decisions-targeted.log、a2-decisions-panel.log |
| L2 Module Regression | PASS：最终73/73，a2-decisions-final.log；npm run check/build PASS，a2-decisions-check.log。最终后端小改由模块测试及 node --check 覆盖；UI未在build后变化。diff --check PASS，仅已有CRLF提示；构建有>500KB chunk提示 |
| L3 Production DB Replay | PASS：a2-decisions-historical.json。仅既有获准 D:/cms-phase02-media-replay-xiKzH1/work.sqlite；migration82事务后回滚81；13个批准owner全部unknown/can_propose=false，不补造路线。84sources、1454assets、12drafts、26visuals、12packets、18415jobs、6453模型记录、12发布记录、151提取run指纹不变 |
| L4 Browser E2E | PASS：a2-decisions-browser-final.log。真实隔离CMS/SQLite：保存提案→字段差异→拒绝→再提案→键盘批准v2→正文v1→刷新持久化；另一真实客户端批准v3后，旧表单显示版本错误，刷新成功。320/768/1024/1440无横向溢出，pageErrors为空 |
| L5 Real Provider Canary | NOT REQUIRED：本轮未改Provider请求；真实图像语义/像素质量仍NOT TESTED，不继承mock为远端验收 |
| L6 Full Production Replay | NOT TESTED：完整A2及正式发布链尚未贯通 |
| Post-Fix Exploratory Audit | ISSUES FOUND：补严空payload、日ID/leg长度；旧snapshot检索直接join artifact/draft避免任取稿件；检查旧来源/并发审批/备份恢复/子图冒充整日。剩余集成缺口见下表 |

浏览器截图 output/playwright/a2-decisions-1440.png 与 a2-decisions-320.png 已可视检查。浏览器使用合成三日已发布库存记录，没有访问WordPress。浏览器记录中的currentRevision=2是第一次批准断言点；之后另一个客户端批准v3并验证刷新，非版本不一致。

请求边界：审批/拒绝不调用模型、不排队。最终模块测试中的写作/独立审核/视觉请求仅在外部HTTP边界提供受控响应，Repository、Worker、SQLite、真实文件renderer未被整体mock。route-production正例仍断言1主写作+1独立文字审核、0专门路线/SEO/示意模型调用。真实媒体像素理解和现实交通开放时间未验证。

本地备份恢复已实际覆盖 route_bundles、route_artifacts（含pending proposal与decision）、已发布正文及发布关联；既有renderer文件恢复测试本轮重跑。恢复为 migration-review，不启动工作。D采用锁/outbox尚不存在，不声称已测。

实际副作用：commit/push/deploy/生产读写/付费模型/生产WordPress/公开前端修改均0。只改CMS本地代码与测试证据。自己启动的两个隔离browser fixture已写STOP，浏览器a2decisions已关闭；新服务退出0，数据保留。不停止其他用户服务。

## ROUTE增量与剩余责任

| ID | 当前新增/复用证据 | 未完成范围 |
|---|---|---|
| ROUTE-001 | 来源路线/批准证据组合有真实UI与API | 知识/混合分流完整矩阵仍需收齐 |
| ROUTE-002 | panel范围与asset/片段证据匹配负例 | 真实图片提取语义NOT TESTED |
| ROUTE-003 | 真实proposal/diff/decision持久化与事务 | 已完成本轮审批范围；D消费接口待验 |
| ROUTE-004 | 既有条件诊断回归 | 多来源逐字段冲突与非关键条件降级矩阵 |
| ROUTE-005 | 操作员选择/排列来源日，既有实际主请求回归 | 细粒度stop/leg组合API已有，UI目前以整日为单位 |
| ROUTE-006 | 子路线连续覆盖、日内边、实际normalizeVisuals门禁 | 可选冲突图省略的完整管理反馈、示意图文章槽位 |
| ROUTE-007 | panel来源/crop语义持久在失败槽位，不交付原全图 | 实际裁剪字节/谱系/独立QA归B/C组合；真实Provider未测 |
| ROUTE-008 | 真实本地PNG/manifest/备份回归 | article_visuals/required manifest、图注摘要交付依赖仍为A2缺口 |
| ROUTE-009 | 既有独立QA和迟到图门禁回归 | 所有最终交付入口的完整route/media/current-source门禁 |
| ROUTE-010 | 审批API/字段diff/明确意图、media_only拒绝 | D采用锁/outbox/续跑PENDING_D |
| ROUTE-011 | 合成已发布三日稿API/UI/旧snapshot、13真实历史owner只读 | 历史无快照不自动建立；新旧正文完整交付依赖仍待接 |
| ROUTE-012 | 提案/决策真实恢复；旧累计预算回归 | 图失败仅恢复图，完整槽位失效依赖仍为A2缺口 |

## T02增量矩阵

以下均为子行为，不提升原90用例整行状态。

| 用例 | 本轮范围/剩余 |
|---|---|
| T02-71 | 组合选择入口/API；完整混合分类矩阵待补 |
| T02-72 | panel合法/错误范围及不同panel拒绝；真实图像理解未测 |
| T02-73 | 组合顺序审批与缺连接不能批准；逐字段冲突消解待补 |
| T02-74 | 冲突全日图失败槽位继续回归 |
| T02-75 | crop计划不冒充字节，后续B/C真实裁剪待验 |
| T02-76 | 审批与媒体许可分离；全生产采用待验 |
| T02-77 | 本地PNG/manifest回归；文章槽位尚未接完 |
| T02-78 | 合法单点图复用回归，不推断当日拍摄 |
| T02-79 | 子路线/错误panel明确保留gap；完整恢复入口待接 |
| T02-80 | 来源/target范围hash及crop语义；实际crop产物未做 |
| T02-81 | 同方向连续站次、源panel证据、既有QA错误箭头拒绝 |
| T02-82 | 既有真实请求构建计数回归；审批新增模型调用0 |
| T02-83 | stale source/proposal/base hash、另客户端审批、幂等负例；全槽位失效待接 |
| T02-84 | 已发布三日正文不变、snapshot只读、媒体许可拒绝；真实历史无snapshot保持unknown |
| T02-85 | proposal/decision/route文件本地恢复PASS；D组合待验 |
| T02-86 | 真实提案/拒绝/键盘批准/并发冲突UI；完整D采用PENDING_D |
| T02-87 | renderer负例/QA回归；仅恢复图未贯通 |
| T02-88 | 子图不冒充整日，不替代required实拍；示意槽位待接 |
| T02-89 | 审批保持正文/budget/jobs；旧预算回归；全文局部修复预算待补 |
| T02-90 | 原条件诊断继续回归；现实可行性NOT VERIFIED |

可追踪正例：test-support/route-production-fixture.mjs的当前capture/Experience → getPlanningPackage存储冻结route → 实际Worker articleBundle/独立review输入 → renderRouteSchematic真实PNG/manifest。test/route-production.test.mjs在最终73测试中重跑。新增三日例在 publishedRouteFixture → routeDecisionState → propose → decide → current v2/article v1 → 实际备份恢复中追踪；本例没有伪称新路线已重新写作。

负例包括缺连接不能批准、source改变不能批准、media_only不能批准、旧提案版本不能覆盖、历史无snapshot不补造、部分图不能当整日、错panel/越界crop拒绝；迟到图/同槽位预算回归沿原生产测试。

## 精确下一动作

1. ROUTE-008/012：把确定性示意输出接入实际article_visuals与required manifest，图注/摘要按同一route hash生成；局部渲染失败只保留图片失败与预算，不让主写作重跑。当前pipeline plan_content仍在写作前直接ensureRouteSchematic，不能据本轮审批功能宣称此链完成。
2. ROUTE-009/011/012：检查实际页面组合、独立QA、最终交付入口对当前route/source/slot/receipt的依赖；v2批准但正文v1的状态需保持保护，不能隐式生产。建立仅图片恢复的真实fixture。
3. ROUTE-001/004/006：补知识/混合分流、逐字段冲突与非关键条件、可选图省略反馈；不是再重复现有审批/浏览器/历史回放。
4. B/C只消费panel_scope/crop来源与target，不把计划当字节；D消费route-decisions明确审批边界与diff并实现采用事务。继续使用A1共享上传能力，不重做上传。

未进入B/C/D/阶段03。current_authorized_step=NONE；phase_end_stop=true。
