# C 封面与合同：入口实现检查点（2026-09-28）

**C_PARTIAL / 本轮检查点；不是 C_LOCAL_ACCEPTED，不是阶段02完成。**

用户在本轮明确授权“B完成后进入下一阶段”。B补充验收完成后已进入C；D仍未授权。继续C本地工作不需要重新索取同一权限。原A1/A2、B成果和历史证据全部保留。严格DEVELOPMENT，未提交。

## 已实现

- cover-policy.mjs：候选资格/原因、自然招牌区别于密集文字/界面/多宫格、实体关系和母图QA要求、合格人工锁优先与无效锁不静默替换、精确整数16:9裁剪规划、主体安全范围、旋转后坐标、小图不放大及低于768px明确确认要求。
- cover-audit.mjs：按draft ID/revision只读审计当前稿件媒体。读取已有分析并核对原件hash，沿用现有readMediaBindings的只读实时校验，不从旧caption猜地点；实际解码母图、校验QA hash；主体几何必须绑定该母图。使用串行解码以限制资源；候选超过100时明确要求分批，绝不静默截断选图。
- 管理员GET /api/drafts/:id/cover-audit?revision=N：返回候选拒绝原因、拟选候选、裁剪规划、需要的本地步骤、外部依赖、旧媒体/revision回滚映射和输入指纹。无数据库写入、入队、远程读取、模型调用或上传；execution_enabled=false。版本/媒体/来源关系变化会拒绝过期计划。
- 这只是审计接口。没有生成裁剪文件、保存封面决定、替换特色图、启用新合同字段或在CMS UI提供封面编辑器；既有交付行为未被此接口改变。

## 验证

环境：Windows，Node v24.14.0，HEAD 490dd7464d4beb46d3f89a578337c253917fbf7a；app2.0.70/schema82不变。本轮C风险DATABASE_LOGIC（只读投影）+LOCAL_LOGIC。

- L1 Targeted Tests: PASS，5/5，api-targeted.log；包含真实合成图片解码、SQLite当前绑定及失效反例、真实回环HTTP管理员鉴权/409冲突。
- L2 Module Regression: PASS，29/29，module-final.log，命令：node --test test/cover-audit.test.mjs test/media-bindings.test.mjs test/publish-page.test.mjs。计数为执行测试数，不表示原T02矩阵29项完成。
- check/build: PASS，check.log；新增3个模块/脚本node --check及git diff --check PASS。
- L3 Production DB Replay: PASS（仅只读审计/兼容性），historical-final.json。仅既有获准D:/cms-phase02-media-replay-xiKzH1/work.sqlite，readOnly连接+BEGIN/ROLLBACK，9张保护表fingerprint不变、total_changes=0；12稿/26候选，0可自动采用，26母图路径不可达。没有重新复制大库、迁移或读取生产。历史像素、裁剪输出效果NOT TESTED。
- L4 Browser E2E: NOT TESTED（尚未实现C管理UI）；本地HTTP API测试不是浏览器验收。
- L5 Real Provider Canary: NOT REQUIRED（本轮确定性代码）；C真实AI封面质量NOT TESTED。
- L6 Full Production Replay: NOT TESTED。
- Post-Fix Exploratory Audit: ISSUES FOUND：历史路径不可达；既有buildPublishPackage仍仅在featuredMediaId为空时补值，C显式替换尚待实施。覆盖了失效绑定、伪几何尺寸覆盖、缺文件、无效锁、过期revision等相邻负例。

## C需求与原测试映射（不提前填写完成）

| ID | 当前范围与状态 | 原测试 |
|---|---|---|
| COVER-001 | PENDING：独立用途持久化和接收能力门控未接通 | T02-20/21 NOT TESTED |
| COVER-002 | PARTIAL：本地分类/拒绝原因通过；最终选择UI/实际交付未验 | T02-22/23 局部PASS |
| COVER-003 | PARTIAL：锁定优先/无效锁停止/当前实体绑定通过；跨存量检索和持久选择待做 | T02-24 局部PASS |
| COVER-004 | PARTIAL：整数16:9几何/安全范围规划；真实裁剪、预览和确认未做 | T02-25 局部PASS |
| COVER-005 | PENDING：抽象插画适用性、最多2候选及共享预算集成待做 | T02-26 NOT TESTED |
| COVER-006 | PARTIAL：dry-run零模型/无自动AI兜底；完整封面缺失交付门禁待做 | T02-07/26/27 组合NOT TESTED |
| COVER-007 | PARTIAL：1200x675目标、小图不放大/质量确认规划；真实字节软目标待做 | T02-13/25 组合NOT TESTED |
| CONTRACT-001 | PENDING：内部持久字段与固定合同映射待做 | T02-21/28/31 NOT TESTED |
| CONTRACT-002 | PENDING：显式特色图更新、并发保护、回执对账待做；当前执行关闭 | T02-29/30/32 NOT TESTED |
| CONTRACT-003 | PENDING：card title/deck既有一次bundle及内部保存待做；无新模型调用 | T02-28/31 NOT TESTED |
| CONTRACT-004 | PARTIAL：revision审计/拒绝理由/旧媒体映射/零写；分页检查点及执行闭环待做 | T02-27/29/30/32 局部PASS |
| CONTRACT-005 | PARTIAL：既有历史缓存身份已记录；接收端能力及严格兼容矩阵待做 | T02-31/32 NOT TESTED |

历史缓存：frontend commit 0c4b327287c016aee138f735a8a13eb2baa74542，contract1.4.1；registry/schema原始hash及checksum见historical-final.json。此身份不证明制品来源完整性复验或线上实际版本。EXT-PURPOSE/REFRESH/CARD仍未验，不启用外部能力。没有修改合同缓存或公开前端。

## 接续位置

继续C：先完成内部cover/body/social数据设计和固定合同能力矩阵，再接通母图独立裁剪、CAS选择/锁定与CMS预览、既有主bundle卡片字段、媒体回执/发布替换门禁及相关恢复测试。不得直接把dry-run的eligible当发布许可；不得用fixture证明真实Provider/WP通过。复用本轮测试和B成果，不重做A1/A2。不进入D或阶段03。

未提交成果见files.json；此前报告不覆盖。所有本轮自建测试服务在测试finally中关闭；未启动后台Worker或浏览器。本轮副作用：commit/push/merge/deploy/生产私有读或导出/生产WP写/付费模型/云资源操作/生产迁移/公开前端改动均为否。

current_authorized_step=NONE
phase_end_stop=true
