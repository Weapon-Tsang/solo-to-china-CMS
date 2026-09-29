# 阶段03续作 resume-02 · 2026-09-28

**BLOCKED / PARTIAL_IMPLEMENTATION / STOPPED**。已继续开发，不是全阶段验收通过，不得进入04。原[30项需求/44用例矩阵](../../../acceptance/phase-03.md)完整保留；本文件是增量，下面没有覆盖的条目不升级。

## 身份与边界

工作区 `C:\Users\Mloong\Documents\ChatGPT\solo-to-china-CMS`，main / HEAD `490dd7464d4beb46d3f89a578337c253917fbf7a`。Windows、Node v24.14.0、DEVELOPMENT。前置阶段01/02及resume-01证据已读；大量既有未提交修改保留。app2.0.70 / schema83 / 内容策略3.9保持，本轮没有新增数据库migration。新增局部检查策略标识 `seo-inspection-1`、`manual-route-media-1`，不冒充内容策略升级。代码和规格hash见[identity.json](identity.json)。

完整v1.4规格仍逐字节保存在[phase-03.txt](../../../phases/phase-03.txt)，SHA256 `cdfb039e8d92c5a4c5e1a51a05fce924c71fc45cdb654895a7df3459bebfa91a`。

本轮风险分类：DATABASE_LOGIC / PIPELINE（已有存储中保存检查、人工媒体采用/恢复/路线校验）、LOCAL_LOGIC、UI_ONLY。不改模型prompt/schema/transport，不新增模型调用。真实Provider禁止；全部HTTP写入仅隔离本地fixture，测试中模拟release参数不授权任何生产发布。

## 本轮实现

1. `draft-seo-inspection.mjs` 接入已发布文章显式检查API和后台。目标只能来自同配置公开HTTPS站点的已确认publication permalink；不接受客户端任意URL。GET只读已存结果；POST受鉴权、同源检查、revision/fingerprint保护。最多两项并发、同文章合并请求、5分钟缓存、显式刷新、结果上限512KB、无自动重试。修订/回执/策略/TTL变更后旧结果失效，迟到结果不覆盖新版本。
2. 九项健康状态展示来源、时间、页面版本；fixture明确标为`provided_artifact`。保存检查结果纳入已有runtime_settings快照；读取菜单/重启/恢复不自动抓取。GSC后台消费已保存数据，六种状态分别呈现，不把未知写成零排名或AI引用。
3. SEO编辑字段独立传递`seo_title`，同步规范SEO字段，保留正文title/H1、slug和body。新增既有内容pipeline回归断言。
4. 人工补图明确绑定批准路线版本和照片站点。普通照片不得满足整日路线图义务；管理员关联只说明该文章对象，不证明交通、同日拍摄或官方事实。地图的管理员Day声明可证明已知冲突，不能替代像素拓扑/箭头QA。
5. Day2目标/Day3图声明显示具体差异、保留原件与正文，刷新和重开仍显示冲突；相符照片经实际本地解码/文本检查及WebP衍生局部继续。旧成功照片保留，不清模型预算。
6. 使用轻量persisted route receipt查询替代每次补图列表构建完整研究package。相邻审计又修复“content hash改变→精确路线回执消失→误当非路线文章”漏洞；采用阶段明确`ROUTE_VERSION_STALE`，已上传原件仍可查看。正文实际walk→taxi偏离批准骨架仍报`ROUTE_TEXT_MISMATCH`。
7. 新增独立回环HTTP接收器回归，实际流式上传WebP、条件更新、HTML回读/校验、丢回执只读对账、不完整回执不落位。不是实际WP实现；应用生产交付能力门禁未启用。

## 实际测试与命令

下列Node命令均退出0。测试组重叠，不相加为独立覆盖数量。日志包含少量SQLite实验性提示和合成图片低dpi提示，断言没有跳过。

- L1与最终不变量：`node --test test/draft-seo-inspection.test.mjs test/manual-route-media.test.mjs test/stage03-receiver-http.test.mjs`，9/9 PASS：[final-invariants.log](final-invariants.log)。包括鉴权/CSRF、缓存/并发/迟到结果、持久化重启/备份、真实本地路线渲染恢复、content hash缺回执、实际文字偏离、HTTP成功/丢回执/部分回执。
- L2直接模块：`node --test test/draft-seo-inspection.test.mjs test/seo-inspection.test.mjs test/seo-status-http.test.mjs test/seo-observation.test.mjs test/seo-sitemap.test.mjs test/seo-public-reader.test.mjs test/seo-geo.test.mjs test/final-html-validator.test.mjs test/search-console.test.mjs test/content-pipeline.test.mjs test/manual-route-media.test.mjs test/article-media.test.mjs test/article-media-faults.test.mjs test/article-media-http.test.mjs`，71/71 PASS：[modules-final.log](modules-final.log)。其后新增route缺回执与HTTP回归由最终9项覆盖。
- 相邻模块：`node --test test/route-production.test.mjs test/route-decisions.test.mjs test/route-media.test.mjs test/publication-eligibility.test.mjs test/media-delivery.test.mjs test/backup.test.mjs`，73/73 PASS：[adjacent.log](adjacent.log)。模型边界受控，不是真实Provider，也不代表阶段03三类路线与接收器一条全链都已完成。
- `npm run check` PASS：[check-final.log](check-final.log)；build、语法、服务边界。`git diff --check` PASS，仅既有CRLF提示：[diff-check.log](diff-check.log)。没有全量npm test / release:check / Cloud Build。
- `node scripts/stage03-historical-replay.mjs D:/cms-phase02-media-replay-xiKzH1/work.sqlite` PASS：[historical-final.log](historical-final.log)。第一次复跑漏传路径在开库前被白名单拒绝，补上明确路径后通过。脚本只接受这个既有一次性work副本，不访问生产。

| 层级 | 状态 | 实际覆盖与限制 |
|---|---|---|
| L1 Targeted Tests | PASS | 最终9项关键新增回归；此前targeted8项有重叠 |
| L2 Module Regression | PASS | 71项直接模块、73项相邻模块，局部真实HTTP/图像处理 |
| L3 Production DB Replay | PASS（限定） | 既有授权历史work副本12篇，事务回滚；无真实历史像素/路线快照全链 |
| L4 Browser E2E | FAIL（相邻接口） | 补图/冲突/SEO/GSC定向流通过，但停止时服务日志发现路线稿cover-audit 500；页面整体不通过，见下文 |
| L5 Real Provider Canary | NOT REQUIRED（本轮增量） | 未改模型请求，真实付费调用未授权也未执行；全阶段真实生成仍NOT TESTED |
| L6 Full Production Replay | NOT TESTED | Capture至QA及三类路线/最终交付完整组合未完成 |
| Post-Fix Exploratory Audit | ISSUES FOUND | 已修复路线回执失配绕过；发现cover-audit 500尚未修复，另有下节本地实施和验收缺口 |

## 数据副本、恢复与HTTP证据

历史基线：84 sources、1,454 assets、5,334 claims、12 drafts；18,415 jobs、6,453 model metrics。对12篇执行本地synthetic上传/确认等待及SEO已存状态读取。稿件正文、publication、jobs、model metrics、media bindings保持；回滚后article_visuals等六张保护表hash、全部表count、schema hash均还原，committed_writes=0、external_calls=0。12篇均没有可用route快照，历史26母图原Linux路径不可达，**不得将此结果写成真实路线/像素问题已解决**。

恢复fixture将批准route bundle、真实本地renderer文件/hash、人工照片衍生、冲突图原件、paused chunks、manual revisions和预算记录一起备份到异目录；SEO observation另有恢复用例。恢复模式migration-review、无running job、无外联、源/衍生字节hash核对通过。没有实际恢复整个生产环境，也没有覆盖所有“换图/等价别名/改Day”组合。

[receiver-http.log](receiver-http.log)：success / lost / partial三种fixture，各仅一次字节上传和一次更新；lost只读对账一次，没有二次上传。成功分支独立HTML返回正确媒体ID/正文/尺寸，校验通过；partial保持needs_review，不将附件ID写进visual。旧publication回执和整篇draft行不变，模型调用0。该样本是普通批准稿body-only，不是封面＋正文组合、已发布三日路线的完整交付。

## 浏览器证据

使用Playwright CLI独立`phase03`会话、回环API、隔离SQLite和合成图片；拒绝浏览器非本地请求。命令模式：`npx --yes --package @playwright/cli playwright-cli -s=phase03 run-code --filename scripts/verify-stage03-*.js`。fixture启动：`node scripts/stage03-browser-fixture.mjs`，登录凭据仅脚本内合成测试值。

- [route-browser.log](route-browser.log)：相符stop照片上传→确认→真实PNG/WebP本地处理；第二张已声明Day3的图针对Day2保存并阻断。revision/content_hash/body/title/slug不变，media_revision=2；四宽度320/768/1024/1440无面板横向溢出，无pageerror/外联。
- [route-reopen.log](route-reopen.log)：重开后冲突仍显示；[清晰视口截图](route-reopened.png)。最初整面板截图被滚动容器裁剪，未用它当验收图。
- [seo-browser.log](seo-browser.log)：显式检查、缓存、强制刷新和重开读结果；九维展示、fixture来源诚实、六种GSC响应fixture；[SEO截图](seo-inspection.png)、[GSC过期截图](search-stale.png)。GSC状态是浏览器受控响应，不是账号实查。
- browser fixture在最后route缺回执服务校验补丁前启动；该最终后端边界由最新9项测试与最终历史回放验证，不宣称浏览器进程热加载了最终后端。
- 这里的“冲突图”是合成图片＋管理员声明Day标签；没有假称从其像素识别了真实路线图，也没有真实WordPress、手机硬件或公网CWV证据。

## PERF-005本轮测量

同标准合成非空数据、同机器/网络：1,000 sources / 10,000 claims / 300 drafts / 3,000 media metadata，Windows8逻辑CPU/17,107,996,672bytes RAM、Node24、loopback、API进程；负载模式增加CMS Worker及独立synthetic read/CPU进程。每组30有效样本，预热单列，nearest-rank。

| 模式 | 冷菜单 P50/P95 ms | 缓存菜单 P50/P95 ms | 五个API最高P95 ms |
|---|---:|---:|---:|
| 空闲 | 110 / 144 | 68 / 100 | 11.081 |
| Worker＋synthetic read/CPU | 108 / 125 | 60 / 77 | 24.672 |

本次子场景满足原阈值：冷≤1000ms、缓存≤200ms、列表API≤300ms。原始样本和SQL/机器信息见[api-idle.json](api-idle.json)、[api-worker.json](api-worker.json)、[menu-idle.log](menu-idle.log)、[menu-worker-clean.log](menu-worker-clean.log)。命令：`node scripts/benchmark-local-stage01.mjs [--worker-load] --browser-hold --output <report>`，浏览器执行`verify-stage03-menu-performance.js`，完成后写fixture `.browser-stop`触发API采样与自动退出。

第一遍`menu-worker.log`恰有并行测试/build，不能与空闲做同条件对照，保留为诊断，采用之后独立重测clean日志。数值较低不证明Worker提升性能。当前**没有标准规模下真实上传/hash/路线渲染负载的30样本与内存证据**，因此INT-002/005/008整体仍PARTIAL。阶段02性能不能替代这项缺口。

## 对完整矩阵的增量

下表中的PASS仅明确的子行为，整条需求若有未验项仍PARTIAL。

| 需求/用例 | 本轮已完成 | 仍需完成 |
|---|---|---|
| SEO-001/014，T03-01/02/16/17 | 持久化、显式API/UI、revision/TTL/cache、来源/时间、菜单零抓取 | 认证/缓存全部组合及全阶段成品阻断联动 |
| SEO-002，T03-03 | SEO编辑保存不改title/H1/body/slug，已有分字段校验 | 无新增全链部署证据 |
| GEO-005，T03-21/22 | 六状态后台展示及浏览器fixtures | 实际私有GSC未授权；AI引用/索引仍unknown |
| GEO-007/008、INT-007，T03-29/30/39/40/43 | 相符站点照片、已知Day冲突保存/重开；正文和路线保持；正文偏离及缺回执拒绝 | 真正图像拓扑QA、相符子图/按骨架重编的可执行恢复入口；三张图完整历史媒体修复组合 |
| INT-001/004，T03-23/24/31/32 | 浏览器上传确认/持久化，独立真实HTTP body-only成功/丢回执/部分回执及HTML | 把浏览器/队列/三类路线/最终接收器连成同一端到端链；封面-only/body-only/both所有组合 |
| INT-002/005/008，T03-25/33/42/44 | 标准非空空闲/Worker30样本；route/render/manual/paused/SEO恢复；局部失配与旧成功资产复用 | 上传/hash/渲染负载内存；route变更/仅换图/等价别名完整成组快照与迟到Worker |
| INT-003，T03-26/27/28 | 外部门禁保持、fixture/public来源分层 | 实际WP PENDING_ENV；本轮没有新增匿名现网GET |

其余SEO-003～013、GEO-001～004/006及INT-006仍按resume-01和完整矩阵记录，**没有因为这些日志通过就升级整条状态**。

## 继续阶段03的具体顺序

0. **首先修复本轮停止服务时读到的相邻运行错误**：[server-errors.log](server-errors.log)。三日路线fixture已有人工照片/冲突采用、`quality_qa=null`时，打开详情会请求`GET /api/drafts/:id/cover-audit`，08:51:19Z及09:08:49Z均返回500：`Cannot read properties of null (reading 'status')`。当前只有错误文本，没有堆栈，`quality_qa`只是待核对线索，不是已证实根因。检查cover-audit及其下游空QA处理，新增回归，再跑浏览器打开路线详情并断言所有相关响应无500。此次补图脚本只捕获pageerror/外联，没有把所有同源500算失败，必须加强。**该问题未修复，不能以定向脚本PASS宣称详情页面验收通过。** 停止后仅补报告，没有继续改代码或重启测试。

1. SEO-012接通现有实体/reader question、库存已知访问状态与审批package/UI；当前只有建议纯函数，不得自动合并/删文/改旧正文。SEO-011库存实体/可访问证据和改链受影响清单仍缺。
2. 补SEO-009适用图谱类型/@id引用/作者时间证据绑定，以及SEO-004/007/008/013完整fixture矩阵。复核GEO既有主生成/独立审核的价值、四种时间、来源关系与实际调用计数；不新增SEO/GEO模型调用，不调用真实付费Provider。
3. 复用现有route-production、route-decisions和新HTTP接收器fixture，串起单来源/证据组合/mixed三类真实CMS链、独立审核、真实PNG/WebP、最终HTML和回执。不要把独立模块测试拼成未经执行的全链证据。
4. 实现冲突图的明确局部替代动作：选已确认相符子图/按批准骨架重编，保留原件、受控manifest、独立图像QA和累计预算。路线修订仍独立proposal。不能通过仅设置compatible=true放行。
5. 用标准非空数据跑实际上传/hash/route-render负载30样本，并核对RSS/浏览器heap和限流；补三种变更的完整恢复/迟到结果组合。
6. 最后逐项更新全部30需求/44测试矩阵。CMS必需本地链完成才可PASS_LOCAL(CMS_ONLY)。真实WP/新字段/刷新能力独立PENDING_ENV门禁保持，禁止以外部未授权为由省略本地工作，也禁止开始04。

## 副作用及停止

未commit/push/merge、未部署、未Cloud Build/镜像发布/生产备份或迁移、未生产私有读导出、未真实Provider/Batch、未生产WordPress写、未改公开前端/权威合同/云配置。没有生产回滚动作。只能按本轮文件增量局部回退，不能reset覆盖此前未提交成果。

所有测试API按自身stop文件/teardown停止，独立浏览器会话关闭；标准benchmark Worker及load进程由其脚本停止，不触碰用户服务。最终清理证据见[cleanup.json](cleanup.json)。

current_authorized_step=NONE

phase_end_stop=true

CMS阶段03当前为BLOCKED，本轮已停止；已经保存检查点与未完成项。请新开同一CMS工作区的Codex对话，继续使用本阶段完整TXT，先核对进度和权限，不跳阶段。
