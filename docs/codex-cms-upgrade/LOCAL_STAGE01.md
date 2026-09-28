# 阶段 01 本地运行说明（开发中）

本说明只覆盖已实现的本地入口。阶段 01 尚未验收，不能据此迁移或停用旧主机。所有 `CMS_DATA_ROOT` 都须为源码 checkout 之外的本地非同步目录；SQLite 不支持本项目在共享盘、已知云同步目录上多机并发运行。

## 隔离开发

设置 `CMS_RUN_MODE=development` 与 `CMS_DATA_ROOT=<全新外置数据目录>`，再执行 `npm run dev:server`。首次创建 `.cms-data-root.json` development 标记。已有但无标记的数据库不会被 development 接管；标记为 migration-review 或 local-production 的目录也会被拒绝。`npm run local:status` 可查看数据根身份、运行角色、应用/schema 版本和租约，输出不含凭证。

## 稳定 release

在源码目录构建 `npm run build`，设置 `CMS_RELEASE_ROOT=<独立 release 目录>`、`CMS_DATA_ROOT=<外置数据目录>` 后运行 `npm run local:prepare`。该步骤复制有限清单并安装 production 依赖，不复制 `.env` 或业务数据；它要求已有数据库，并将明确采用的无标记数据根标记为 local-production。随后从 release 目录以 `CMS_RUN_MODE=local-production`、`NODE_ENV=production` 运行 `npm run local:stable`。API 与 Worker 分开设置 `CMS_PROCESS_ROLE=api` / `worker`；同一数据根允许一对 API/Worker，拒绝重复角色和混合实例。稳定启动不再执行 `prestart` 重建。

`npm run local:stop -- api`、`-- worker` 或 `-- all` 向该数据根的活跃租约写入绑定随机 nonce 的退出请求，等待优雅关闭；重复请求和已停止状态幂等。它不按端口或 PID 杀进程。`npm run local:logs -- api` 读取本地 JSONL 日志末尾；`npm run local:status` 列出租约。只有确认 PID 不存活后才可用 `npm run local:unlock -- api|worker|all` 清除残留租约。

## 快照、只读恢复与提升

设置外置 `CMS_DATA_ROOT` 后，`npm run backup` 生成 SQLite `VACUUM INTO` 快照、文件和 v3 SHA-256 manifest；清单包含明确存储列、历史采集 JSON 文件引用及关键业务行指纹。`npm run backup:verify -- <snapshot>` 验证，`npm run backup:drill -- <snapshot>` 做离线演练。旧 v2 快照仍可读取，但不具备新业务指纹与历史 JSON 文件引用保证。快照可能包含加密的模型凭证，必须作为敏感业务备份保管，单独保存主密钥。

`node src/backup.mjs --restore <snapshot> <全新外置目标目录>` 只恢复到不存在的新目录；复制前检查可用空间，旧 schema 只在新目录副本迁移。若复制中断，目标仍不存在，`<目标>.incomplete` 保留快照身份和现场；检查后使用 `node src/backup.mjs --restore-resume <同一 snapshot> <同一目标>` 续恢复，损坏的暂存文件会从已验证快照重新复制，不接受另一快照。恢复后的目录标记为 `migration-review`，不会启动 API/Worker。恢复会映射明确存储列和仍在快照中的来源文件清理队列，丢弃已不存在的旧机器清理路径；返回映射/丢弃数量。设置 `CMS_RUN_MODE=migration-review` 与目标 `CMS_DATA_ROOT` 后运行 `npm run local:inspect`，只读检查 integrity、外键、schema、queued/running Job、未决 Vertex Batch 和 WordPress/媒体投递。报告中 `reconciliationRequired` 非空时不得提升。

只有实际确认旧主机写入和调度已停用、远端不确定结果已逐项按 ID 对账之后，才运行 `npm run local:promote -- --old-host-stopped`。该命令会重查 DB 完整性和未决状态并标记 local-production，但无法自行证明远端旧主机确已停用。真实云端 Batch 对账、按阶段断点续跑与多设备访问尚未完成；请见 [`acceptance/phase-01.md`](acceptance/phase-01.md)。

## 性能基准复现

`node scripts/benchmark-local-stage01.mjs --browser-hold --output <本地报告路径>` 建立一次性合成数据集并打印 loopback URL 与 `stopFile` 路径。用 Playwright CLI 打开该 URL 后，运行 `playwright-cli run-code --filename scripts/benchmark-local-stage01-browser.js --raw`，保存返回的 JSON；浏览器脚本对来源、知识库、内容菜单分别采集冷/热各 30 次数据可见时间。完成后向打印的 `stopFile` 写入任意内容，基准进程继续采集 30 次各路 API 样本并清理自己创建的临时数据。`--worker-load` 可添加 CMS Worker 进程和合成只读/CPU 并发负载；该负载没有真实待执行 Job。

## 当前验证边界

Google 本地认证使用 ADC；GCE metadata 分支保留并有 mock 测试，真实权限未验证。错误的模型主密钥会阻断本地生产 Worker，API 仍可用于恢复录入。交付独立性只由本地 HTTP 接收器证明，真实 WordPress/PHP 未测。已获准本地数据库副本完成 schema 80 迁移、修复副本异路径恢复及 12 个恢复 Job 的本地 mock Worker 回放；七个真实来源停在人工 review。真实 Worker 执行业务同时承载 API 的性能、浏览器私有代理/扩展完整流程和完整下游恢复仍未验收。详见 [定向收尾](acceptance/phase-01-closeout.md)。

浏览器扩展如果跨源调用 CMS，需把**具体扩展 Origin**（例如 `chrome-extension://<固定 ID>`）列入 `CAPTURE_ALLOWED_ORIGINS`，多个值以逗号分隔。默认不接受任意扩展来源；同源后台页面可直接访问。CORS 白名单不能代替 `CAPTURE_TOKEN`、登录或私有代理的访问控制。
