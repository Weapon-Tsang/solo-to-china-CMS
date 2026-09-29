# 阶段04.0 v1.4 本地发布迁移预检

结论：**PASS_LOCAL (CMS_ONLY)**，仅本地预检/准备。整个04阶段未完成：04.1～04.5完整规格缺失，真实关卡WAITING_AUTH/NOT TESTED。用户要求持续完成整个04开发；本轮已做可从04.0和现有代码确定的本地准备，不以该请求推断部署或其他生产许可，不虚构后续阶段验收。

日期2026-09-28；精确结束时间及制品生成时间见[最终状态](../evidence/phase-04-0/final-state.json)。开始精确时刻未记录。DEVELOPMENT；Windows x64、Node24.14.0/npm11.9.0；main/HEAD `490dd7464d4beb46d3f89a578337c253917fbf7a`，remote `https://github.com/Weapon-Tsang/solo-to-china-CMS.git`。应用2.0.70/schema83，未更改应用/策略/合同版本。CPU和内存见inventory.json；没有运行生产Worker、使用Linux容器或实体手机。

## 实际改动与前置证据

- 修复人工上传固定8 MiB块不能按入口配置下调：新增ARTICLE_MEDIA_CHUNK_BYTES；旧会话原chunk大小与已收块不变；永久回归验证重启后旧块保全、新会话3块传输。
- 新增离线制品库存/密钥特征扫描工具、09个T04用例的预检映射、隔离浏览器fixture和实际上传验证驱动。工具不连接DB/云/模型/WP，不读取.env，不安装依赖；扫描不是完整秘密检测保证。
- 保存[完整原始输入](../phases/phase-04-0.txt)，记录[发布/迁移/回滚、canary及授权计划](../evidence/phase-04-0/release-migration-plan.md)。没有修改独立公开前端、合同或生产部署脚本。
- 前置01采用[closeout v1.2当前态矩阵](phase-01-closeout.md)而非早期未完成表；02采用[最新C/D验收及A2/B映射](../evidence/phase-02/cd/local-acceptance.md)；03采用[resume-04 30需求/44用例](../evidence/phase-03/resume-04/checkpoint.md)。[38文件身份比较](../evidence/phase-04-0/prerequisite-identity.json)：36不变，2个变化恰为本轮article-media实现/测试，已重新回归。不是把旧报告无条件当当前代码通过。
- 本轮改动：src/config.mjs、src/services/article-media.mjs、test/article-media.test.mjs；新增scripts/stage04-local-preflight.mjs、stage04-browser-fixture.mjs、verify-stage04-chunk-browser.js和test/stage04-preflight.test.mjs；本阶段交接文档。其余[既有未提交文件](../evidence/phase-04-0/initial-status.txt)保留，不归为本轮新增。

## 需求逐项验收

| ID | 本地结果 | 证据与外部限制 |
|---|---|---|
| REL-001 | PASS_LOCAL | 01–03复核、check/build、81项相关回归、固定合同hash、制品清单、秘密特征扫描和diff审查；真实生产schema/容器/接收端待验 |
| REL-003 | PASS_LOCAL | 无真实写/付费/资源动作，停止自建测试进程；后续实际操作结果NOT TESTED，未伪造 |
| REL-004 | PASS_LOCAL | 工具核实唯一CMS remote/root；前端制品只读消费；Git/构建均在CMS，未改PHP或前端仓库 |
| REL-005 | PASS_LOCAL | BIND/MUP T02-33～70和T03-29～34逐组核对；人工原件/暂停会话恢复、锁/权限/幂等及回执回归；新增分块配置和浏览器实测；真实入口/cover-body能力分别待验 |
| REL-006 | PASS_LOCAL | ROUTE-001～012/T02-71～90、GEO-008/INT-006～008/T03-35～44复用已核实身份；本轮route-chain/restore重新验证；内部路线不外发、不改已确认正文；真实canary另验 |

## 当前关卡9个用例

| ID | 输入/操作与结果 | 实际证据 |
|---|---|---|
| T04-01 | 前置聚合、schema83、制品hash和固定合同校验PASS_LOCAL；线上合同版本unknown | prerequisite-identity.json、artifact-manifest.json、regression.log |
| T04-02 | 无精确真实授权，预检计划始终禁止真实执行；本轮副作用为零PASS_LOCAL | stage04-preflight测试、final-state.json、计划 |
| T04-14 | 没有前端工作区/公开UI确认仍完成CMS预检；错误root/remote拒绝PASS_LOCAL | stage04-local-preflight源码、inventory.json |
| T04-15 | 合同只支持featuredMediaId，不支持cardTitle/deck；损坏固定hash拒绝，封面/正文独立阻断PASS_LOCAL | preflight、frontend-contract及cover/article-media回归 |
| T04-16 | 仅旧验收不满足BIND/MUP输入，plan阻断；当前实际新证据已定位PASS_LOCAL | stage04-preflight、02 C/D和03 resume-04 |
| T04-17 | 实际1 MiB三块上传、重新打开、重启旧块保全PASS_LOCAL；线上代理配置NOT TESTED | browser.log、browser-upload.png、article-media回归、上传计划 |
| T04-18 | 缺人工/路线恢复证据阻断；当前暂停块和采用原件恢复回归通过；cover-only不能当body能力、付费预算0 PASS_LOCAL | backup/article-media/stage03-restore回归与计划 |
| T04-24 | 只有v1.3人工证据仍阻断路线输入；当前v1.4实际证据复核PASS_LOCAL | preflight、route-chain、03 35～44台账 |
| T04-25 | 严格外部合同、不自动改已发布正文、路线媒体完整恢复PASS_LOCAL；canary/备份/回滚/授权已规划 | route-chain/restore、frontend-contract、计划 |

上述预检规划器单测仅证明规划器本地决策；应用真实门控与恢复分别由相关模块/浏览器验证。没有把布尔fixture当作真实接收器能力证据。

## 命令、测试层级与覆盖

完整命令与退出码见[commands.json](../evidence/phase-04-0/commands.json)。

| 层级 | 结果 | 范围 |
|---|---|---|
| L1 Targeted Tests | PASS | T04-17分块配置永久回归、5项预检测试；最终工具增量5项不与81累加 |
| L2 Module Regression | PASS | [81项](../evidence/phase-04-0/regression.log)：上传/HTTP故障/备份/路线链与恢复/封面交付/合同/runtime；[check构建](../evidence/phase-04-0/check.log)退出0 |
| L3 Production DB Replay | PASS（限定旧副本） | [84来源/1454资产/5334claims/12稿](../evidence/phase-04-0/historical-replay.log)，已存在work副本、外层事务回滚、committed_writes=0/external_calls=0；无历史路线快照或原件像素，不是实时生产状态 |
| L4 Browser E2E | PASS | 桌面Chromium真实登录→内容→上传2,885,976字节→三PUT→完成→关闭/重新打开；无pageerror/外联；合成噪声图不作语义/摄影验收 |
| L5 Real Provider Canary | NOT TESTED | 当前预算0，四个canary方案已列；本轮确定性改动不需付费验证 |
| L6 Full Production Replay | NOT TESTED | 本轮预检，不是正式发布；Capture至真实QA/WP完整链尚未执行 |
| Post-Fix Exploratory Audit | PASS（本地）/ISSUES FOUND（发布准备） | 旧会话配置变更保全、413/磁盘/解码故障、恢复和版本边界通过；发现旧恢复脚本schema81及CI固定合同SHA不同，已列精确阻塞，未执行 |

未跑全库npm test、release:check、Cloud Build、完整生产备份或GCE snapshot。首次浏览器fixture被development未标记库门禁拒绝，随后在创建合成DB前写development身份解决；首次driver缺URL全局，调整为字符串解析后通过。README示例私钥占位符误报已核实，通过要求实际base64内容避免误报，不删除检测规则。诊断与最终证据分开保存。

## 制品及待验范围

[artifact-manifest.json](../evidence/phase-04-0/artifact-manifest.json)列逐文件hash和组合hash；[artifact-location.json](../evidence/phase-04-0/artifact-location.json)定位本地payload。依赖未安装、没有容器image digest；不能直接称已可生产部署。Git diff无空白错误，已审查本轮来源；源文件及构建文件已扫已知密钥特征，未把.env/数据库/原件加入制品。

已生成本地ZIP，[压缩包hash](../evidence/phase-04-0/archive.json)及[172个ZIP文件逐字节hash复核](../evidence/phase-04-0/archive-verification.json)均已保存。PowerShell的.NET检查接口在当前语言模式不可用，改用Python标准库完成复核，不影响制品。

固定合同1.4.1，commit 0c4b327287c016aee138f735a8a13eb2baa74542，组合SHA256 9154dc68540d9922c11109e4cfe00aee871d850e61124fd7edb624ee20b2c422。实际接收端版本、PHP/真实WP、生产schema、代理限制、容器平台、秘密移交、迁移/启用/媒体修复/停云/删除：NOT TESTED或WAITING_AUTH。不能激活EXT-REFRESH/EXT-BODY-MEDIA-REFRESH/EXT-CARD。真实生产日志/费用未读取。

## 副作用与停止

CMS commit：否；push/merge：否；部署/Cloud Build：否；生产私有读取/导出：否；真实模型/图片/Batch：否；生产WordPress写入：否；真实迁移/启用/停旧Worker：否；生产备份/磁盘snapshot：否；停云/删除：否；独立公开前端代码修改：否。仅有本地代码/文档/构建、合成库和已存在work副本事务、回环浏览器操作。

current_authorized_step=NONE；phase_end_stop=true。已停止本轮自建API/浏览器；未停止用户服务。[清理证据](../evidence/phase-04-0/final-state.json)。完整04后续规格与真实授权待补，不声称整个04已完成。下一对话在同一CMS工作区读取本报告/STATUS/完整TXT继续；交接无需手工搬动。


## 2026-09-28 后续修正（保留以上历史事实）

本轮完整接续输入已完成本地修正与可运行候选交付，见[当前报告](phase-04-fixes.md)。原PASS_LOCAL范围保留。真实Git追溯证明原CI的b231b1d与9154dc字节一致，并非过期；历史缓存的0c4b327来源标注不一致（该commit实际为e19fbc）。未重写缓存。schema81辅助入口退出83计划；恢复及实际Windows候选已复验，后续生产门禁保持。current_authorized_step=NONE；phase_end_stop=true。
