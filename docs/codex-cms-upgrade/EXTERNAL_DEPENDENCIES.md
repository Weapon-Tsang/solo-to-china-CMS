# 外部依赖台账 · 阶段 01

## 2026-09-27 只读实测

公开站点 `https://www.solotochina.com` 的 WordPress REST 文章与媒体 GET 均返回 200。采样 10 个媒体对象观察到 `stc-guide-card-2x` 及 WordPress 常见尺寸；一篇已发布文章的 HTML 返回 200，存在 canonical、description、Open Graph title/image 和 JSON-LD，4 张图片中 3 张有 srcset/sizes/alt。robots.txt 与 wp-sitemap.xml 返回 200。证据见 [`evidence/phase-01/public-runtime-audit.json`](evidence/phase-01/public-runtime-audit.json)。这只证明所采样公开输出；PHP 运行版本、私有前端合同版本、认证写入兼容性、每种 cover/body/social 用途及全站媒体行为仍为 `NOT TESTED`。未修改外部系统。

同日 gcloud 只读资源盘点：当前项目共有 5 台 RUNNING VM、3 个 Cloud Storage bucket、2 个 Artifact Registry 仓库、0 个 Cloud Build trigger；`solo-to-china-engine` VM 为 RUNNING。项目绑定了启用的计费账号，但未读取账单用量或费用，也未把其他 4 台 VM 自动归属 CMS 或判定可停用。现有生产 v2 快照来自 CMS VM 已有备份，未新建云快照或备份。证据见 [`evidence/phase-01/cloud-readonly-audit.json`](evidence/phase-01/cloud-readonly-audit.json)。

历史记录（2026-09-24，Asia/Shanghai）：当时没有读取或修改独立公开前端仓库，没有访问真实 WordPress、云资源或账单。下列旧状态均为 `UNVERIFIED`，请结合上方 2026-09-27 只读实测理解。

| ID | 关联 | 待核实能力 | 安全回退 / 阻断 |
|---|---|---|---|
| EXT-SIZES | LOC-016 | WordPress 实际响应式子尺寸 | 保持已支持的媒体交付，不伪造尺寸 |
| EXT-CARD | LOC-016 | 独立卡片 title/deck 接收与渲染 | CMS 内部保存；不得覆盖正式 title/excerpt |
| EXT-PURPOSE | LOC-016 | cover/body/social 用途分离 | 新用途交付须门控，不强塞正文 |
| EXT-REFRESH | LOC-015/016 | 封面局部更新及 revision 回执 | 不执行无保护整篇覆盖 |
| EXT-SEO-HEAD | LOC-016 | 公开 head/robots/sitemap | CMS 只验证合法 payload，外部输出待验 |
| EXT-IMG-LOAD | LOC-016 | 公开图片 srcset/sizes/首屏优先级 | 不改公开站 CSS/PHP |
| EXT-CONTENT-RENDER | LOC-016 | 初始 HTML、来源和图文对应 | 既有组件范围内交付；外部结果待验 |
| EXT-PUBLIC-RUNTIME | LOC-016/017 | 公开工具是否依赖 CMS 在线 | 不据此宣称可以停云 |

固定合同制品、checksum、实际接收版本与真实响应：`unknown / NOT TESTED`。复验需固定发布制品和受控 WordPress 测试接收端；本轮没有相关证据。

## 资源与成本矩阵

| 资源 | 当前判断 | 依据 |
|---|---|---|
| WordPress 计算、DB、公开媒体、DNS/CDN | 保留 | 公开交付依赖，未做在线检测 |
| 模型项目/计费、视频与 Batch 桶 | 待核 | 本轮未访问真实云资源 |
| CMS 云端进程 | 待核 | 未完成真实迁移或公共运行依赖验证 |
| 共用 VM、磁盘、IP、快照、制品 | 待核 | 无资源清单/账单，不估算节省额 |
| R2 | 本轮不启用 | 阶段规格暂缓 |

当前节省金额：`unknown`。可在取得账单后按“被确认停用资源的实际月费用减去本地新增成本”计算；不能把云端进程停止等同于整台 VM 停止。


## 2026-09-27 阶段 02 A1 检查点

- `EXT-PHASE02-PROVIDER`: NOT TESTED / NOT AUTHORIZED。本轮仅 mock 验证统一图文请求；没有新付费调用。真实 schema 接受、生成语义、token/延迟仍未知，不能用阶段 01 的短文本 canary 替代。
- `EXT-PHASE02-WP`: NOT TESTED。没有真实 WordPress 写入、媒体更新或 PHP 能力验证；正文补图的 `EXT-BODY-MEDIA-REFRESH` 能力仍需后续核对，不能假定已有封面刷新等于正文刷新。
- `EXT-PHASE02-CONTRACT`: 阶段 02 完整合同制品/接收端兼容性尚未验收；本轮没有修改前端仓库，没有上传未支持字段。
- `EXT-PHASE02-RELEASE`: NOT AUTHORIZED / NOT READY。schema 81 只在本地测试与一次性数据库上迁移；未来生产 schema 升级需要 DATA_MIGRATION_RELEASE。部署脚本只更新兼容性断言，未执行。
- `LOCAL-PHASE02-REPLAY`: 已复用阶段 01 保存的历史数据库快照，不是最新生产状态。经本地写入批准，在 D: 新建三次隔离重放目录；最终 `D:\cms-phase02-media-replay-pPPWln`。C: 空间不足，不应默认再次生成大型副本。数据库留在仓库外。
- 本轮停止原因为上下文检查点，绝大多数剩余本地开发工作已经在阶段 02 范围内；不是要求用户逐项重新授权本地工作。继续使用完整 TXT，不跳到下一阶段。


## 2026-09-27 Phase 02 A1 context-readback continuation

- No external dependency status was upgraded. Real Provider, fixed real PHP/WordPress and deployed receiver compatibility remain NOT TESTED; no fresh production read or paid call was made.
- No external contract/schema was changed. The new context endpoint is CMS-admin-only. Source viewing does not implement manual article upload or authorize delivery.
- Local historical replay: retained disposable directory D:/cms-phase02-media-replay-xiKzH1. Final dry-run compares 627 binding rows without differences; original and baseline hashes were preserved. Database files remain outside Git.
- Binding policy is now source-media-binding-2. Earlier evidence is retained; stale policy/context cannot silently satisfy a new publication gate. Historical repair remains scoped and requires its proper local/production boundary.
- Overall phase 02 stops at a context checkpoint, not a request for new local-development permission. Remaining CMS scope and exact external boundaries: [continuation checkpoint](evidence/phase-02/a1-readback-checkpoint.md).
