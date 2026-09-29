# 阶段03续作 resume-03 · 2026-09-28

**BLOCKED / PARTIAL_IMPLEMENTATION / STOPPED**。本轮继续完成了具体修复与验证，但全阶段本地硬要求仍未齐，不进入04。完整输入、30项需求与44用例保留；下面是对 resume-02 的增量，不覆盖旧证据。

## 范围与身份

- 根目录 `C:/Users/Mloong/Documents/ChatGPT/solo-to-china-CMS`；origin `https://github.com/Weapon-Tsang/solo-to-china-CMS.git`；main；HEAD `490dd7464d4beb46d3f89a578337c253917fbf7a`。
- Windows / Node v24.14.0 / 8逻辑CPU / RAM 17,107,996,672 bytes。DEVELOPMENT。开始约17:54，收尾约18:28（Asia/Shanghai）；精确证据时间以日志为准。
- 风险分类：PIPELINE（本地确定性审核与路线媒体计划）、LOCAL_LOGIC（空QA处理）、测试设施。没有改模型prompt、请求schema或transport；没有schema migration。app2.0.70 / schema83 / 内容策略3.9保持。
- 前置01/02按 STATUS 与阶段02最终本地验收复用；本轮没有重跑所有前阶段。全部已有未提交成果保留，不commit/push。
- 完整v1.4输入 `phases/phase-03.txt` SHA256保持 `cdfb039e8d92c5a4c5e1a51a05fce924c71fc45cdb654895a7df3459bebfa91a`。本轮代码与证据hash见 identity.json。

## 实际修复

1. **封面审计500**：已证实根因是 `evaluateCoverCandidate` 对显式 `quality_qa:null` 读取 `.status`。现在空值/非对象/数组均按缺少QA拒绝资格，返回待审核而不是崩溃。鉴权HTTP回归与后台上传/冲突重开均复验200，未放宽图像资格。
2. **本地路线被误判成模型造图**：新的实际队列组合测试发现 `applyDeterministicGates` 未认可 `render_route_schematic`，路线已完成本地渲染及合同页面编排后仍报 `image_strategy_invalid`，进入不必要的正文修补。现在只有冻结路线、对应route/source hash与revision、准确图注/alt、非实拍声明匹配的本地示意计划可通过。缺路线、旧hash、错误图注、伪装实拍负例仍拒绝。文件/渲染/审核有效性继续由交付门禁核对。
3. **三日循环路线alt被误判关键词堆砌**：新示意图使用简洁范围描述，完整站点顺序留在图注与正文；新增内部 `route_summary.alt_version=2`，不改外部合同。无版本旧记录按v1核对，未知版本拒绝。旧稿正文/URL/SEO字段不自动改写。旧v1渲染回执兼容测试通过；未批量迁移历史alt，旧多日重复alt仍可能触发原交付门禁，需要显式媒体修订，不能称所有历史稿已修复。
4. 浏览器脚本不再依赖上轮临时目录；fixture生成明确的合成PNG到 `output/playwright/phase03-synthetic.png`。脚本现在记录并拒绝所有同源500，额外断言路线稿cover-audit返回200。

## 组合链的真实覆盖

`test/stage03-route-chain.test.mjs` 运行真实 Repository / Pipeline jobs / ContentEngine builders与本地门禁；只有外部模型返回受控。不直接更新Job为成功、不改DB伪造QA通过。

- 单来源一日路线、同来源三个有证据day组合的路线、含路线scope的attraction-guide模式，分别走：已存来源提取/实体→冻结路线→主生成→本地PNG→真实WebP→固定合同页面→独立审核→商业空层→publish package→HTTP附件/draft→回执→HTML回读。
- 每条链严格 `article_bundle_v1` 一次、`quality_review_v3` 一次，无repair/独立SEO/GEO/图片模型请求。三日样本保留每个day/重复stop/步行约15分钟/未知公交时长，不填0。
- 固定外部合同1.4.1、commit `0c4b327287c016aee138f735a8a13eb2baa74542`、组合hash `9154dc68540d9922c11109e4cfe00aee871d850e61124fd7edb624ee20b2c422`，只从既有授权本地work副本读取公共合同JSON。复制到测试依赖，未改变任一合同字段，未读取新生产数据或前端仓库。
- 每条HTTP链只上传一次实际WebP、保存一次draft、回读一次HTML；合同验证、实际解码尺寸/hash/谱系及可见事实检查通过。HTML为受控接收器按实际payload渲染，**不是PHP/WP**。逻辑页面地址为稿件的候选canonical，不是WordPress预览URL兼容证明。
- `route-chain/` 保存每类实际 package、HTML、PNG、WebP、render manifest和检查结果。人工查看三日WebP：三段Day标签、向下箭头、步行约数、公交无伪造分钟数与“非实时导航”声明可读。这不是独立模型像素语义QA。
- **仍不等于完整INT-006**：证据组合目前来自一个来源的三天；mixed只有路线scope模式，未增加独立普通知识段的完整组合；普通实拍/独立封面/人工补图尚未接到这同一HTTP链。真实模型语义质量、原图转译像素QA、真实WP均未执行。

## 已执行验证

命令均从CMS根执行；PASS命令exit 0。早期诊断失败（测试接收器缺comparison_table、测试review未返回mandatory checks、接口图片夹具路径）已定位修正；不能把这些初始失败隐去当从未发生。

| 层级 | 状态 | 命令与实际范围 |
|---|---|---|
| L1 Targeted Tests | PASS | `node --test test/cover-audit.test.mjs` 6/6；`cover-audit.log`。最终路线链含旧alt回执与负例由下列模块组覆盖。 |
| L2 Module Regression | PASS | `pipeline-final.log` 59/59：stage03-route-chain、route-production、route-decisions、route-media、route-bundle、publication-eligibility、content-pipeline、media-delivery。另 `adjacent.log` 16/16：cover-audit、cover-selection、cover-delivery、manual-route-media。组间重叠不相加。 |
| L3 Production DB Replay | PASS（限定） | `node scripts/stage03-historical-replay.mjs D:/cms-phase02-media-replay-xiKzH1/work.sqlite`；`historical.log`。仅既有work副本，12稿上传前后实际封面审计、null QA拒绝、原文与保护表保持，最终ROLLBACK。没有历史路线全链/像素证明。 |
| L4 Browser E2E | PASS（定向） | `route-browser.log`、`route-reopen.log`；真实后台相符照片上传/确认、本地处理、Day冲突保存、重开，四宽度320/768/1024/1440无面板溢出；pageerror/outbound/同源500均0，cover-audit200。两张预览实际解码800×500。 |
| L5 Real Provider Canary | NOT REQUIRED（本轮改动） | 仅确定性后处理与媒体计划改动；没有改变请求/prompt/schema，真实模型未授权未调用。全阶段真实语义质量NOT TESTED。 |
| L6 Full Production Replay | NOT TESTED | 新增真实CMS队列至HTTP链是合成隔离回放，不是完整生产库Capture至QA/真实WP全链。 |
| Post-Fix Exploratory Audit | ISSUES FOUND | 500之外发现并修复本地示意策略和三日alt阻断；仍有下面列出的阶段缺口与历史限制。 |

`npm run check` PASS（`check.log`，包含build/语法/服务边界）；`git diff --check` PASS（`diff-check.log`，仅CRLF提示）。未默认跑全量npm test、release gate、Cloud Build或付费Canary。

L4浏览器进程在本轮500修复后启动，之后没有热加载新的确定性审核/alt策略。它只证明定向补图/冲突/封面审计流程；最终审核和alt策略由最新59项模块及实际HTTP链验证，不冒充最终代码的完整浏览器业务链。

历史副本仍是84 sources / 1454 assets / 5334 claims / 12 drafts，18415 jobs / 6453 model metrics；12稿均无可用route快照，26原Linux母图不可达。合成新上传不作为历史图片。事务回滚后6保护表hash及schema/count还原，committed_writes=0、external_calls=0。

## PERF-005

同机、Node24、loopback、同标准初始合成数据（1000来源/10000claims/300稿/3000媒体元数据）、API模式。新flag只用于隔离benchmark。负载在同一个API进程中执行实际chunk/hash/finish与实际PNG renderer；上传自然新增15条人工来源/媒体，非将空库或缩小数据当基准。Worker并发未加入这一新子场景，既有resume-02 Worker场景保留原范围。

| 模式 | 冷菜单P50/P95 | 缓存菜单P50/P95 | 5类API最高P95 |
|---|---|---|---|
| idle | 109 / 150ms | 61 / 90ms | 9.220ms |
| 上传/hash/finish＋路线渲染 | 139/180ms | 79/133ms | 46.973ms |

每组菜单与每类API均30有效样本，nearest-rank；阈值未改（1000/200/300ms）。负载15个有效23,083,435-byte PNG上传、132次真实路线渲染；单文件/单块顺序、有界，未同时把全库图载入内存。API进程峰值RSS292,929,536 bytes，浏览器观察heap峰值141,974,677 bytes（Chromium performance.memory近似值，不冒充精确OS峰值）。每个菜单样本时间都在实际上传开始/最后完成之间，未达到16文件负载上限；renderer同时运行。结果与原始时间/内存样本见 `performance-summary.json`、`api-media-synchronized.json`、`menu-media-synchronized.log`、`api-idle.json`、`menu-idle.log`。

第一轮未同步的 `api-media-load.json` / `menu-media-load.log`仅诊断，**不用于上述验收**；旧脚本scope字符串仍写“no upload”，该文本不符合其运行flag，保留原始日志并在此纠正。之后使用开始标记同步重测。负载不是CMS Worker队列、浏览器文件hash Worker、真实Provider或正式生产规模长稳压测。

可重现命令：

```text
node scripts/stage03-browser-fixture.mjs
npx --yes --package @playwright/cli playwright-cli -s=phase03resume open <fixture-url>
# 使用fixture账户登录，进入三日文章详情后执行：
npx --yes --package @playwright/cli playwright-cli -s=phase03resume run-code --filename scripts/verify-stage03-route-upload.js
node scripts/benchmark-local-stage01.mjs --media-load --media-load-wait --browser-hold --output <new-report.json>
# 打开其url后，在输出的临时目录建立 .media-load-start；运行菜单脚本；完成后建立 .browser-stop。
npx --yes --package @playwright/cli playwright-cli -s=phase03load run-code --filename scripts/verify-stage03-menu-performance.js
```

路径由每次fixture输出，不复用已停止服务端口。停止浏览器fixture：在其输出stopFile写空文件；benchmark用自身.browser-stop；只关闭本轮独立浏览器会话，不停用户服务。

## 需求／用例增量与下一轮顺序

完整[30需求/44用例台账](../../../acceptance/phase-03.md)与前两轮增量继续适用，未提及的条目不因本轮模块通过自动升级。

| ID | 本轮增量 | 当前边界 |
|---|---|---|
| GEO-006/008、INT-006；T03-18/35/37/41/42 | 固定合同三模式CMS队列、真实PNG/WebP/HTTP/HTML；1主生成+1独立审核；三日alt修复 | PARTIAL；缺同链实拍/封面/人工补图、跨来源组合、真实原图转译/像素QA |
| INT-007；T03-29/39/40/43 | 上轮cover-audit500已修；后台照片/Day冲突重开与全同源500断言通过 | PARTIAL；冲突图仍只有提示，缺可执行子图/按骨架重编确认采用路径 |
| INT-002/005/008；T03-25/33/44 | 标准规模真实上传/hash/finish/渲染负载30样本及内存 | PARTIAL；三种变更快照/迟到worker完整成组恢复仍缺；浏览器hash负载同场未测 |
| INT-001/003/004；T03-23/24/26/27/28/31/32/34 | 固定权威合同消费者HTTP路线draft链，公开渲染门禁未解除 | PARTIAL；cover-only/body-only/both＋上传UI＋队列＋接收器尚未连成同一完整矩阵；PHP/WP PENDING_ENV |

接续阶段03，不跳04：

1. 完成冲突图局部替代动作的plan/preview/confirm/recovery；只允许已批准骨架，保留原件、原文、路线版本、预算和旧成功资产，不能仅设compatible=true。真实图像QA仍按本阶段mock权限处理，不能调用付费Provider。
2. 扩展 `stage03-route-chain`：跨来源证据、混合文普通知识段、相关实拍和独立封面；把浏览器人工补图、队列与HTTP放进同一链，补cover-only/body-only/both、部分成功、并发、丢回执组合。当前固定合同fixture可复用，不能当实际WP。
3. SEO-011/012仍需真实实体/reader question与库存访问状态接到审批package/UI；SEO-009类型/@id/作者时间证据完整矩阵、GEO四种时间/已存证据规则需核对。**额外待核对：draft preview URL与公开canonical schema的比较目前可能误报HTML_SCHEMA_URL_MISMATCH；本轮HTTP用候选canonical地址读取，不声称已覆盖WP preview兼容。**
4. 补仅换图/等价别名/改Day三组完整快照恢复、review零外联、迟到worker、预算保留。既有模块通过不代表这一组合齐全。
5. 旧v1多日alt保留兼容渲染但未迁移：若需要修复既有记录，应走显式媒体修订，不批量改正文或伪造历史QA。历史库没有路线快照，不能靠12稿回放宣称已验证历史路线。
6. 最后逐项重新汇总30需求/44用例，所有本地硬要求完成才能PASS_LOCAL(CMS_ONLY)。真实WP/GSC/付费模型与部署权限仍不继承。

## 副作用与停止

CMS commit：否；push/merge：否；deploy/Cloud Build/镜像发布：否；新生产私有读取/导出：否；真实模型/图片/Batch：否；生产WordPress写：否；生产备份/迁移/启用：否；停云/删除：否；公开前端代码/权威合同修改：否。只读取既有授权本地work数据库，写入在事务中回滚；新增测试合同是未改动的公共JSON副本。

本轮接近上下文交接边界，保存未完成本地工作，不将范围缩减为通过。自建API/benchmark和独立浏览器会话收尾停止，清理结果见cleanup.json；未触碰用户原有服务。隔离合成fixture目录保留用于重放，没有生产回滚动作。

current_authorized_step=NONE

phase_end_stop=true

CMS阶段03当前为BLOCKED，本轮已停止；已经保存检查点与未完成项。请新开同一CMS工作区的Codex对话，继续使用本阶段完整TXT，先核对进度和权限，不跳阶段。
