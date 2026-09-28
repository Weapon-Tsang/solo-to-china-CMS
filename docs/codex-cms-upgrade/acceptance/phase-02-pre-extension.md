# 阶段 02-PRE：扩展关页与采集等待修复

当前状态：**PASS_LOCAL / LOCAL_BROWSER_ACCEPTED / STOPPED**（2026-09-27）。用户实际扩展与真实账号验证单列为 UNKNOWN / NOT TESTED。

本轮仅 DEVELOPMENT。阶段 01 `PASS_LOCAL / LOCAL_CAPABILITY_ACCEPTED` 保持；阶段 02 v1.4 的 A1 检查点、68 项要求和 90 项测试原样保留，本轮不代表阶段 02 主体完成。

## 基线与已证实因果链

- 实际工作目录：`C:\Users\Mloong\Documents\ChatGPT\solo-to-china-CMS`；remote `https://github.com/Weapon-Tsang/solo-to-china-CMS.git`；branch `main`；HEAD `e9f7c8e82ff760f4d18f2d2e0673452eb8744290`。进入任务时已有阶段 01/02 未提交改动；完整初始状态、diff stat 和扩展哈希见 `evidence/phase-02-pre-extension/baseline.json`。
- 原版 2.0.70 从 HEAD 单独复制进无凭证测试 profile，真实 Chrome 153.0.8010.12 / MV3 复现：关闭发现页后仍为 running，并新建 1 个替代发现页。路径为 `ensureDiscoveryTab → tabs.get 失败 → tabs.create`，driver/alarm/restart 持续续跑；工作页也存在 update 失败直接 create 的路径。
- 独立复现暂停等待：原版 reportSession 的服务器不返回时，本地暂停回执耗时 **45,018 ms**，见 `browser-baseline.json`。这证明上报会阻塞暂停确认，不等于证明用户实际账号的全部卡死都来自上报。
- 静态与定向故障证据还确认：executeScript 异步结果缺少外层等待上限；heartbeat 改写 lastProgressAt；列表稳定四轮被当作 collectionEnd。新测试分别覆盖有界 DOM 等待、心跳与业务进展分离、无进展暂停而非假完成。
- 用户现用扩展 ID、版本、加载目录、是否同时启用两份包、实际 CMS endpoint / token / profile：**UNKNOWN / NOT ACCESSED**。真实小红书 DOM、账号和云端 CMS 的实际根因仍为 **unknown**。

## 实现范围与兼容

| 文件 | 本轮变化 |
|---|---|
| `extension/background.js` | 单飞 start/resume；runRevision fencing；browser-session 身份与 tab 所有权；关页/离开范围持久暂停；显式 close intent；晚到 create 清理；暂停取消本地先回执；预检先于自动开页；阶段诊断；有界上报 outbox；恢复时查询接收状态、保存真实回执 |
| `extension/run-control.js` | 运行版本检查、可取消有界等待、tab/window/URL 归属匹配 |
| `extension/sync-core.js` | 旧队列/游标/身份保留；所有 paused 状态均不被恢复为 running；关闭、只读及阶段超时错误分类 |
| `extension/page-extractor.js` | DOM 协作取消、timer/observer 清理；不再用静止轮数冒充收藏结束 |
| `extension/popup.js` | 关页暂停、权限、只读、无进展提示；保存设置不再声称已完成连接检查 |
| `extension/manifest.json` | 测试/待用户加载版本 **2.0.71**；正式权限未扩大 |
| `src/media-storage.mjs` | Windows 并发相同媒体回执 rename 冲突：仅复用哈希/类型/长度/文件 stamp 全部吻合的已有可信回执；清理本次临时文件；不放宽验证 |
| `test/extension-run-control.test.mjs`、`test/media-receipt-race.test.mjs` | 新增关页、fencing、晚到 create、双击、自动任务禁跑、权限、上报预算、Windows 回执回归 |
| 既有 extension/favorites/DOM 测试 | 更新旧的“丢页重建/静止即结束/删旧队列”断言；并发池测试改为事件屏障，避免高负载下 40ms/2ms 定时器偶发乱序 |
| `scripts/verify-extension-pre-browser.mjs` | 真 MV3、合成页面、真实回环 CMS、故障注入、原版对照及证据留存 |

兼容字段：`controlSchema=1`、`runRevision`、`browserIdentity`、`tabOwnership`、`autoBlocked`、`resumePending`、`noProgressSince`、`lastBusinessProgress`；新诊断/上报键为 `favoritesSyncDiagnostics`、`favoritesReportOutbox`。旧 journal 格式未改，未清 storage/IndexedDB/队列。旧会话无法证明当前页面归属时暂停；明确继续才重建缺失页面。成功项、媒体 bytes、已确认块和回执保留。

## 等待与重试预算

| 阶段 | 当前预算与退出规则 |
|---|---|
| 发现列表 | 单次 DOM 调用 30s；无新增身份默认 120s 后 `DISCOVERY_STALLED` 暂停；只有页面明确结束信号可以标 collectionEnd |
| 注入 | 每次 30s，暂停 signal 可提前停止等待 |
| 详情加载 | 沿用用户 `detailLoadTimeoutMs`，默认 30s；关闭直接暂停 |
| DOM 提取 | 页面原有 120s 内容准备预算；外层 executeScript 默认 150s；一次 frame replacement 可额外执行有界加载/注入/重试，不无限重注入 |
| CMS 请求 | 45s 总时限、15s body idle；401/403、协议/只读/host 权限明确分类；429 保留 Retry-After |
| 媒体 | 图片 30s / 视频 180s 总时限、15s body idle；不缩短既有正常媒体预算 |
| 信号量/整条任务 | 共享可取消 signal；任务总预算 30min；取消释放等待者，已有传输按已有 transport 退出 |
| 重试 | 沿用 maxRetries 默认 3（更严格用户值保留）；driver 按失败尝试计数；重建页不重置错误预算 |
| 状态上报 | 本地回执不等待；失败诊断独立记录；最多 3 次，后续由原有 minute alarm 处理，不让 paused 会话续跑 |

诊断最多保留 200 条，包含会话/版本、tab 角色、操作/阶段、时限、耗时、状态码、重试数。没有 token、Cookie、正文、签名 URL；scope 用会话标签表示。heartbeat 只记续租，不冒充媒体 ack/新身份等业务进展。

## EXT 当前态

| 编号 | 状态 | 证据/边界 |
|---|---|---|
| EXT-001 | 本地实现并验证 | 原版因果对照、受控 deadline、脱敏诊断；用户实装根因 unknown |
| EXT-002 | 本地实现并验证 | 真实发现页/工作页/整个窗口关闭；无关页关闭负例 |
| EXT-003 | 本地实现并验证 | paused + scope 禁跑持久化；worker 重启；设置与 GET_STATE 不启动新采集 |
| EXT-004 | 本地实现并验证 | 单飞、revision、late-create 清理；并发 slot 沿用设置 |
| EXT-005 | 本地实现并验证 | 离线 popup 暂停小于 1s；outbox 上限回归；服务器已经收到的写入不声明撤销 |
| EXT-006 | 本地实现并验证 | 真实 DOM timeout、列表无进展；transport、semaphore、DOM observer 取消回归 |
| EXT-007 | 本地实现并验证 | 自动预检先于开页；真实 401/Origin 403；只读/host 权限分类及隔离模式测试 |
| EXT-008 | 本地实现并验证 | 实际正文/多图/回执；分块恢复；回执丢失幂等；19 图与上下文原有回归 |
| EXT-009 | 本地实现并验证 | 旧状态真实 storage 故障夹具 + 单元；用户实际扩展更新 NOT RUN |
| EXT-010 | 本地浏览器与有限回归 | 独立 profile、真实 tabs/runtime/storage/alarms、回环 CMS；不执行阶段 02 主体 |

## XP 验证矩阵

“PASS”仅指右侧列出的测试覆盖；未运行的层不借用其他层冒充。所有真实账号 Canary 均 **NOT RUN**。

| XP | 单元/模块 | 独立真实浏览器覆盖 | 证据 |
|---|---|---|---|
| 01 | PASS | PASS：关发现页后至少 130s / 2 次原始 watchdog，不补页 | `browser-full.json`、run-control 测试 |
| 02 | PASS | PASS：发现页、工作页、整个窗口；无关页不影响 | 浏览器 checks XP-02 |
| 03 | PASS | 完成保留借用页、正常清理不重开；复用页/重复 cleanup 在单元覆盖 | run-control XP-03/16、浏览器首轮完成 |
| 04 | PASS | worker 真正终止后唤醒仍暂停；浏览器进程重启另列最终 checks | 浏览器 XP-04、自动禁跑与 outbox 测试 |
| 05 | PASS | 双击继续一个发现页；缺失工作 slot 恢复原队列 | 浏览器 XP-05 |
| 06 | PASS | create 延迟返回/并发启动竞态用确定性单元；浏览器双 Resume 已测；native create 延迟注入 NOT RUN | run-control XP-06；不冒充原生竞态复现 |
| 07 | PASS | 关闭 popup 时采集完成，重开仍为同一会话 | 浏览器 XP-07 |
| 08 | PASS | 真 popup + 离线 CMS 快速暂停；原版 45018ms 对照 | 浏览器 XP-08、baselinePause、上报预算测试 |
| 09 | PASS | 真 CMS token 401 / 不允许 Origin 403；host 与只读用定向测试 | 浏览器 XP-09、local-runtime/server/run-control |
| 10 | PASS | 真 executeScript 永不返回按 150s 退出；页面/响应体附加故障证据单列 | `browser-full.json`、deadline extras、transport |
| 11 | PASS | 正常多图与 5.08MB 原图；19 图、延迟 DOM、caption/nearbyText 由模块回归 | reliability-dom/media、capture、XP-18/15 |
| 12 | PASS | 原有 120s 无进展预算实际运行，暂停而非 completed | 浏览器 XP-12 |
| 13 | PASS | 同 scope hash SPA 与登录导航检查；frame 移除/重注入用单元 | 浏览器 XP-13、background-recovery |
| 14 | PASS | 真实接收后丢弃最终回执，只有一条 source；Chromium transport 重发由服务器幂等处理 | fault checks XP-14；模块断言重复接收不新增提取 Job |
| 15 | PASS | 5.08MB 图第二块已落盘但无 ack；暂停、worker 重启、继续；GET 对账后不重传该块 | fault checks XP-15、journal 记录、API 事件 |
| 16 | PASS | 真实 storage 注入 legacy running + 无效 tab/browser identity，保留队列并暂停 | 浏览器 XP-16、归属/复用页单元 |
| 17 | PASS（测试包） | 测试 ID/版本/profile/路径/加载 hash 全记；用户多份扩展检查 UNKNOWN | 各 browser JSON 与 baseline.json |
| 18 | PASS | 合成收藏→详情→正文/多图→真实回环 CMS 持久回执，非模型完成 | 浏览器 durableSources/durableAssets/API events |
| 19 | PASS | 真实 popup 暂停/登录/连接提示与操作；未将后台模型工作显示为浏览器上传卡死 | `output/playwright/phase02-pre/`、popup progress tests |
| 20 | PASS | 仅相关采集/安全/隔离/幂等回归、check/diff check | targeted-tests.txt、check.txt、final-state.json |

## 证据来源、环境与副作用

新增浏览器证据来自 `scripts/verify-extension-pre-browser.mjs`。命令：

```text
node scripts/verify-extension-pre-browser.mjs <playwright/index.mjs> --baseline
node scripts/verify-extension-pre-browser.mjs <playwright/index.mjs> --faults
node scripts/verify-extension-pre-browser.mjs <playwright/index.mjs> --quick --deadline-extras
```

Playwright 从已有 npx 工具缓存加载，未给项目安装新依赖；测试 Chrome for Testing 下载至工具缓存。每轮独立 `%TEMP%/stc-02pre-*` profile、SQLite、媒体和本地 TLS 夹具，保留便于复查。正式 manifest 没有新增 host 权限；测试复制版仅放行回环临时端口，并加一个导入原模块的 test bridge 供 deadline 故障注入。正常采集命令仍走 runtime/popup。测试无用户 Cookie/token，不使用 `.env`；CMS `processRole=api`，schema 81 临时空库初始化，没有启动模型 Worker。

最早一次 Playwright 路由夹具存在首航拦截缺口：原生扩展创建详情页到达了**未登录的公共验证页**，不是合成页；它没有用户凭证，也没有访问用户收藏。该轮 FAIL，不作为成功采集证据。后续增加全域 DNS 回环、禁止代理、只服务允许的合成主机；浏览器首次导航也无法到公网。后续证据的 `networkBoundary` 字段明确记载此差异。不得把本轮副作用写成“从未访问任何小红书域名”。

复用并重跑：既有 capture、media journal/upload、transport、19 图、CORS/auth、local-runtime 等相关测试。阶段 01 当前 PASS 只引用 `evidence/phase-01/v12-local-closeout-20260927.md`，未重开其历史阻塞。无关阶段 02 路线/图文绑定不作为此次门槛。

发现并处理的相邻问题：相同媒体字节并发上传在 Windows 触发 verified receipt `EPERM`；保留失败轮次并添加严格等价回执复用回归。故障夹具曾有 DB 初始化顺序、service-worker 动态 import 不支持、popup 初始渲染时序等测试脚本错误；均与产品结果分开，失败轮次没有记 PASS。

真实生产数据库读取/写入、真实模型调用、WordPress 写入、云资源操作、commit、push、deploy、用户 profile 修改、独立前端仓库改动：本轮均未执行。已有本地未提交改动全部保留；具体全工作树差异与本轮文件边界见 final-state.json。

## 用户实际扩展的最小后续操作

实际加载状态 **NOT TESTED / 未替用户更新**。在用户愿意切换时，于 `chrome://extensions` 核对该采集扩展的 ID、版本和加载来源；确认目标为本 CMS 的 `extension` 目录或对应打包目录，再重新加载到 2.0.71。不要卸载，不清存储；若同时存在旧包，先确认各自用途再决定停用。核对 endpoint 与本次实际希望接收的 CMS、host 权限和 CAPTURE_TOKEN；不能把测试临时端口当成正式设置。

本轮不要求真实账号 Canary 才接受本地状态机，也不擅自执行。若另行授权，应明确 1 个指定收藏/笔记、最大条数、接收 CMS 和允许产生的采集记录；不默认批量采集或启用生产。

## 风险分层与交接

- Change class：**PIPELINE**（扩展持久状态/恢复）＋最小接收端文件竞争兼容；没有 schema / 历史数据转换。
- L1 Targeted Tests：**PASS**。
- L2 Module Regression：**PASS**，最终相关集合 **106/106**；`npm run check` PASS；新增 helper / 浏览器脚本 / audit 脚本语法检查与 `git diff --check` PASS。
- L3 Production DB Replay：**NOT REQUIRED**。本次不改 SQL、历史生产业务投影或数据库 schema；真实扩展 storage/journal 与临时真实 CMS 接收链已验证。未读取生产库。
- L4 Browser E2E：**PASS（独立测试 profile）**；真实账号兼容性 **NOT TESTED**。
- L5 Real Provider Canary：**NOT REQUIRED / NOT RUN**。
- L6 Full Production Replay：**NOT REQUIRED / NOT RUN**，未运行 Capture 之后的模型/内容生产链。
- Post-Fix Exploratory Audit：**PASS（限定本地范围）**。发现的 Windows 回执竞争已加修复和回归。只读检查本轮合成 CMS：4 条唯一来源、8 条当前版本媒体均 hash/长度匹配、caption/nearbyText 保留、4 条且每来源唯一的 queued extract_source、外键错误 0。API-only 无模型 Worker，因此 queued 不作为故障。证据：`post-fix-audit.json`。

顺序：已通过阶段 01 → 02-PRE → 阶段 02 v1.4 主体 → 阶段 03。本轮结束后不自动继续主体、不留后台子任务。

API 技术依据（不是验收证据）：[tabs.onRemoved](https://developer.chrome.com/docs/extensions/reference/api/tabs#event-onRemoved)、[service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)、[alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms)。

## 最终计量、证据复用与停止点

- 原版对照：`browser-baseline.json`，2.0.70，关页后 running + 1 个替代页，暂停确认 **45018ms**。
- 完整本地矩阵：`browser-full.json`，2.0.71，实际观察 **130351ms / 2 watchdog**；DOM 等待 **150008ms**；实际 120000ms 无进展预算；分块/丢回执、SPA/登录、legacy storage、worker 重启和**浏览器进程重启**均有单独结果；离线暂停 **55ms**。
- 最终源码补充验证：`browser-deadlines.json` / `browser.json`，2.0.71，加载超时 **30015ms**、body idle **15017ms**、离线暂停 **41ms**，同时重跑正常采集、工作页恢复、窗口关闭、权限、旧状态和完整浏览器重启。
- 完整矩阵之后只有完成状态上报从等待 `reportSession` 改为 detached outbox 的两行控制差异；精确差异为 `reused-browser-delta.patch`。最终补充浏览器轮次使用当前源码，实际完成采集再开始新会话，覆盖这条完成路径。未受影响的 2 周期/150s/120s/分块结果复用完整矩阵，不冒充在最终补充轮次重跑；两个版本的 loadedHashes 都保留。
- `browser-faults.json` 是较早的独立故障轮次；最终分块/回执丢失当前证据优先看 `browser-full.json`。XP-14 的 Chrome transport 重试发生在同一任务 attempt 内，由真实服务端幂等保证单 source；没有把它描述成已观察到 extension 第二次 lease 的 identity-check。
- 运行标识、测试包 ID、加载目录、profile、回环端口、数据库身份及 hashes 在上述 JSON；git status / diff stat / 本轮文件清单和副作用在 `final-state.json`。临时目录保留，仅本轮测试浏览器与进程已结束；未停止用户 CMS。
- `current_authorized_step=NONE`
- `phase_end_stop=true`

阶段02-PRE扩展采集稳定性已完成本地验收，本轮已停止。用户实际扩展/真实小红书验证状态已单列。请在同一CMS实际工作目录的新对话中继续阶段02 v1.4完整提示词；阶段01不重做，未授权生产操作不执行。
