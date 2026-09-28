# A2 路线骨架开发检查点 · 2026-09-28

**A2_PARTIAL / NOT_READY_FOR_B / STOPPED**。本轮因上下文边界按独立提示词第十节保存接续检查点；不是完整验收。阶段01、02-PRE与A1原通过记录保留，A1 PDF报告仍是最新前置结论。不得退回A1或进入B/阶段03。

## A. 代码身份与实际实现

工作目录：`C:/Users/Mloong/Documents/ChatGPT/solo-to-china-CMS`；remote `https://github.com/Weapon-Tsang/solo-to-china-CMS.git`；main / HEAD `e9f7c8e82ff760f4d18f2d2e0673452eb8744290`。app 2.0.70；本地 schema 81→82。开始已有大量未提交阶段成果，全部保留；全工作树diff不能视为本轮diff。开始指纹见 [a2-baseline.json](a2-baseline.json)，结束指纹见 [a2-files.json](a2-files.json)。未记录开始指纹的文件不推测其修改前身份。

新增：`src/route-bundle.mjs`、`src/repositories/route-bundles.mjs`、`src/ai/route-contract.mjs`、`src/visuals/route-schematic.mjs`、`frontend/src/workspaces/route-preview.jsx`；两组route测试、两组route fixture、历史事务回放和浏览器fixture/验证脚本。

修改：`src/db.mjs`（migration82、Experience fragments、route bundles/artifacts）；`src/repository.mjs`（当前来源提取/批准冻结/版本与媒体检查/实际图产物/详情）；`src/ai/content-engine.mjs`（Experience、主生成、旧draft、repair、独立review实际请求与契约指纹）；`src/pipeline.mjs`（Worker消费冻结路线）；`src/publication-eligibility.mjs`（稿件与审核路线版本）；`src/backup.mjs`（表与真实文件）；`frontend/src/App.jsx`（原详情入口）；旧迁移测试和一个content-pipeline通用指南fixture。后者原标itinerary却无路线证据，现按真实fixture内容标first_time_guide；新增真实Worker路线负例保留严格门控。

支持单一明确来源路线的稳定day/stop occurrence/leg、重复地点、未知时长、来源与批准指纹分离、批准记录约束、持久化版本、写作前冻结、实际正文表格与独立审核约束。来源语义变化（包括同capture、同input的新fragment）会使旧冻结失效。真正生成并解码PNG，管理详情可查看，备份/恢复包含文件。**多来源组合、真实媒体采用链和完整修订恢复尚未完成。**

## B. 要求与子用例证据（没有整行升级为PASS）

| 要求 | 已覆盖本地子行为 | 本轮独立缺口及后续组合 |
|---|---|---|
| ROUTE-001 | 显式route/itinerary/walk分流，零fragment在Worker阻断 | 混合文识别、evidence_composed_route、批准替代路线未完成 |
| ROUTE-002 | 真实Experience调用契约、span定位、重复站次和有向leg持久化 | 图片panel/region/箭头字段级提取与证据未完成 |
| ROUTE-003 | SQLite批准版本、内容hash、幂等和迟到拒绝 | 变更提案与批准决策接口未完成 |
| ROUTE-004 | 身份、连接、顺序、时长单位/约数、冲突、证据与required媒体分开 | 城市/河岸/时间窗及过时条件的可行性诊断未完成 |
| ROUTE-005 | 实际主生成/旧draft/repair/narrative携带冻结数据与输入预算门控 | 完整批准scope解析、组合路线选择未完成 |
| ROUTE-006 | helper区分单点照片与全日图，并输出语义差异 | 必须接入真实normalizeVisuals、media repair与用途决策；helper不是采用链验收 |
| ROUTE-007 | 原/目标hash和两种变换模式数据 | 真实转译请求构建/受控响应门控未完成；远端质量NOT TESTED；panel字节链待B/C |
| ROUTE-008 | 同骨架派生表格和真实PNG，manifest/解码/hash/可视检查 | 图尚未接入article_visuals及required媒体manifest；真实图注/摘要全链待接 |
| ROUTE-009 | 真正独立review请求、caption输入、route audit必需、错表负例 | 任意正文语义由受控模型边界提供，不能证明真实语义质量；视觉QA请求集成缺失 |
| ROUTE-010 | 单点/全图差异helper与批准版本基础 | A2权限/diff/决策接口未完成；完整上传采用锁/outbox/续跑PENDING_D |
| ROUTE-011 | 迟到拒绝，来源变化不自动重写已有稿 | 历史已发布稿readonly route snapshot、媒体许可与路线提案决策未完成 |
| ROUTE-012 | route表/真实PNG备份恢复、migration-review、历史事务回滚 | 完整依赖失效、槽位累计预算、图失败仅恢复图未完成；D未来事务不伪验 |

| 用例 | 当前证据与明确未覆盖 |
|---|---|
| T02-71 | route分类、实际Worker先冻结PASS；混合/知识全矩阵未完成 |
| T02-72 | 重复站次和定向连接PASS；真实图像箭头提取NOT TESTED |
| T02-73 | unknown/approx/连接与冲突负例PASS；多来源逐字段合并未完成 |
| T02-74 | 全日图错序/范围helper拒绝PASS；实际媒体执行入口未接 |
| T02-75 | 不匹配输出差异；panel用途与受控裁剪未完成，原件上传沿用A1 |
| T02-76 | route证据与required媒体诊断分开PASS；完整生产采用未完成 |
| T02-77 | 实际PNG与manifest PASS；相关实拍与文章槽位组合未完成 |
| T02-78 | 另一Day同实体照片helper可用PASS；实际采用链未完成 |
| T02-79 | 三类错误基础数据；具体恢复动作和已确认稿冲突流程未完成 |
| T02-80 | helper两模式/独立hash及真实recomposition示意PASS；转译/裁剪字节未验 |
| T02-81 | 身份、错序、交通负例PASS；指定地名/pixel QA完整样本未验 |
| T02-82 | 实际主请求1、独立review1、额外route/SEO/diagram请求0；外部边界mock |
| T02-83 | 旧revision/来源语义/正文表格自报同hash负例PASS；完整跨槽位晚到未验 |
| T02-84 | 已有稿保持负例；已发布三日稿权限/提案完整fixture未实现 |
| T02-85 | route数据与真实文件backup/restore PASS；人工关系+暂停媒体任务组合未验，D数据PENDING_D |
| T02-86 | 实际详情预览/键盘/PNG/刷新PASS；A2决策接口未完成，完整采用续跑PENDING_D |
| T02-87 | 实际renderer缺站/错输入、manifest错箭头、旧/不同PNG拒绝PASS；视觉QA与局部恢复未接 |
| T02-88 | 不按逐站照片新增义务，required媒体独立门控；实际槽位替代全链未验 |
| T02-89 | 同hash实际表格交通错、独立审核缺失被拒PASS；局部修复累计预算未完成 |
| T02-90 | UI明确现实可行性未核验；过时/矛盾限制的完整业务诊断未完成 |

## C–E. 正向追踪、负例、调用与测试

`test-support/route-production-fixture.mjs`通过真实capture/segments/claims/Experience保存生成证据，初始候选与批准由fixture建立；没有SQL把Job改成功。来源“East Hall → West Hall → East Hall；步行约15分钟，巴士返回”是合成样本，不是真实旅游建议。

链路：当前Experience fragments → Repository批准冻结 → ContentEngine实际主生成入参 → 独立review入参 → sharp实际PNG与draw manifest。见 [request-trace.json](a2/request-trace.json)、[route-example.json](a2/route-example.json)、[真实PNG](a2/route-example.png)。真实Worker运行plan阶段生成草稿和图；没有fragment时实际Worker失败且模型调用为0。

受控适配器只替换`client.completeJson`外部边界；主请求1、独立文本review1、专门route规划/SEO/示意模型请求0。语义review的route部分通过但整体编辑review故意返回passed:false，不能据此声称健康文章已交付。付费调用0；没有真实视觉QA、地理/开放时间核实或WordPress投递。已有budget失败和版本拒绝有测试，槽位/修订累计预算集成尚未实现。

最终命令：`node --test test/route-bundle.test.mjs test/route-production.test.mjs test/article-bundle.test.mjs test/media-availability.test.mjs test/backup.test.mjs test/content-pipeline.test.mjs test/publication-eligibility.test.mjs test/migration-seventy-nine.test.mjs test/migration-eighty.test.mjs test/pdf-source-supplements.test.mjs test/pipeline-artifacts.test.mjs`；**60/60 PASS**，见[a2-module.log](a2-module.log)。`npm run check` PASS（含构建，既有bundle大小提示）；`git diff --check` PASS。

| 验证层 | 结果与范围 |
|---|---|
| L1 Targeted Tests | PASS，路线契约/负例/真实renderer |
| L2 Module Regression | PASS，上述60项与check，非全仓全部业务 |
| L3 Production DB Replay | PASS，仅既有获准work副本migration82事务演练并回滚；不是现实路线语义验收 |
| L4 Browser E2E | PASS，仅真实本地详情、来源展开键盘、PNG解码、390宽无溢出及1440截图、刷新版本保持；完整A2操作NOT TESTED |
| L5 Real Provider Canary | NOT TESTED，提示词禁止本轮付费调用 |
| L6 Full Production Replay | NOT TESTED，本轮非发布，完整A2链亦未完成 |
| Post-Fix Exploratory Audit | ISSUES FOUND：下列集成缺口未关闭；已修复当前source同input更新漏检、caption遗漏、实际PNG路径404，相关窄回归PASS |

浏览器证据[a2-browser.log](a2-browser.log)，截图`output/playwright/a2-route-final-390.png`、`a2-route-final-1440.png`。已查看实际示意PNG与桌面/390截图，文字、三站回程与箭头可见；这不等同任意用户图片视觉QA。

## F. 历史与恢复

复用`D:/cms-phase02-media-replay-xiKzH1/work.sqlite`，真实migration在事务内执行后ROLLBACK，schema回81；84来源、1,454资产、12草稿、26文章图、12写作包、18,415 jobs、6,453模型指标、12投递等受保护表指纹保持，未制造历史route。详见[a2-historical-replay.json](a2-historical-replay.json)与`scripts/stage02-route-historical-replay.mjs`。未新导出、未读取生产私有库、未复制大库、未消费历史jobs。

route测试实际备份并migration-review恢复route_bundles/route_artifacts及PNG，核对文件hash；旧schema fixture回归通过。尚未验证route+所有A1人工关系+暂停媒体任务组合，也没有虚构D采用/outbox数据。

## G–H. 精确接续顺序与现有接口

1. ROUTE-001/002/004/005：补全混合内容、evidence_composed_route与批准scope选择；panel/region和字段证据；冻结前现实条件/缺口诊断。当前compileRouteBundle只允许一个fragment，不能偷选或靠照片删天数。
2. ROUTE-006/007/009/010：把`compareRouteMedia`接入实际`normalizeVisuals`/media repair/转译与视觉QA请求；完善子图覆盖/用途、实体词表和版本门控。它目前只是helper，不能宣称实际图片被安全采用。真实Provider继续NOT TESTED。
3. ROUTE-003/010/011：提供供D消费的实际路线变更proposal/diff/权限决策接口；已批准或已发布正文默认保持，老稿只读路线快照。没有API时不能编造采用按钮。
4. ROUTE-008/012：把已生成route artifact接入article_visuals、媒体manifest和准确依赖；实现图失败仅恢复图、累计槽位预算与旧QA失效；新增真实Worker回归。
5. 完成以上A2自身缺口后，补相邻审计、必要浏览器错误/决策流与组合恢复证据，才判断A2_LOCAL_ACCEPTED。不要重跑已完成A1，也不要求重发原输入。

当前可复用接口：`src/route-bundle.mjs`的normalizeRouteFragments/compileRouteBundle/assertFrozenRoute/compareRouteMedia/validateRouteDraft；`src/repositories/route-bundles.mjs`持久化与版本artifact；Repository规划包`route_bundle`、详情`route_bundle`/`route_render`；`ensureRouteSchematic`/`routeRenderPreview`及`/media/<basename>`实际文件；renderer manifest记录draw_operations和hash。**这些是当前内部接口，尚无D路线批准/采用决策HTTP接口。**

B负责通用母图/衍生，C负责封面/接收；A2已有示意图不可冒充它们完整完成。A1 PDF共享上传仅来源补图/确认，保留原PDF，不是自动抽图也不是文章采用。D未来负责采用锁/outbox/续跑；A2上述应提供接口不可推给D形成循环。

## I. 副作用与停止

[git status](a2-git-status.txt)及[diff stat](a2-diff-stat.txt)包含预先存在的未提交成果。无commit、push、部署、Cloud Build、生产备份/迁移/读写、WordPress写、公开前端仓库修改、真实AI或地图请求。仅本地代码/证据/隔离数据；npm依赖用原lock的`npm ci --ignore-scripts --no-audit --no-fund`恢复（vite8.2.2），未改package/lock。

本轮命名浏览器a2route已关闭，自己创建的API fixture通过STOP正常退出（保留临时数据），最终测试已结束；未停止用户服务，无后台子agent。

current_authorized_step=NONE

phase_end_stop=true
