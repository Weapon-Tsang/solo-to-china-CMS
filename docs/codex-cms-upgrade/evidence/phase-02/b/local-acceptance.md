# 阶段02 B 本地验收 · 2026-09-28

**B_LOCAL_ACCEPTED（限定下表本地能力） / STOPPED**。起点为 A2_LOCAL_ACCEPTED；A1/A2 历史成果保留，仅运行受 B 改动影响的回归。阶段02整体未完成；未进入 C/D。

入口实际 HEAD 为 `490dd7464d4beb46d3f89a578337c253917fbf7a`，标题 `Merge CMS upgrade checkpoint through A2 local acceptance`，起始工作树干净。旧 A2 报告记录的 `e9f7c8e...` 为历史身份，本轮不回退或改写。app 2.0.70 / schema82 不变；既有历史 work.sqlite 仍为 schema81。所有本轮成果未提交，原始规格和历史证据未覆盖。

## 实现与边界

| 要求 | 本轮本地结果 | 证据与限制 |
|---|---|---|
| MEDIA-001 | PASS_LOCAL_B | 原件/编辑母图/web_derivative 分层；母图 QA hash 保持，独立 parent/original/upload/served hash；Pipeline 入库、衍生篡改门禁、备份恢复。无变换收益时允许同字节复用，不伪造不同 hash。 |
| MEDIA-002 | PASS_LOCAL_B | Sharp 魔数解码/MIME、完整解码、EXIF 自动方向、sRGB、去 EXIF/XMP、透明、实际尺寸与 hash、原子保存。40MP 解码上限；网页编码进程内单并发。动画明确拒绝并保留输入，不截第一帧；不是任意大文件支持承诺。 |
| MEDIA-003 | PASS_LOCAL_B | 照片默认82（WEB_MEDIA_QUALITY 可配80–85）、宽1600、不放大；文字/路线图 lossless 且不缩小，已有原格式无收益则复用；小图显式告警。真实照片/文字图/竖图输出见 samples.json 和 output/phase02-b-media。 |
| MEDIA-004 | PASS_LOCAL_B_ONLY | 消费接收端实际尺寸，过滤异比例、放大和重复宽度的 srcset 候选；缺480/768/1200记录 EXT-SIZES；不额外生成响应式尺寸。T02-13 中16:9封面母图属 C，尚未执行。 |
| MEDIA-005 | PASS_LOCAL_B | key 包含 parent/purpose/crop/方向/色彩/尺寸/格式/质量/版本/Sharp依赖版本及route hash。缓存再次解码/hash校验；8并发复用、版本隔离、损坏拒绝。原子文件及预算回归；新增 JSON 文件引用随快照恢复且受清理保护。缓存不启用自动清理。 |
| MEDIA-006 | PASS_LOCAL_B | 母图资格在转码前及上传前核验；确定性变换不新增语义模型请求。优化失败只保留符合相同尺寸/去元数据规则的母图原格式并记录告警；失败不缓存，后续编码重试不生图/重写/清预算。源 QA 失败不能靠回退放行。 |
| MEDIA-007 | PASS_LOCAL_B_ONLY | 真实回环 HTTP 接收器：上传、服务器二次转码、丢回执、500、私有URL；输入 hash 与 served unknown 分开。接收端保存独立文件，删除本地母图后 GET 仍可读，期间无CMS服务依赖。真实 WordPress / CDN 均 NOT TESTED；未伪称公网实测。 |
| MEDIA-008 | PASS_LOCAL_B | 原有实体/来源匹配及alt门禁保持；复用已持久翻译region形成可阅读图注，保留归属，不重新OCR/购买翻译；去重与pending负例。既有路线图注含有向顺序。真实模型翻译准确性与公开站最终排版 NOT TESTED。 |
| MEDIA-009 | PASS_LOCAL_B | 无依赖包增改、R2、插件、DNS或订阅操作。未来如卸载，必须保留WP附件身份、公开媒体/私有备份分离、稳定域名、旧URL和回滚兼容，另立项目验证；本轮不作兼容承诺。 |

B 接上 A2 panel：有效、连续且证据区域在裁剪内的计划可进入 planned，仍须真实裁剪与独立输出QA。原件 hash、panel/scope/target route hash 绑定 PNG 裁剪回执；actual VertexImagen 请求构造给转译及QA的都是裁剪像素；全图分析不再当作子图的文本清单。原件未改，旧hash、缺回执、QA错误箭头拒绝。所有 Provider 回应在外部边界受控，0真实请求，不能据此声称真实视觉判断质量通过。C封面裁剪/候选资格和D人工采用锁/outbox未执行。

## 测试分层

Change class: **PIPELINE / DATABASE_LOGIC / LOCAL_LOGIC**；panel改变实际模型输入范围，真实 Provider 验证仍按 AI_PROVIDER 未测列出。无schema迁移。

| 层级 | 状态与真实覆盖 |
|---|---|
| L1 Targeted | PASS：真实Sharp、MIME/坏图/动画/资源限额、透明/EXIF、缓存/回退、HTTP。targeted-first.log保留初轮8项。 |
| L2 Module Regression | PASS：module-final.log 150/150；随后仅新增小图告警和清理永久回归，audit-regression.log 34/34；atomic-budget-audit.log 5/5。最后收紧附件ID/MIME/内部URL回执校验，receipt-final.log 37/37。子集重叠，不将计数相加作为不同场景数。 |
| check/build | PASS：check.log，另对新模块/脚本执行 node --check；git diff --check PASS。 |
| L3 Production DB Replay | PASS **仅历史元数据兼容/投影/事务保护**：84 Sources、1,454 Source assets、12 Drafts、26 Visuals、12 Writing packets及jobs/model metrics/publications全表指纹不变。BEGIN IMMEDIATE + 每项SAVEPOINT + finally ROLLBACK；无新增副本/生产读取/迁移/历史回填。 |
| L4 Browser E2E | PASS **受影响的本地恢复/预览**：真实CMS登录→内容详情→重试失败图片→真实Worker→展开PNG；正文/revision/hash/slot及累计预算不变，pageErrors=[]。browser.log、output/playwright/b-media-recovered.png；没有跑公开WordPress浏览器流程或完整人工panel采用。 |
| L5 Real Provider Canary | **NOT TESTED**：用户禁止付费。裁剪输入后的远端质量/语言/箭头语义、真实服务接受度未验。 |
| L6 Full Production Replay | **NOT TESTED / 当前B模块交付不要求执行全链**：真实WordPress、完整Capture→发布及C/D组合未运行。 |
| Post-Fix Exploratory Audit | **ISSUES FOUND（历史可达性限制）**：0孤儿Visual；26个历史generated媒体的持久路径在此Windows副本不可访问。未取新生产数据或伪造ready；这些历史像素转码 NOT TESTED。本轮fixture检查：衍生篡改拒绝、清理引用保护、恢复路径重映射、旧hash拒绝、未知上传不自动重发、成功槽/预算保持均PASS。 |

历史回放不等于历史媒体修复，26项路径限制保持原状并见 historical.json。本轮实际像素证据来自真实本地Sharp/现有output来源文件及明确合成测试输入。样图里的测试QA许可仅为压缩验证，不是生产语义审批；中文文字样图未翻译，不作为英文发布成品。

## 用例映射

T02-09/10/11/12/15/16：本地PASS（web-media、publication-eligibility、backup及atomic回归）。T02-14/17：受控HTTP PASS，真实WP NOT TESTED。T02-18：绑定/alt既有门禁与翻译文本复用PASS，真实语义与公开排版NOT TESTED。T02-19 PASS。T02-13仅B的现有尺寸消费PASS，C封面部分PENDING_C。T02-75/80增加实际panel裁剪/真实请求构造/独立QA负例，不代表D完整采用流程或真实模型质量通过。T02-70增加web/panel引用恢复，不替代整个阶段验收。

## 可复现命令与证据

```text
node --test test/web-media.test.mjs test/web-media-http.test.mjs test/media-delivery.test.mjs test/wordpress.test.mjs test/publication-eligibility.test.mjs test/route-media.test.mjs test/route-production.test.mjs test/visuals.test.mjs test/backup.test.mjs test/content-recovery.test.mjs test/content-pipeline.test.mjs
node --test test/web-media.test.mjs test/backup.test.mjs
node --test test/atomic-media-file.test.mjs test/media-budget-recovery.test.mjs test/media-receipt-race.test.mjs
npm run check
node scripts/stage02-web-media-replay.mjs D:/cms-phase02-media-replay-xiKzH1/work.sqlite
node scripts/stage02-web-media-samples.mjs
node scripts/stage02-route-media-browser-fixture.mjs
npx --no-install --package @playwright/cli playwright-cli -s=bmedia run-code --filename=scripts/verify-stage02-web-media-browser.js
```

首次Pipeline测试使用了不完整topic fixture调用getDraftPackage而失败，见integration-first.log；改成uploadVisualMedia实际所需的draft ID输入后，真实repository读取、门禁、adapter和入库未替换，http-pipeline.log及module-final.log通过。旧失败日志保留。module-final命令还带了一个不存在的source-media-store测试路径，Node没有执行该路径；不计入覆盖，上述复现命令已去掉。

样图 source/output 的尺寸、字节、SHA256、实际本地路径和变换策略均在 samples.json。已逐图视觉检查：照片人物/地面结构与自然文字保持；竖图完整无裁剪；密集中文文字图原像素保持，没有模糊缩小；此检查不证明地点或文本事实真实性。业务原件未复制入Git证据目录。

## 交接与停止

文件身份见本目录 files.json，包含本轮产品/测试/脚本/交接文件前后hash及A2报告/原规范保持检查；git-final.txt为本轮最终改动清单。baseline.json记录入口状态。

实际程序默认从 loadConfig 给 WordPress adapter 配置生成目录，启用网页变换；应用 masterGuard 来自权威本地资格门禁。只构造旧式adapter且不传mediaDir的兼容测试/外部调用保持旧上传行为，不能当成新B能力证据。衍生可由保留母图重建；已投递版本不因质量配置变动而自动替换，配置变化作用于新变换请求，保留旧版本用于回滚。

未知上传仅停止自动重试并报告对账，不在B实现D的持久采用/outbox对账工作流。C继续消费实际尺寸和媒体身份，负责16:9封面与合同用途；D消费panel/网页谱系和回执，完成人工采用/修订/锁/outbox/续跑。不得将本报告作为C/D或整体阶段02通过凭据。

浏览器 bmedia 已关闭；自建服务PID22880使用 `C:/Users/Mloong/AppData/Local/Temp/cms-a2-media-browser-lvlNla/STOP` 停止，exec84390退出0。隔离数据库与历史证据保留，不停止用户服务。

无commit/push/deploy、生产读写、新生产导出、Cloud Build、真实付费请求、真实WordPress写入、公开前端仓库修改或子agent。**current_authorized_step=NONE；phase_end_stop=true。** B本轮本地范围已验收并停止；阶段02整体仍未完成，下一步只能在新授权后进入C。
