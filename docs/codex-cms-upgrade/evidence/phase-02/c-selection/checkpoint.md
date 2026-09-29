# C 封面本地选择与裁剪检查点（2026-09-28）

**C_PARTIAL / 封面本地选择增量通过；不是C整体完成。**

从C入口检查点继续，保留B_LOCAL_ACCEPTED及A1/A2历史成果。DEVELOPMENT；D/阶段03不在范围。本轮为DATABASE_LOGIC + LOCAL_LOGIC + UI；未改schema（82）或app版本（2.0.70）。HEAD 490dd7464d4beb46d3f89a578337c253917fbf7a，Windows/Node v24.14.0，未提交。

## 实际实现

1. cover-media.mjs根据经过审计的母图hash、安全区域和焦点生成独立16:9发布母图。实际EXIF归一、sRGB、元数据剥离、WebP质量82、原子文件保存与解码验证。目标1200x675；小图不放大，低于768需明确质量确认；220KiB为告警软目标。原件和正文母图不覆盖；失败只回退确定性PNG，不调用模型。
2. cover-selection.mjs实现预览与确认：必须提交稿件revision、审计fingerprint、母图hash，确认必须绑定实际预览SHA256；保存前重新审计来源、图片和当前状态，并以BEGIN IMMEDIATE核对数据库变化及旧selection ID。双击/并发只有一个确认可生效，过期请求409。锁定封面切换到另一候选须明确带原锁ID；锁定不是文件或实体规则的豁免。
3. 复用article_visuals.media_metadata_json保存cover_geometry、cover_active_id、cover_locked及追加式cover_selections历史。只有一个active指针；历史记录含来源ID、parent/output hash、policy、purpose、crop/focal、操作者/时间。正文媒体字段、文章文字/标题/slug/revision/content hash保持。未新增schema。
4. 管理员API：GET /api/drafts/:id/cover；POST /api/drafts/:id/cover/preview；POST /api/drafts/:id/cover。既有cover-audit复用当前已确认绑定并标记QA依据。普通保留原件可沿用已有确定性实拍资格（实际原件hash、当前绑定、分析/保留决策），不伪造独立模型QA；转换母图支持已有四维QA，并保留拼写失败否决。
5. CMS生产详情新增封面面板：候选理由、母图、主体/焦点百分比、真实裁剪预览、清晰度确认、人工锁、确认保存、刷新后已存封面。语义HTML/可访问标签及键盘确认。只有本地预览，不上传或发布。
6. Pipeline上传入口及publication eligibility在存在本地选择而接收端未验时，返回COVER_RECEIVER_CAPABILITY_UNVERIFIED，在任何媒体上传前阻断。**当前始终关闭所选封面的外部交付**；还没有支持已验证接收端的上传/替换闭环，不把此门控冒称完整C。
7. cover-contract.mjs只读核实当前激活缓存：固定40位commit与组合artifact hash、各文件hash、明确字段映射。历史缓存1.4.1/commit 0c4b327287c016aee138f735a8a13eb2baa74542组合hash校验PASS；featuredMediaId字段存在，cardTitle/deck不存在。未修改缓存、未推断线上版本，也未新增外部字段。
8. 沿用B的递归JSON文件引用，实际测试封面历史文件跨目录恢复和源清理保护；恢复后接收端门控仍生效，不会自动dispatch。

## 分层证据

- L1 Targeted Tests: PASS。最初7/7；最终受影响相关模块42/42（final-regression.log）。包含EXIF/透明度/小图不放大、四维QA、零付费保留原件、预览确认、并发/过期负例、锁定历史与交付前零上传。
- L2 Module Regression: PASS。命令node --test test/cover-audit.test.mjs test/cover-selection.test.mjs test/publication-eligibility.test.mjs test/media-budget-recovery.test.mjs test/media-delivery.test.mjs test/publish-page.test.mjs，42/42。备份组node --test test/cover-selection.test.mjs test/backup.test.mjs，29/29（backup.log，为较早重叠子集，不相加）。
- check/build: PASS，final-check.log；最后已存封面缩略图增量build PASS（final-ui-build.log）。存在既有bundle>500kB提示，不是失败。新增模块node --check与git diff --check PASS。
- L3 Production DB Replay: PASS（限定只读兼容/审计），final-historical.json。仅既有获准D:/cms-phase02-media-replay-xiKzH1/work.sqlite，readOnly + BEGIN/ROLLBACK、9张保护表hash不变；12稿/26候选，26历史母图路径不可达，未在历史稿伪造合格选择。历史真实图片裁剪/选择持久化组合NOT TESTED；没有新生产读取、导出或复制大库。
- L4 Browser E2E: PASS（本轮本地选择流程），browser-result-file.log/browser-final-saved.log。真实登录→内容详情→选图→填写安全范围→生成预览→键盘Space确认→保存→刷新回读；检查正文、title、slug、revision、content hash不变。320/768/1024/1440弹窗无横向溢出；无pageerror。照片为明确合成夹具，不证明实拍语义质量。截图output/playwright/c-cover-confirmed.png、c-cover-saved.png已人工查看。初次CLI直接传多行脚本的SyntaxError保留在browser-result.log，改用--filename后通过；没有删失败证据。
- L5 Real Provider Canary: NOT REQUIRED（本轮无Provider/Prompt变化），真实封面生成质量NOT TESTED。
- L6 Full Production Replay: NOT TESTED。
- Post-Fix Exploratory Audit: ISSUES FOUND（已知历史文件不可达；C未完成能力）。已增加过期来源绑定/QA四维结构/保留原件零模型/删除引用/并发确认/接收能力未验零上传回归。

浏览器实际输出（合成图）：原件SHA256 6274f4673a369527ec813b109de932b940b539e219f0c72c00adf8513e9a59e2；衍生SHA256 2b86d0031b53f2d079414a531538733d2413fb38505574664f06638cf9e80a37；1200x675，webp，1746 bytes；母图QA/hash链和记录详见browser-persisted.json。非真实AI输出。

## 当前需求状态

| 要求 | 本轮状态 | 原测试范围 |
|---|---|---|
| COVER-001 | PARTIAL：独立cover记录/文件不进正文、未验接收端门控；social和支持接收端分支待做 | T02-20/21 未验分支保留 |
| COVER-002 | 本地分类/原因/自然招牌与密集图回归PASS；真实语义NOT TESTED | T02-22/23 本地覆盖 |
| COVER-003 | PARTIAL：当前文章实拍、锁定、拒绝原因PASS；同实体跨库存召回/插画优先级待做 | T02-24 局部覆盖 |
| COVER-004 | 本轮本地实际裁剪/安全范围/预览确认/版本保护PASS | T02-25 本地覆盖 |
| COVER-005 | PENDING：抽象插画适用规则、最多2候选和共享预算路径未实现 | T02-26 NOT TESTED |
| COVER-006 | PARTIAL：普通实拍/裁剪零模型、已选封面缺能力阻断PASS；必需封面未选的通用门禁待做 | T02-07/27 局部覆盖 |
| COVER-007 | 本地像素尺寸/小图确认/软字节告警PASS；真实照片软目标质量待验 | T02-13/25 局部覆盖 |
| CONTRACT-001 | PARTIAL：内部cover字段及固定缓存映射；card/social持久用途待做 | T02-21/28/31 部分 |
| CONTRACT-002 | PARTIAL：未验接收端明确阻断，支持端显式特色ID替换/回执对账未实现 | T02-29/30/32 支持分支NOT TESTED |
| CONTRACT-003 | PENDING：既有bundle的card title/deck生成和内部保存未做；没有覆盖正式title/excerpt | T02-28/31 NOT TESTED |
| CONTRACT-004 | PARTIAL：dry-run/revision/本地选择锁与历史可用；>100候选分页和小批次检查点待做 | T02-27/29/30/32 局部覆盖 |
| CONTRACT-005 | 当前固定缓存hash及严格字段检测PASS，真实接收端能力NOT TESTED | T02-31/32 本地/外部分开 |

## 接续与限制

下一步仍是C：实现当前固定合同支持的明确特色图交付映射和可验证回执（测试接收器/固定本地WP，未经验证保持关闭）；补卡片短文案在既有bundle内返回及内部保存；同实体已存候选/抽象插画有界预算、必需封面门禁及分批dry-run。不要再重做B或A1/A2，不进入D/阶段03。继续这些本地工作已获授权，无需重复确认；外部真实付费/生产操作仍禁止。

这是上下文检查点，不是外部依赖导致所有本地工作无法继续。未将C缩写成“已完成”，未使用阶段02整体成功句式。当前实现对选择封面的新交付关闭，报告这一限制是必要的。

自建PID21976/API服务及Playwright ccover已关闭；没有停止用户服务。副作用：commit/push/merge/deploy/生产私有读导出/生产WordPress写/付费模型/生产迁移/云资源操作/公开前端改动均为否。历史报告及本轮失败日志保留，文件前后hash见files.json。

current_authorized_step=NONE
phase_end_stop=true
