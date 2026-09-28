# A2 接续检查点 · 2026-09-28

**A2_PARTIAL / NOT_READY_FOR_B / STOPPED**。按归档 `phases/phase-02-a2.txt` 第十节在上下文边界保存；本轮有实质开发，但没有完成用户要求的全部剩余 A2。阶段01、02-PRE、A1（最新 PDF 来源补图验收）保持。原68项要求/90用例不改号、不整行涂绿。不退回 A1，不进入 B/C/D/阶段03。

## 代码身份与变更

同一实际工作树 `C:/Users/Mloong/Documents/ChatGPT/solo-to-china-CMS`，main / HEAD `e9f7c8e82ff760f4d18f2d2e0673452eb8744290`；app 2.0.70、schema82。当前工作树含大量先前未提交成果，全部保留。开始身份/相关文件 hash 见 [a2-resume-baseline.json](a2-resume-baseline.json)，结束身份见 [a2-resume-files.json](a2-resume-files.json)。没有初始 hash 的文件不声称掌握其修改前字节。

本轮实际改动：

- 新增 `src/route-composition.mjs`、`src/route-media.mjs` 和两组对应测试。
- `src/route-bundle.mjs`：批准范围选择、组合编译、字段证据/panel/region、条件诊断，以及剔除来源定位ID后的媒体拓扑比较。
- `src/ai/route-contract.mjs`：既有 Experience 请求中新增字段级证据和现实条件 schema/prompt；没有增加独立路线模型调用。
- `src/repository.mjs`：读取当前 input 的 fragments；从数据库中的批准记录选择路线；把路线约束接到实际保存草稿、normalizeVisuals 和 mediaRepairPlan；图片结果落库前验证当前路线/来源/独立QA；同一持久化槽位变更 fingerprint 不清零 attempt_count/recovery_budget。
- `src/visuals/vertex-imagen.mjs`：实际转译请求包含原/目标路线及规范名称；独立视觉QA要求 route_audit；缓存重用检查路线审核版本；结果保留回执。普通照片未增加额外请求。
- `test/route-production.test.mjs`、`test/visuals.test.mjs`：实际请求、SQLite落库、批准组合、旧来源输入、迟到图片、预算永久回归。
- `test/media-bindings.test.mjs`：旧schema80夹具同时跳过81及之后迁移，避免“跳81但执行82”制造缺表。
- `test/historical-visual-analysis.test.mjs`：历史图夹具补保留 capture_versions，继续测试历史图分析；没有放宽禁止借用当前正文的门禁。
- `scripts/stage02-route-historical-replay.mjs`：新增三个历史稿件媒体修复计划的只读计算与指纹检查。

## 已贯通的行为及真实边界

批准记录的 `proposal.route_scope` 支持 `mode`、`fragment_ids`；组合模式再指定 `days:[{source_day_id,label,stop_ids,leg_ids}]`。leg_ids 可引用已有 leg，或使用 `{evidence_leg_id,from_stop_id,to_stop_id}` 将已有连接证据映射到同一规范实体的不同来源 occurrence。代码不发明交通/分钟数，不将多次到访实体去重。未选择的多路线、缺连接、错序、端点实体不同均阻断。**尚未提供用户操作这些选择的路线提案/决策 HTTP 接口和 UI。**

原有持久化 media availability/route snapshot 链继续使用。图片地区/箭头证据含 asset、panel、规范化region、span和未定状态；城市/岸侧连接矛盾、到达晚于关闭、过时条件可诊断。没有执行地理/票务/当前可行性核实，也没有证明模型真实理解图片箭头。

路线图在实际 normalizeVisuals 和 mediaRepairPlan 使用当前提取证据；写作模型自报 route 元数据不作为来源证据。普通实拍依 A1 实体/用途关系匹配，不要求逐站照片；不一致的必需全图保留 failed slot 和 route_media_conflict，而不是静默接受。原/目标一致走 faithful_localization，差异返回 recomposition 和具体字段。**部分子路线/裁剪后panel字节与用途、可选图片省略后的完整管理反馈仍未完成。**

实际 VertexImagen 请求构建经受控 fetch 验证：发送真实原件字节、规范实体名及路线契约；另一独立审核请求对照实际衍生字节，缺审/旧hash/错误箭头响应被拒。只替换外部网络边界，不替换 normalizeVisuals、请求构建、文件存储或 Repository。这里验证的是协议和门控，不能声称真实模型语义/像素质量通过。

## ROUTE 要求增量矩阵

| ID | 本轮新增证据 | 仍未完成的 A2 或后续组合 |
|---|---|---|
| ROUTE-001 | 当前片段参与混合识别；批准选择与 evidence_composed_route | 完整知识/混合分流矩阵、批准替代路线操作入口 |
| ROUTE-002 | asset/panel/region/span/箭头字段持久化、错asset/越界/歧义负例 | 真实图像理解 NOT TESTED；更完整panel提取样本 |
| ROUTE-003 | 组合沿原route表/批准记录持久化 | proposal/diff/权限决策 API |
| ROUTE-004 | 城市/岸侧、时窗、过时条件诊断 | 多来源逐字段冲突消解、非关键条件降级完整矩阵 |
| ROUTE-005 | 实际主请求消费批准组合；旧 input 不参与冻结 | 操作员选择入口及完整scope决策 |
| ROUTE-006 | 实际 normalizeVisuals / media repair 接线，单点与全图分开 | 明确子路线/合法panel用途；真实article槽位组合 |
| ROUTE-007 | 实际转译请求与hash、实体词表输入、输出门控 | crop字节/谱系及部分图采用；真实Provider NOT TESTED |
| ROUTE-008 | 重跑真实PNG、manifest和可视检查 | 接入article_visuals、required manifest、真实图注摘要交付依赖 |
| ROUTE-009 | 实际独立视觉QA schema/请求/回执及负例 | 最终交付入口对所有route/media/current source依赖的全面门禁 |
| ROUTE-010 | 冲突用途结构化结果可供未来D消费 | A2提案/diff/权限 API；D采用锁/outbox/续跑仍PENDING_D |
| ROUTE-011 | 来源变化/旧图结果落库拒绝，旧正文保护回归 | 已发布三日稿只读snapshot、媒体许可及提案审批完整fixture |
| ROUTE-012 | 同一持久化槽位重试预算跨fingerprint保留；原route备份测试继续通过 | 图失败仅恢复图、route/slot完整依赖失效、组合恢复；D数据不伪造 |

## T02 用例增量矩阵

原检查点的未变证据继续保留；以下不代表整用例已验收。

| 用例 | 本轮覆盖/未覆盖 |
|---|---|
| T02-71 | 实际批准组合进入主请求；知识/混合全矩阵待补 |
| T02-72 | occurrence保留、panel/region/箭头定位负例；真实图像提取未测 |
| T02-73 | 多片段/跨来源连接编译，缺连接/错序/异实体拒绝；多来源同字段冲突消解待补 |
| T02-74 | 实际normalizeVisuals拒绝交通错全图并保留required gap |
| T02-75 | 完整panel裁剪/图片采用未实现，A1原件上传保持 |
| T02-76 | 旧有路线/required媒体分门禁继续回归，完整生产采用未验 |
| T02-77 | 真实renderer再次解码和查看；article_visuals/照片组合未接完 |
| T02-78 | 实际单点关系匹配通过；不从来源Day推断本文当日拍摄 |
| T02-79 | route_media_conflict实际失败槽位；用户完整恢复决策仍缺 |
| T02-80 | 实际faithful请求原/目标hash，已有真实recomposition示意；crop未验 |
| T02-81 | 同实体端点检查、独立QA拒错误箭头；实际请求有中文规范名；真实像素理解未测 |
| T02-82 | 正向真实请求链1主写作+1独立文本review，0专门路线/SEO/示意调用；受控媒体另计 |
| T02-83 | 旧提取input排除、来源变化时拒图片落库、旧QA回执拒绝；跨全部槽位依赖待补 |
| T02-84 | 历史稿保持和只读计算；三日已发布稿完整权限fixture待补 |
| T02-85 | 原route数据/文件备份恢复回归；人工关系+暂停任务组合未验，D仍待验 |
| T02-86 | 本轮未改UI/未跑浏览器；完整A2决策及D采用未完成 |
| T02-87 | 实际renderer负例继续通过，实际视觉QA请求错误响应被拒；仅恢复图待接 |
| T02-88 | required冲突保留，不用示意替代实拍；真实示意槽位组合待接 |
| T02-89 | 同hash正文错误和独立审核缺失回归；槽位累计预算新增测试；全文局部修复预算待补 |
| T02-90 | 城市/岸侧/时窗/过时条件负例通过，reality_verification仍NOT_VERIFIED |

## 验证与可追踪样本

风险：DATABASE_LOGIC / PIPELINE / AI_PROVIDER（schema与prompt）。本轮没有增加数据库schema。

| 层级 | 结果与精确范围 |
|---|---|
| L1 | PASS：路线组合、来源定位、媒体门控、视觉请求、预算定向测试 |
| L2 | PASS：[最终154/154](a2-resume-final.log)，[check/build](a2-resume-check.log)，git diff --check及新增模块语法检查 |
| L3 | PASS：[a2-resume-historical.json](a2-resume-historical.json)，既有获准work副本migration事务、三稿媒体计划只读计算、受保护表指纹及回滚；不是路线现实语义验收 |
| L4 | NOT TESTED：本轮未修改UI，也未冒充原浏览器证据为本轮执行；完整A2操作仍缺 |
| L5 | NOT TESTED：原执行文件禁止真实Provider，付费调用0 |
| L6 | NOT TESTED：没有完成完整A2/生产流程 |
| Post-Fix Exploratory Audit | ISSUES FOUND：修复同槽位预算清零、旧schema测试夹具、历史capture测试夹具、无route片段的无用来源读取；上表剩余集成缺口未关闭 |

命令在 a2-resume-final.log 对应执行：15组路线/视觉/内容/绑定/备份/发布门禁/模型预算相关测试，`node --test --test-concurrency=2 ...`。不运行全仓测试，不使用任何真实Provider。首次154之前的媒体附加回归发现旧历史fixture缺capture，修正后48/48，再合并154/154；没有忽略失败。

追踪：[request-trace.json](a2-resume/request-trace.json)、[route-example.json](a2-resume/route-example.json)、[真实PNG](a2-resume/route-example.png)。source capture/segments/Experience→批准bundle→实际writer/reviewer输入→实际renderer；测试没有SQL伪造成功Job。合成 East Hall→West Hall→East Hall 样本不是真实旅游建议。图片已通过工具查看：三次站点、两条向下箭头、about 15 minutes、bus和not-to-scale声明可见。总体文章编辑审核故意返回false，不能宣称交付文章通过。

真实转译字节测试额外验证2个受控请求（transform+独立QA），无网络付费；QA四种响应测试另有4个受控请求。真实AI理解、图片语义、WordPress投递与现实路线可行性均未验证。

历史回放首次扩展到12稿的尝试因时间成本停止了本轮自己的Node进程；事务由SQLite回滚。随后对同一work库重新验证baseline/schema，范围收窄至3稿。没有新导出/大复制/消费历史jobs。最终JSON有无rollback PASS是完成依据，不以被中断尝试为通过。

最终历史结果：schema81→82事务演练及回滚PASS，恢复81；84来源、1,454资产、12稿件、26文章图、12写作包、18,415 jobs、6,453调用记录、12投递和151 Experience runs的受保护列指纹不变。三个稿件的6个现有槽位仅计算出5个repair与1个remove建议，**未执行建议**。没有制造历史route、排新job或重置预算。旧schema下无route fragment的历史读取不进入新增完整来源上下文读取。

## 精确下一动作

1. 完成 ROUTE-003/010/011 的 A2 proposal/diff/权限决策 API 和现有详情 UI；绑定持久化批准记录、乐观版本检查，媒体许可不能改正文。完整已发布三日稿fixture和浏览器决策流在这里做。
2. 完成 ROUTE-006/007 的子路线/panel用途与受控裁剪契约（B/C负责后续真实字节衍生链）；增强多来源同字段冲突消解与非关键条件降级，补ROUTE-001普通知识/混合矩阵。当前scope内部接口已经可用，不再从单fragment实现重做。
3. 完成 ROUTE-008/012：现有route artifact→article_visuals/manifest；把render失败恢复放在图片子任务，避免重买正文；全面旧QA失效和最终交付依赖检查。同槽位预算保留已做，但不代表删除/重新创建槽位等完整修订预算链通过。
4. 组合备份恢复人工关系+路线+暂停媒体任务、必要浏览器E2E与相邻审计；仅全部A2独立缺口关闭才能A2_LOCAL_ACCEPTED。无需重复阶段01/02-PRE/A1验收。

B负责通用母图/衍生；C负责封面/接收；D负责采用锁/outbox/续跑。A1 PDF仍是来源补图，不能冒充文章采用。不得以B/C/D待验掩盖上述A2独立接口未完成。

## 副作用与停止

无commit/push/merge/部署、云构建/快照、生产读取/备份/迁移/写入、WordPress写入、真实模型/地图请求、独立公开前端修改。仅本地代码、测试夹具、证据及既有获准work库内事务。没有启动浏览器/开发服务/子agent。测试进程完成后停止；保留副本和证据。

最终[git status](a2-resume-git-status.txt)、[diff stat](a2-resume-diff-stat.txt)包含前置未提交成果，不能视为本轮独有改动。

current_authorized_step=NONE

phase_end_stop=true
