# Extension Repair Sync 2.0.5 实施记录

日期：2026-09-12（Asia/Shanghai）  
分支：`codex/audit-v1.3`  
变更前基线：`c540489`  
App / Extension：`2.0.5`  
数据库 Schema：`59`（未变）  
Content Strategy：`3.0`（未变）

## 根因与修复

- 旧版 `recoverSession()` 把普通 MV3 worker 重启转换为 `paused_recovered`，恢复仅改变状态而没有可靠唤醒任务。现在运行中 Session 的 in-flight Task 会失效旧 lease 并安全回到 queued；Session 保持 running，模块初始化、`onStartup` 和 alarm watchdog 都会自动 `drive()`。
- 旧版把 `NAVIGATION_INTERRUPTED` 当成验证并把全局并发降到 1。现在只有 `NOT_LOGGED_IN`、真实 `VERIFICATION_REQUIRED`、`CAPTURE_UNAUTHORIZED` 和用户主动 Pause 会暂停 Session；导航中断、加载超时、内容未就绪、Note 不可用、单媒体失败、CMS 5xx 和 worker tab 关闭只影响当前 Task。
- 旧版 SAVE_SETTINGS 只写全局配置。现在运行中 Session 的 config 会原位更新，固定或自定义并发立即生效；Auto 会按新上限 clamp，并按需要增加或停止 worker slots，不创建新 Session。
- 旧版一次取 N 项并等待整批完成，慢 Note 会形成 batch barrier。现在每个稳定 worker slot 都通过原子 lease 持续领取下一项 ready Task，一个 Note 变慢不会阻塞空闲 slot。
- 旧版同一 Note 的媒体串行，跨 Note 也没有统一资源边界。现在所有 Note 共用全局媒体 semaphore：默认 12 条下载流水线、6 条上传流水线、96 MiB 加权内存预算，以及最多 2 条大媒体流水线。
- CMS identity/repair manifest 会返回缺失 original 的精确 `mediaIdentity`。Extension 对已有 Source 只处理这些缺失项，不打开仅需 Server Direct Recovery 的 Source，也不重复处理已经 `ORIGINAL_STORED` 的媒体。
- Auto 并发以最近 24 个 Task 的 rolling metrics 决策。429、真实验证风险、CMS backpressure、内存压力、连续 tab crash、持续系统性失败或超时会降并发；单图片 403/404、`NOTE_UNAVAILABLE` 和偶发局部失败不会降低全局并发，也不再要求 Note P95 小于 12 秒。
- 队列处理完但仍有永久失败时使用 `completed_with_failures`，成功项不会显示为暂停；Popup 提供“仅重试失败项”。
- 页面等待以 MutationObserver 为优先，并保留有界 timeout 兜底。关闭 Popup、切换标签页或切换程序不会停止后台队列。

## 并发和资源边界

- Note：conservative 2、balanced 4、aggressive 8、custom 1–16。
- Auto：默认上限 12、最大 16；初始值按设备能力在 4–8 内选择。
- Media：默认 12、范围 1–16；upload 默认 6；大媒体同时最多 2；默认加权内存预算 96 MiB。
- Task lease 默认 3 分钟；watchdog 无进展阈值默认 2 分钟；每项媒体完成和每个上传 chunk 都会续租。
- Retry：指数退避加 ±20% jitter，默认 5 秒起步、最长 2 分钟、最多 3 次；429 同时尊重 `Retry-After`。

## 固定 Fixture Benchmark

命令：`npm run benchmark:extension-repair`。这是确定性的近真实调度模型，不冒充登录态下的真实 Chrome 端到端测试。旧模型使用长期卡住的 2-wide batch 加 Note 内媒体串行；新模型使用 8 个持续 Note workers 加 12 条全局媒体流水线。

| Fixture | 旧 Notes/min | 新 Notes/min | 旧 Media/min | 新 Media/min | 旧总时间 | 新总时间 | 加速 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 30 Notes × 10 images | 4.78 | 38.17 | 47.83 | 381.72 | 376.302s | 47.155s | 7.98× |
| 30 Notes × 20–30 images | 2.33 | 16.59 | 57.28 | 408.05 | 773.096s | 108.515s | 7.12× |
| 少图 / 多图 / 视频混合 | 3.21 | 26.48 | 39.59 | 326.61 | 560.799s | 67.971s | 8.25× |

30 × 20–30 fixture 的旧/新平均有效 Note 并发为 1.90/7.11，worker utilization 为 0.95/0.89，media utilization 为 0.81/0.96，Note P50/P95 从 49.289s/60.044s 降为 27.766s/31.383s。fixture 没有注入失败，所以 retry、timeout、rate-limit 和 verification occurrence 都为 0。新调度近似 peak media memory 为 48 MiB，低于默认 96 MiB 预算。

## 自动化验证

- Live Settings：running custom 2 保存为 custom 8 后，Session ID 不变，config 和 effective concurrency 都变为 8。
- MV3 restart：保留已完成 Task，旧 in-flight lease 自动 requeue，Session 自动 running，后台 drive 会重建 worker tab；不依赖 Popup Resume。
- Error isolation：导航中断、tab load timeout、content not ready、CMS 5xx、worker tab closed 为 retry；Note unavailable 与不可重试的单媒体错误成为 Task permanent failure；只有登录、真实验证、Capture 授权和用户 Pause 会暂停 Session。
- Continuous pool：慢 Note 未结束时，其他 slot 可继续领取后续 Task。
- Media semaphore：并发 fixture 全部完成，active 不超过设置值。
- Repair correctness：server-only recovery 不进入浏览器队列；browser repair Task 只携带缺失 originals；修复后 manifest 的 missing originals 为空。

最终门禁：`npm run check` 通过；`npm test` 为 1227/1227 通过；`npm run release:check` 为 50 项强制检查通过、0 失败。真实小红书人工验收仍需用户 Chrome Profile 安装 2.0.5 Extension 后执行；离线测试不伪称验证了验证码、真实 CDN 波动或 Chrome 内存压力场景。

## 用户工作流

保持 Chrome 已登录小红书，打开目标收藏夹，点击一次“修复缺失数据”，随后可关闭 Popup 或切换标签页/程序。后台会继续处理全部可修复 Source；只有登录失效、真实验证码/安全验证或 Capture Token 无效时才需要用户回来处理。
