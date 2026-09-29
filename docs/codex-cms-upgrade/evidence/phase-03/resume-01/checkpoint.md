# 阶段03 resume-01：增量开发检查点

结论：**BLOCKED / PARTIAL_IMPLEMENTATION / STOPPED**，不是 PASS_LOCAL。2026-09-28 本轮从既有阶段03检查点继续；精确开始时刻未记录，结束取 identity.json.checkedAt。本轮保存上下文有界的增量成果，30项需求/44用例仍以完整原文及 acceptance/phase-03.md 全量矩阵为准，不能以模块测试数代替阶段验收。

## 范围与身份

DEVELOPMENT / CMS_ONLY。根目录、main、HEAD、remote、Node、OS、全部本轮代码/测试hash见 identity.json。HEAD仍490dd7464d4beb46d3f89a578337c253917fbf7a；原规格与附件逐字节SHA256一致（cdfb039e8d92c5a4c5e1a51a05fce924c71fc45cdb654895a7df3459bebfa91a），未覆盖或缩写。阶段01/02既有本地验收继续保留，本轮没有重新宣布其真实WP/Provider范围通过。进场已有的阶段02/03未提交成果保留，身份文件列出的文件才是本轮增量涉及范围。

风险：LOCAL_LOGIC，另有服务端既存GSC GET响应的只读状态投影。未改SQL、schema、主生成prompt、provider配置、路线状态机或内容策略版本。应用仍2.0.70/schema83。

## 本轮实施

- HTML解析改为linkedom；既有锁定依赖从dev移至生产依赖，安装命令 `npm install --save-prod linkedom@0.18.13 --ignore-scripts --offline`，退出0，无生命周期执行。
- 可见正文排除hidden/aria-hidden/内联隐藏样式/template/script/comment，支持HTML实体和无引号属性。去除任意80字符硬门槛，接受显式expectedFacts比对；此参数尚未从后台正文自动提取。
- 必需媒体只认可见img的真实class/属性，不认可div或脚本文字伪装。字节签名与声明Content-Type对比、srcset/sizes缺失诊断、403媒体unknown。签名检查不等于完整像素解码或视觉质量审核。
- 全部JSON-LD脚本检查同@id冲突、页面引用、可见FAQ、草稿datePublished及显式日期/作者证据。作者/日期证据未传入时不冒充已核实。仍需补齐复杂图谱、Breadcrumb、不同Article身份的完整矩阵。
- 本地/私网字面地址、localhost/.local/.internal不能成为public canonical/图片。域名实际DNS仍由受限reader判定，静态检查不宣称域名可访问。
- 新增显式SEO inspection服务：有界遍历子sitemap、累计字节/深度/文档预算、URL/revision缓存参数、手动刷新、pending不自动重试。未接CMS后台/API/持久化调度；构建service不发请求。
- 内链实体ID/问题/文章类型精排；unknown目标只警告，明确broken目标报错；有目标标题上下文的Read guide可通过。既有库存无accessibility元数据仍沿用历史inventory确认语义，不能宣称实际匿名可达已验证。
- 新增纯建议函数suggestContentDisposition：new/update/merge/keep-as-claim/needs-review，实体与独立问题分开，禁止自动操作。**尚未接入既有审批package/UI**，不能算SEO-012整体完成。
- GSC API `/api/search-console` 增加 observation：not_configured/not_observed/no_data/available/request_failed/stale；保留旧items/sync。索引、AI引荐/引用、转化及新报告均独立unknown。真实本地HTTP测试通过，未调用Google；后台展示尚未实现。

## 执行与覆盖

1. 最终直接相关模块：
`node --test test/seo-observation.test.mjs test/seo-sitemap.test.mjs test/seo-public-reader.test.mjs test/seo-inspection.test.mjs test/seo-status-http.test.mjs test/seo-geo.test.mjs test/final-html-validator.test.mjs test/publish-page.test.mjs test/content-ast.test.mjs test/wordpress.test.mjs test/wordpress-publish.test.mjs test/reliability-network.test.mjs test/reliability-media.test.mjs test/search-console.test.mjs`
退出0，106/106 PASS，module-final.log。其余初测module.log重叠，不累计。

2. 相邻回归：
`node --test test/route-media.test.mjs test/article-media.test.mjs test/article-media-faults.test.mjs test/article-media-http.test.mjs test/media-delivery.test.mjs test/publication-eligibility.test.mjs`
退出0，39/39 PASS，adjacent-regression.log。包含真实本地上传HTTP、SQLite、图像处理和mock QA；**不是阶段03三种路线全链或浏览器E2E**。

3. `npm run check` 退出0，check-final.log（build/语法/服务边界）；其后public URL helper最终增量由上述106项回归加载验证。`git diff --check` 退出0，diff-check.log。没有全量npm test/release:check。

4. 有界匿名HTTPS：homepage、robots.txt、sitemap_index.xml各一次，均200；timeout7s/响应上限300KB/重定向上限2/显式origin allowlist。public-observation.json保留时间、最终URL、头部、字节和hash，无Cookie/认证。没有获取生产私有库存。sitemap的X-Robots-Tag:noindex不是文章noindex的证据。未确认具体文章HTML、已部署commit、合同或前端能力。

| 层级 | 状态 | 实际范围 |
|---|---|---|
| L1 Targeted Tests | PASS | HTML/SEO/reader/GSC确定性反例 |
| L2 Module Regression | PASS | 106项直接模块、39项相邻模块 |
| L3 Production DB Replay | NOT TESTED | 本轮逻辑无需生产库；阶段03整体重放未完成 |
| L4 Browser E2E | NOT TESTED | 本轮本地HTTP不等于浏览器 |
| L5 Real Provider Canary | NOT TESTED | 本阶段明确禁止，未改prompt/真实provider |
| L6 Full Production Replay | NOT TESTED | 三类路线/人工补图完整组合仍缺 |
| Post-Fix Exploratory Audit | ISSUES FOUND | 相邻模块回归通过，后述能力/验收缺口保留 |

测试均Windows/Node24、临时隔离SQLite和合成fixture、API-only；无真实Worker负载或PERF-005规模/30样本。真实PHP/WP、Mac/Linux、真实手机浏览器未测。HTTP测试自身进程已关闭，无本轮常驻服务。

## 对全量台账的增量（未列条目维持旧状态）

以下全部仍是PARTIAL，除非明确说明局部fixture PASS；不得把一个子行为升级为整条测试通过。

| 需求/测试 | 增量 | 仍未完成 |
|---|---|---|
| SEO-001/004，T03-01/02/05 | DOM可见性、严重级别、媒体unknown；定向反例PASS | 持久健康状态、后台、认证/cache完整矩阵 |
| SEO-005/013，T03-06/15 | srcset/sizes、签名字节、隐藏必需图、403 unknown | 完整图片用途/英文语义/OG/实际解码及浏览器 |
| SEO-006/014，T03-07/16/17 | 自动子sitemap遍历、预算、revision/refresh传递PASS | 实际受控HTTP traversal、后台缓存/菜单不触发检查 |
| SEO-007，T03-08 | 拒绝内部公开metadata、保留query行为PASS | 永久链接/归档分页完整编译联动 |
| SEO-009/010，T03-10/11/12 | 同ID冲突、显式作者/日期证据、隐藏FAQ反例PASS | 所有适用图谱类型与真实事实证据接入 |
| SEO-011/012，T03-13/14 | 实体排序、unknown/broken、Read guide、纯建议函数PASS | 库存实体/访问证据完整接线、建议审批/UI与版本影响清单 |
| GEO-003，T03-20 | 显式重要事实与隐藏正文比较PASS | 真实无JS/桌面/手机浏览器 |
| GEO-004/005，T03-21/22 | saved GSC状态＋真实本地HTTP PASS | 后台展示、实际账号功能与授权私有数据（未授权） |
| INT-003，T03-17/26/28 | 三次匿名GET留证、外部版本仍unknown | 具体文章/固定接收制品和能力复验 |
| GEO-007/008、INT-004～008，T03-29～44 | 39项相邻回归可作模块证据 | 不能代替本阶段浏览器/接收器/恢复/性能组合 |

T03-03此前局部fixture PASS保留；T03-04、09、18、19、23～25、27、29～44及其全量需求缺口未被本轮测试覆盖就维持原矩阵PARTIAL/NOT_TESTED。本轮没有把外部缺口归成N/A。

## 相邻审计与下一次精确接续

1. 接受层仍有缺口：inspection service尚未持久化和API/UI接线；严禁接到菜单GET自动抓全站。需要受控显式动作、页面revision、结果来源/时间、缓存和有限重试。
2. SEO-012纯函数要结合现有实体/reader question、库存与审批package；不得用模型猜失踪元数据。GSC后台展示需消费新增observation而非用空数组表示0排名。
3. HTML外部CSS/布局可见性仍不能由静态解析确定；多Article身份、完整图谱引用、Commerce slots实际可见性、图片语义/解码需补。渲染器返回签名字节≠图像QA通过。
4. GEO-001/002/006/007/008：复验原主生成/独立审核事实时间、关系边界与调用计数；真实Provider禁用保持。不要把本轮无新增调用当全链计数证据。
5. INT-001/004/006/007：阶段02服务可复用，但要实际浏览器上传确认→队列→真实PNG/WebP→独立HTTP接收器回执；单来源/组合/mixed路线、冲突Day图和原正文hash都需前后证据。
6. INT-002/005/008：schema83完整快照异目录恢复、review零执行、仅换图/别名/路线变更失效和迟到worker，配合同标准非空PERF-005空闲/负载各30样本。
7. 真实WP仍PENDING_ENV，实际接收版本unknown；对外用途/限定刷新/新字段保持门禁。公开200响应不解除这些门禁。仍需阶段03，禁止开始04。

## 副作用和停止

CMS commit：否；push/merge：否；deploy：否；生产私有读取/导出：否；真实模型/生图/Batch：否；生产WordPress写：否；迁移/启用：否；停云/删除：否；公开前端代码修改：否。

本轮仅启动测试自建API，测试teardown已stop，所有测试子进程已退出；没有后台agent或长期服务，也未停止用户服务。无生产回滚动作；本地回退只能按identity.json定位本轮增量，不能git reset覆盖前阶段未提交成果。复验命令均在上述执行章节；未提供虚构的阶段03一键全链命令。

current_authorized_step=NONE
phase_end_stop=true

CMS阶段03当前为BLOCKED，本轮已停止；已经保存检查点与未完成项。请新开同一CMS工作区的Codex对话，继续使用本阶段完整TXT，先核对进度和权限，不跳阶段。
