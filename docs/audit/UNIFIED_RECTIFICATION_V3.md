# SoloToChina v3.0 整改台账（DEVELOPMENT）

任务书：`D:\UU远程\GameViewer\Download\SoloToChina_Codex_Rectification_v3.0.txt`。本台账只记录本轮可复核证据；旧 QA、旧 SHA 和生产状态不作为本轮通过依据。两仓保持独立。初始阶段严格 DEVELOPMENT；用户随后明确授权提交、推送、合并和生产部署，两个仓库已分别合并并部署。六领域的完整验收仍未通过；未调用本轮真实付费模型，未修改生产历史数据或公开发布草稿。

## 2026-09-20 发布后补充验收

- 已部署：公开前端 `main` / `0c4b327287c016aee138f735a8a13eb2baa74542`（WordPress 父子主题）；CMS `main` / `21c217fa9c3b3bb56db6ea314dfa247bc837ca50`（不可变镜像，旧容器保留回滚）。生产 `/api/ready` 返回 `ready=true`、`database=ready`；`/api/health` 显示 Frontend Contract 1.4.1、当前前端 SHA 与 checksum `d83d9c0d…68276c880`，队列 active/queued/running 均为 0。
- L1/L2：CMS `npm test` 752/752 PASS，`npm run check` PASS，`npm run test:cross-repo` PASS；前端 `verify-upgrade.ps1` 静态及本地 runtime PASS；CMS `release:check` 50 mandatory PASS、0 failures、5 warnings、5 NOT TESTED。PHP CLI lint 未运行，但 WordPress Playground PHP runtime 已检查。
- L3（只读、非完整生产重放）：在 2,287,411,200 字节、74 sources / 1,395 opportunities / 10 drafts / 26 visuals / 6,181 model calls 的既有生产形态 baseline 上，以当前 CMS 不可变镜像、`--network none`、只读 bind mount 和 `PRAGMA query_only=ON` 重测：实际 UI 紧凑分页路径 214.8 ms / 10,996 B；旧 full 路径仍为 24,442.2 ms / 1,718,860 B。全路径慢的问题保留为明确剩余项，不以紧凑路径结果概括全部后台。
- L4（真实浏览器）：生产首页 FAQ 展开；Tools 日期检查显示 `RULE NOT CONFIRMED` 而非编造开票日；Share/More 展开、Escape 关闭；390px Tools 无横向溢出，移动菜单可打开并用 Escape 关闭。本地 CMS 和 WordPress 重新启动后，CMS 内容详情中的“预览最终页面”实际打开本地草稿 #40；长文章 fixture 的目录锚点、图片懒加载、旧/新商业卡、`sponsored nofollow noopener` 已检查。生产 WordPress REST 当前已发布文章数为 0，故公开文章验收不能宣称通过。
- 本地恢复缺陷及修复：Playground 重启后旧 CMS post ID 41 不存在，预览按钮返回 403。`scripts/deliver-local-contract-preview.mjs` 现在先验证本地映射的草稿仍存在且 slug 匹配，再决定更新还是重投递；`scripts/start-local-preview.ps1` 在隔离 WordPress 凭据就绪时自动执行交付。重复运行保持草稿 #40 唯一；CMS/WordPress 双服务完整重启后从 CMS 按钮再次打开 #40，匿名访问 `?p=40` 返回 404。仅本地测试数据受影响，未触及生产。
- L5 真实模型 Canary：NOT TESTED（v3 任务书未授权付费调用，本轮用户的“全部验证和验收”未给出具体付费预算）；L6 全生产形态可写重放：NOT TESTED。生产历史修复：NOT DONE。生产公开文章：0，故六领域总验收仍为 PARTIAL。

## S0 基线与 A01–A08 差距审计

| 项 | 当前判断 | 主要差距 / 待验证证据 |
| --- | --- | --- |
| A01 后台性能 | 部分 | 大 JSON/列表计算与菜单缓存路径仍需在非空生产形态数据下测 p50/p95、SQL/字节及 20 次切换。 |
| A02 翻译与排版 | 部分 | 已有翻译阶段，但溢出拆卡、失败重启后复用及移动端实页仍缺证据。 |
| A03 429 与预算 | 部分 | 已有节流/恢复部件；共享池及 provider/visual/deterministic 三预算须故障注入。 |
| A04 根错误归因 | 缺 | UI/持久层是否保留第一根因尚未证明。 |
| A05 媒体相关性 | 部分 | 既有热修须保留；实体/段落/槽位的适配和必需视觉义务仍缺证据。 |
| A06 旧商业长句 | 部分 | 非空默认旧披露进入新版 renderer 的行为尚未验证或修复。 |
| A07 内容承诺 | 部分 | 有计划字段，但实际 writer/reviewer/repair 输入与旧稿保护缺闭环证据。 |
| A08 全站 Taste | 部分 | 前端 Skill 已存在；本轮所有页面、组件、动效实操与降级验证尚未完成。 |

基线：CMS `C:\Users\Mloong\Documents\ChatGPT\solo-to-china-CMS`，`main` / `04bb45b708549394f043996ee82a62247458972f`，开始时 clean；前端 `C:\Users\Mloong\Documents\ChatGPT\solo-to-china`，`main` / `d1e0c078add5b988833c11a79ca995d59a237c72`，开始时只有既有未跟踪 `output/`。两仓可读写。已完整读取 CMS `AGENTS.md`、v3.0 任务书和前端 `.agents/skills/solotochina-redesign/SKILL.md`。

本轮风险分类：UI_ONLY、LOCAL_LOGIC、DATABASE_LOGIC、PIPELINE、AI_PROVIDER（已调整内容 QA 与视觉必需义务的模型 Schema/写作指引）。L5 真实模型未经本轮授权，保持 NOT TESTED；L3 仅隔离副本或合成生产形态数据，不能冒称生产重放。

## 逐阶段证据

| 阶段 | 当前状态 | 可复核证据与剩余项 |
| --- | --- | --- |
| S0 边界/基线 | 已建立，后续持续核查 | 真实本地 WP `http://127.0.0.1:9400/` 挂载父/子主题和 Tools；浏览器首页及长文章基线截图在前端 `output/playwright/v3-baseline-*.png`。隔离 CMS `http://127.0.0.1:9410/` 已用 `output/v3-preview/cms-preview.sqlite` 启动并浏览器登录。 |
| S1 后台性能/恢复/429 | 进行中 | `/api/content` 已数据库分页、轻量投影、UI 加载更多/30 秒菜单缓存；121 机会/60 长草稿合成隔离样本，20 次仓储测量全量 p50/p95 38.19/49.45 ms、1,040,976 B、728 次 SQL prepare，首屏 16.74/17.66 ms、44,557 B、288 次 SQL prepare。CMS 浏览器完成 20 次菜单切换与两次加载更多至 121 条；回归再扩 200 个旧记录，首屏 ID/SQL prepare/字节保持有界。根因归因回归：确定性文字溢出不继承同 Job 旧 429，缺明确 causal receipt 的历史调用不强行关联；视觉请求现在向 Job 错误携带准确 call ID。`failVisual` 在持久化 metadata 中分离 provider、视觉修订、确定性恢复计数；但 `failJob` 及跨进程共享池仍未完整分离。非真实生产库。 |
| S2 翻译/媒体/排版 | 进行中 | 译文缓存键移除仅排版用的资产指纹，新增 visual/draft/source bytes/region manifest/model/input/output hash 的持久化与读取校验；损坏 source hash 即使输入 key 相同也拒绝缓存。测试新客户端从磁盘 checkpoint 恢复，改变比例不重购翻译（translate=1），候选图 QA 429 后新客户端只续 QA（transform=1、QA=2）。文字卡改为单列、38px 图像正文、实际 SVG 字形测宽、长词/URL 换行与有界自动增高。G06 邻近改进：多地点素材继续不能成为单景点 hero，但有两站点、路线结构、正文对应证据的显式非 hero 路线图可进入相应章节；错旧 caption 不再为多地点图自证主实体，路线图 alt/caption 用已匹配用途生成。`factual_image_required`（不可伪造）与新增显式 `required_in_article`（确属核心交付义务）分开；仅后者在无合格原图时持久化失败槽位、阻止视觉 Job 和下游交付，补齐合格图可恢复同槽位；可选图片允许省略。视觉数量上限现在优先让位于晚序必需图，必需项超过上限仍保留为可见缺口，不会被截断隐藏；48 项相关回归通过。隔离 SQLite 的持久化/Job 回归通过。仍缺自动有序拆卡、child manifest/完整 WP 交付、实际手机尺寸截图、实体/裁切/最终 Editorial Fit 全链路；不能写成 G04/G06 完成。 |
| S3 全站前端 | 进行中 | 本轮实际修改设计令牌、父/子主题 CSS 顺序、文章/首页/Tools/商业样式；桌面与手机文章截图已目视复核，移动 Share 面板从底部截断修成视口内固定面板，Escape/焦点返回及目录 hash 偏移已实操。首页 More 在 390px 连续 10 次开合，卡片数稳定 4↔8、焦点/aria 同步。V/MOTION 全矩阵与降级仍缺。 |
| S4 内容/商业 | 进行中 | 精确非空旧默认披露在旧短码及新版商业 renderer 归一为 Paid link，自定义披露保留；PHP 蓝图新增缺/空/Paid link/非空旧默认/自定义五类输入断言，重启隔离 WP 后执行成功。内容方面，长清单行数降为 warning 线索，不能自行给 DATABASE_DUMP blocker；策略 3.8 的 reader_promise 与前 3 条具体 reader_job 必须在同一 QA 调用给出具名语义审核结果，旧 3.7 不追加新必需项，QA 调用名按策略区分缓存。定向 mock/规则测试通过，真实模型语义质量与三类冻样本闭环仍未测。 |
| S5 本地跨仓 | 进行中 | 本地 WP 蓝图首次因 CRLF/旧校验和失败，前端已修复 LF 生成/读取并再生镜像。Playground 不自动登录，专用本地测试账号和 REST Application Password 建立于隔离环境；CMS 配置仅指向 `127.0.0.1:9400`，库存同步成功。CMS `WordPressDraftAdapter` 真实 HTTP 投递当前草稿 #41，Contract 1.4.1 / checksum `d83d9c…76c880`、商业槽位回执、预览券同源。重启后首次投递撞到 WP Blueprint 尚未就绪的 404，脚本已加 route-ready 等待后重试成功。投递结果映射到显式 TEST DATA 的隔离 CMS record；本次最新代码重启 CMS 后，浏览器进入内容详情再次亲点“预览最终页面”，新标签经 scope ticket 到 `http://127.0.0.1:9400/?p=41&preview=true&stc_cms_preview=1`，页面标题与两条 Paid link/Trip.com 链接可见。此前实页截图 `output/playwright/v3-cms-to-local-wp-20260920.png` 已目视复核；原 Trip.com URL 与 sponsored/nofollow/noopener 属性曾核验。直接打开未带 preview 参数的草稿 `?p=41` 返回 404 属 WordPress 未发布草稿的正常权限边界，不应作为验收 URL。此处模拟的是 CMS 记录状态，不是完整 AI 内容生产链。 |
| S6 总验收 | 未开始 | 六领域均不可宣布完成。 |

## 六领域验收门槛

| 领域 | 状态 | 未满足的关键证据 |
| --- | --- | --- |
| B 后台性能 | PARTIAL | 非空合成形态 p50/p95/字节/SQL prepare 已记录，浏览器已做 20 次切换；真实生产库只读副本未重放，仍有逐行 SQL。 |
| R 恢复/429/根因 | PARTIAL | 确定性根因/历史无因果回执 regression，视觉译文/候选跨客户端复用；三预算、跨进程共享调度及 CMS 根因 UI 未完成。 |
| M 媒体/溢出 | PARTIAL | 视觉 checkpoint 和 QA 429 续跑定向测试通过，文字卡实测字形宽度并自动增高；两站章节路线图与错 caption 多地点拼图的局部相关性回归通过。显式必需图片与可选图片区分，数量上限不能吞掉晚序必需项，并用隔离 DB + Pipeline 证明缺图不触发生成或投递；自动拆卡、crop、独立 Editorial Fit 与 WordPress 顺序交付、移动端实页仍缺。 |
| F 全站视觉/动效 | PARTIAL | 真实 WP 桌面/手机文章及首页、Share/TOC/More 已操作；全 V/MOTION 矩阵、低速/noJS/两工具和性能重复测量仍缺。 |
| C 商业新旧链路 | PARTIAL | 非空旧长句和新卡通过本地 WP HTTP 投递、CMS 按钮打开实页；两卡 Paid link/URL/rel 浏览器核验。所有商业 ID、旧 WP 快照、历史精准 dry-run/URL 全覆盖仍待完成。 |
| E 内容承诺/旧稿 | PARTIAL | Writer/Review/Repair DTO 现有字段已检查；新增策略 3.8 读者承诺/Reader Job 必审回归与旧 3.7 不追加回归，长清单不再按行数硬拦。真实模型语义、完整 refs 定位、三冻结样本及旧稿 DB hash 不变仍未验证。 |

## 环境和验证边界

- 2026-09-20 发布准备补充：用户新授权提交、推送、合并和部署。前端 `codex/v3-rectification-staged` 起始提交 `55bf2c7…`，随后将子主题版本、manifest 与校验规则对齐为发布候选 `0.13.0`，最新前端 SHA `0c4b327287c016aee138f735a8a13eb2baa74542`；CMS `codex/v3-rectification-staged` 初始提交 `f3b9924…`。两仓独立推送；本段写入时 `main` 仍分别为原基线。CMS pin、GCE startup 和 CI workflow 已同步新前端 SHA；本次 pin 更新后的固定提交门禁须再跑。最终提交以 `git rev-parse HEAD` 为准。
- 线上只读基线：`https://capture.solotochina.com/api/health` 返回应用版本 `2.0.43`、ready=true、队列 active=0，当前活跃前端契约 SHA `0daedc5f3243c870427fffc36d5c168a25e8a01c`、checksum `57246c13…c49349f18`；生产 WP Registry 端点同一 ETag。隔离本地 WP 的新 Registry ETag 为 `d83d9c0d…68276c880`，两者确实不同。真实生产首页已用 Playwright 打开并目视核查改前状态，截图在前端未跟踪的 `output/playwright/v3-production-before-home-20260920.png`；此观察不是部署后验收。
- 发布决定：六领域 B/R/M/F/C/E 仍全部 PARTIAL；L3 当前生产 DB 只读来源副本重放、L5 真实 Provider canary、L6 全流程生产形态重放、全 V/MOTION/商业矩阵和拆卡最终 WP 交付未完成。离线门禁 PASS 不可替代这些，因此尚未合并 `main`、打包/安装正式主题、切换 GCE 容器或改写生产历史文章。下一步是补足真实数据/浏览器/模型授权范围内的发布证据并修复失败项，而不是直接切换流量。

- 本地 WordPress：`http://127.0.0.1:9400/`；`scripts/start-preview.ps1` 重建 Playground 测试站点（父/子主题和 Tools 当前代码），测试账号 `admin` / `LocalOnly-WP-V3-2026!`，非生产。当前测试草稿 `http://127.0.0.1:9400/?p=41&preview=true` 需登录；从 CMS 按钮可取得短期本地预览券。测试站点重启后 ID 可能变化；先启动 WP，再启动 CMS，重跑本地投递脚本。持续可达性/启动停止流程仍待验收。
- 本地 CMS：`http://127.0.0.1:9410/`，`scripts/start-local-preview.ps1`，账号 `local-review` / `LocalOnly-V3-Review-2026!`，独立 SQLite；`scripts/seed-local-preview.mjs --isolated-fixture` 明确标注的 121 机会/60 草稿测试数据，不代表真实业务内容。
- 浏览器实操：CMS “内容”→`TEST DATA · Local CMS delivery preview`→“预览最终页面”；该测试记录绑定的是本地 HTTP 投递草稿 #41 而非生产文章。前端首页 390px More 快点 10 次维持正确 4/8 数量及焦点。Taxi Card 对未收录长中文地址返回明确未核实 404，对已有 Forbidden City 本地目录生成带“入口/落客未确认”限定的司机卡，390px 无横向溢出，Driver Mode Escape 归焦；Find This Place 在识别供应商未配置时禁用且说明原因，不冒称真实识别。
- 本地自动化、浏览器操作、真实模型、线上生产、历史生产数据修复分别报告，绝不相互替代。
- 前端 Contract/能力已先在独立 `codex/v3-rectification-staged` 分支提交并推送，最新 commit `0c4b327287c016aee138f735a8a13eb2baa74542`；既有未跟踪 `output/` 未纳入提交。CMS 发布 pin 随后改为该准确 SHA。不会覆盖生产 URL、WordPress 身份、归因或现有合格媒体。
- 发布准备检查：前端 `verify-upgrade.ps1` 首次因本地 Playground 停止失败，重新启动隔离 WordPress 后完整静态/内容 runtime/Tools runtime PASS。CMS 首次把发布 pin 改为新前端 SHA 后，`release:check` 准确报出 GCE startup 与 CI workflow 仍引用旧 SHA；现已将三处 pin 对齐，再跑离线发布门禁 50 项 PASS、5 warning、5 not tested，固定新前端 SHA 的跨仓契约校验 PASS。离线发布门禁不等于六领域验收、真实模型 canary、生产数据库回放或线上主题核验。
- 本轮新增/扩展测试：最新全量 `npm test` 752/752 PASS，晚序必需媒体相关回归 48/48 PASS；`npm run check` PASS（含 build/boundaries），双仓 `git diff --check` PASS（前端仅 Git 行尾转换警告）。`node scripts/verify-cross-repo-contract.mjs --working-tree` PASS，明确验证未提交前端当前文件而非旧固定 commit。前端 `pwsh -NoProfile -File scripts/verify-upgrade.ps1 -BaseUrl http://127.0.0.1:9400` PASS（PHP CLI lint skipped，Playground PHP Runtime 已执行）；重启蓝图又执行五类披露回归成功。跨日从当前本地 CMS 重新点击预览最终页面打开 draft #41，两条 Paid link，截图 `output/playwright/v3-cms-to-local-wp-20260920.png`；390px 实操首页 More/导航 Escape、文章 Share Escape，reduced motion 下 Share 弹层仍可操作且计算 transition 为 `1e-05s`，前端截图 `output/playwright/v3-reduced-motion-share-390.png`。模型调用均为本地 mock；L5 真实 Provider NOT TESTED。
