# 阶段 01 本地验证记录

执行环境：Windows x64，Node v24.14.0、npm 11.9.0；所有数据为临时目录中的合成 fixture。代码只在 CMS 仓库修改，未提交、推送或部署。未连接生产数据库、真实付费 Provider 或正式 WordPress。

## 代码与回归

| 验证 | 结果 | 覆盖 |
|---|---|---|
| `npm run check` | PASS | Vite build、受检 Node 文件语法、服务边界；最新本地运行/恢复补丁之后执行。 |
| `node --test test/local-runtime.test.mjs` | 12/12 PASS | 数据根身份、迁移只读、运行中 Job 阻断提升、主密钥门禁、API/Worker 租约、重复停止、端口冲突和本地日志。 |
| `node --test test/backup.test.mjs` | 23/23 PASS | WAL 快照、多类文件、数据库与媒体指纹交叉检查、恢复演练与直接恢复在启用目标前检查 JPEG/PNG/GIF/WebP/PDF 文件头与声明 MIME 并拒绝不匹配、v3 业务行指纹及缺项/篡改/非法定义拒绝、数据库状态改变且文件哈希重算仍拒绝、未晋升视觉候选、历史采集 JSON 路径异目录重映射及缺文件拒绝、v2 清单兼容、POSIX 路径在 Windows 恢复 fixture、空间不足预检、复制中断与同快照续恢复、schema 新旧、旧清理队列重映射、符号链接和 lease。 |
| `node --test test/capture.test.mjs` | 11/11 PASS | 删除来源的文件清理检查仍引用同一路径的视觉候选，避免误删候选文件；采集模块回归通过。 |
| `node --test test/capture-upload.test.mjs` | 4/4 PASS | 普通采集分块原子提交、相同字节重试、不同字节冲突；快照定向测试确认未提交 `.tmp` 分块不进入归档。 |
| `node --test --test-name-pattern="CORS accepts" test/server.test.mjs` | 1/1 PASS | 同源、精确扩展 Origin、未知 Origin 预检和写请求拒绝。 |
| `node --test test/server.test.mjs` | 16/16 PASS | 完整 server 模块回归，包含 CORS、登录、采集、后台认证、capture-only Host。 |
| `node --test test/ui-request-coordinator.test.mjs test/reliability-ui-migration.test.mjs` | 10/10 PASS | 迟到请求丢弃、切视图取消、隐藏页轮询退避及返回刷新。 |
| `node --test test/maintenance.test.mjs` | 1/1 PASS | 定时备份、协调与状态记录的模块回归。 |
| `node --test test/model-stage-policy.test.mjs test/repair-v11.test.mjs` | 41/41 PASS | 模型尝试计量、未知费用保持 null、确定性失败与旧 Provider 429 分离。 |
| `node --test --test-name-pattern="visual call evidence|transform error never|QA response|QA.*429" test/visuals.test.mjs` | 3/3 PASS | 本地拒绝、Provider 400/403/429/503、未知传输和图片生成失败回执。 |
| `node --test --test-name-pattern="deterministic editorial-card overflow|429 model call" test/production-state-hotfix.test.mjs` | 1/1 PASS | 确定性卡片溢出不继承先前 429。 |
| `node scripts/verify-local-release-isolation.mjs` | PASS | 临时源码副本移走后稳定 API health 200；准备新版 release 时旧 API 可用，新版代码和原数据根身份均正确，优雅停止。原始结构化结果见 [`release-isolation.json`](release-isolation.json)。 |
| `node --test test/backup.test.mjs test/google-access-token.test.mjs test/model-routing-v11.test.mjs test/local-delivery-receiver.test.mjs test/exceptions.test.mjs` | 39/39 PASS（后续备份补丁又单独验证 13/13） | 认证 mock、密钥、独立 HTTP 接收器、异常归类/恢复。 |
| `git diff --check` | PASS | 已追踪文件空白差异。 |

## 独立 release 与交付

- 早期临时隔离 release `C:\Users\Mloong\AppData\Local\Temp\cms-release-v14b-4d406755698d4809b7147cc368f7e5dc`：`npm run local:prepare`、release 内 `npm run local:status`、local-production API `/api/health` 和 `npm run local:logs -- api` 均 PASS。最新代码已再次运行 `node scripts/verify-local-release-isolation.mjs`，结果 PASS：源码移走后 API health 200、新版准备期间旧 API 可用、切换后数据根身份不变，详见 [`release-isolation.json`](release-isolation.json)。
- `test/local-delivery-receiver.test.mjs` 以独立 HTTP 接收器保存 draft JSON 与图片字节。关闭 CMS 并删除本地图片后，接收器仍可返回两者；JSON 不含 CMS 数据路径。这证明本地 mock 交付独立性，真实 WordPress/PHP `NOT TESTED`。
- `migration-review` 使用只读 SQLite 打开含 queued/running Job 的 fixture，输出交接计数，检查前后 DB SHA-256 相同；提升时拒绝 running/未知外部投递状态。旧主机是否真正停用目前仍依赖操作者声明。

## 浏览器与性能

- 本地真实浏览器：45 条合成来源，登录后翻到第 2 页，切至 Knowledge 再返回时页码保留；改每页 20→50 后显示 45 条和第 1 页。截图：[`browser-sources-50.png`](browser-sources-50.png)。未验证所有菜单、迟到请求、移动设备、私有代理或 Worker 负载。
- [`performance-idle-v5.json`](performance-idle-v5.json)：1000 来源、10000 claims、300 drafts、3000 媒体元数据、1000 Knowledge facts、50 真实故障形态的合成 failed jobs；每路预热 1 次、有效样本 30 次，Windows 本机 loopback、Worker idle。P95：来源 5.231 ms，Knowledge 9.008 ms，内容 9.128 ms，异常 5.996 ms，Dashboard summary 1.928 ms。异常响应约 9995 bytes、每请求 12 条 SQL，早期 v3 为 110 条 SQL。原始样本、机器资源、event loop 延迟和部分 `EXPLAIN QUERY PLAN` 在 JSON 中。异常列表仍在 JS 汇总/分页，这些数字不能外推到真实数据和有负载生产机。
- 同代码/同合成数据的 [`performance-idle-v6.json`](performance-idle-v6.json) 和 [`performance-loaded-v6.json`](performance-loaded-v6.json)：各接口各 30 次，nearest-rank P95。idle/loaded 分别为：来源 4.081/4.650 ms，Knowledge 8.278/8.772 ms，内容 8.449/8.461 ms，异常 5.365/7.577 ms，Dashboard summary 1.889/7.203 ms。loaded 期间真实 CMS Worker 进程已启动但无待执行 Job，另一个独立进程完成 83,800 次只读 SQLite 查询和 1,676 轮 CPU 计算；这是**合成并发负载**，不能冒充真实生产 Worker 任务压力。原始样本、SQL 次数和资源条件在两个 JSON 中。
- Chrome 147、同一 1000 来源/10k claims/300 drafts/3000 media 的本地合成数据集：[`performance-browser-v1.json`](performance-browser-v1.json) 为 idle，[`performance-browser-loaded-v1.json`](performance-browser-loaded-v1.json) 为 CMS Worker 进程加合成只读/CPU 并发负载。来源、知识库、内容各冷/热 30 次，均等待对应页面实际数据可见。冷态每次创建新浏览器上下文和页面；热态在同一页面由另一菜单返回。nearest-rank P95（ms）idle/loaded：来源冷 270/285、热 88/67；知识库冷 344/351、热 62/54；内容冷 404/364、热 80/68。计时精度 1 ms，P50 和全部样本在 JSON 中；复现脚本为 `scripts/benchmark-local-stage01-browser.js`，同条件 API 基准见 [`performance-idle-v8.json`](performance-idle-v8.json) 与 [`performance-loaded-v7.json`](performance-loaded-v7.json)。样本波动不能解释为负载加速；Worker 无待执行 Job，负载由独立进程生成。
- 真实 Worker 执行业务任务时的冷/热菜单、内存/CPU 全资源基准、失焦轮询与慢模型健康的浏览器 E2E 均 `NOT TESTED`。

## 必需但未验证的层级

| 层级 | 状态 | 原因 |
|---|---|---|
| L1 Targeted Tests | PASS | 上述定向本地测试。 |
| L2 Module Regression | PASS | 相关备份、运行时、异常、模型凭证和交付测试。 |
| L3 Production DB Replay | NOT TESTED | 没有获得只读生产数据副本；未对生产 DB 读写。 |
| L4 Browser E2E | PARTIAL | 来源页分页 smoke；完整交接和多设备流程未做。 |
| L5 Real Provider Canary | NOT TESTED | 未发起付费 Google/其他 Provider 请求。 |
| L6 Full Production Replay | NOT TESTED | 未进入正式发布或生产式全链路。 |
| Post-Fix Exploratory Audit | ISSUES FOUND | 发现并修复历史采集 JSON 路径未随恢复重映射，以及来源清理漏查视觉候选引用；异常全量 JS 分页、未知远端状态、全部媒体写入与快照协调仍未完成。 |

未知依赖及真实资源账单都不能由本地 fixture 推断。验收结果见 [`../../acceptance/phase-01.md`](../../acceptance/phase-01.md)。

### 2026-09-24 媒体快照与恢复补充回归

- `node --test test/backup.test.mjs`：23/23 PASS。恢复演练及直接恢复启用目标目录前检查已知媒体 MIME 文件头；声明与字节不一致时拒绝。快照跳过所有 `.tmp` 文件、来源媒体的未完成 `.part` 和 `.media-recovery`，保留旧视频上传已提交的 `.staging/*.part`。
- `node --test test/atomic-media-file.test.mjs test/chunked-upload.test.mjs`：2/2 PASS。手动上传、来源媒体和视觉输出使用完整写入后原子发布；旧视频上传分块相同字节重试可接受，冲突字节拒绝。
- `node --test test/atomic-media-file.test.mjs test/manual-source.test.mjs test/visuals.test.mjs test/reliability-media.test.mjs test/backup.test.mjs`：62/62 PASS。
- `node --test test/capture-upload.test.mjs test/capture.test.mjs test/reliability-capture-versions.test.mjs`：18/18 PASS。
- 范围仍是本地合成数据；未验证真实 Worker 业务负载、历史数据库和所有媒体清理者的跨进程并发。
