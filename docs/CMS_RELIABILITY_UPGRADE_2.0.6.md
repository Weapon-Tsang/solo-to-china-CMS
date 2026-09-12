# 2.0.6 本地升级与交接

这是升级说明，不代表已部署。当前实现：App/Extension 2.0.6、Content Production Strategy 3.1、schema 65。起点是 `2395fe4ed68f7414d777d0156770af76e858eb1b`，本次开始时工作区干净。原始素材、生产数据库及 WordPress 未执行写入。

## 升级顺序

1. 在维护窗口暂停生产入口及 Worker，按现有 `npm run backup` / `npm run backup:verify` 流程备份数据库与内容文件，并记录旧代码、配置和镜像。不能仅复制一个正在写入的 SQLite 主文件而遗漏 WAL。备份还应保留上传临时目录，以便恢复旧分块任务；默认备份是否包含该目录需按部署配置检查。
2. 先在备份的隔离副本上使用 Node 24+，运行 `npm ci --ignore-scripts` 和 `npm run release:check`。保留当前固定 Frontend commit `f44ce1092ced93dfb47d9b3eae83d0d5e4b97086`；不修改另一个前端仓库，不换浮动分支。真实模型和 WordPress 凭据不要注入离线验收服务器。
3. 上线后端时首次 `openDatabase()` 自动应用迁移：60 添加 `jobs.dirty_revision/claimed_revision`；61 添加 `production_attempt_archives`；62 添加 `writing_packets.context_json`；63 添加 `narrative_plans.evidence_selections_json`；64 增加媒体/文件的采集版本并重建资产、文件、分段表的唯一约束，保留全部行、ID 和外键；65 添加 `pipeline_step_receipts`。这些迁移不排全库处理、不修改文章。迁移 64 在一个事务中复制并替换表，需要为表副本与 WAL 预留磁盘空间；升级前在生产备份副本测时间和空间，不能只按空库时间安排窗口。已验证 schema 59 升级，以及在 schema 64 提交前杀死真实进程后仍完整保留 schema 63、重新打开完成升级与外键/完整性检查。
4. 后端先升级，确认 `/api/health` 的版本及 `captureMediaProtocol.version=2`，再更新扩展。v1 create/chunk/complete 继续可用；新扩展收到旧服务器无 v2 能力的返回时使用旧分块流程，不能得到 v2 续传保证。生产发布步骤仍需独立执行，本次未执行。
5. 真实浏览器验证一篇普通图文、一篇带视频的用户选定素材；在上传中间重启 Worker、模拟丢失 complete 响应，并检查 Source 原件、capture_versions、断点与请求字节。保持原来的站点登录/验证要求。当前自动化使用受控 DOM 和 fake-indexeddb，不能替代 Chrome 扩展存储及标签页生命周期实测。
6. 保持 `SOURCE_COMPLEXITY_ROUTING=false`。检查旧已提交 Batch 继续以提交时的配置接收结果，交互任务进入 realtime，视觉压力不阻断文字。启用轻量来源路径、启动历史回填或任何生产重跑前，先检查精确范围及成本；本次没有运行这些生产动作。

## 媒体协议、缓存与恢复

- v2 create 声明 kind/MIME/长度/SHA-256。服务端返回 uploadId、uploadToken 和分块大小，或者已验证原件回执。分块与状态/complete 带 `X-Upload-Token`，且仍需 Capture 认证。日志和文档不得记录这些凭据。
- `GET /api/capture-media-uploads/:id` 返回缺块判断所需的 receivedChunks 或最终 receipt；重复块必须字节一致，重复 complete 返回同一 receipt。服务端重启不丢回执。仅 filename/storageRef 不构成可信证据。
- `.verified/` 是服务端校验记录，不是用户可写的导入目录。文件 stat 与记录一致时可走快速验证；文件变化、哈希不符或穿过符号链接/Windows junction 均不能作为已验证引用。原件目录应只有服务端拥有写权限。
- 浏览器 IndexedDB 的媒体和 capture manifest 暂存预算为 256 MiB，不自动驱逐未完成原件；Capture 完整被确认后释放该次暂存。默认 96 MiB 的二进制缓冲预算支持最多 24 MiB 单视频、20 MiB 单图（更大预算下视频绝对上限 32 MiB）。预算覆盖下载缓冲及合并副本，不是整个 Chrome 进程或图片解码峰值的保证。大于上限的媒体保留为缺口；后端的默认 512 MiB 上限不代表浏览器也支持该大小。
- 普通原图上传后不再随 Capture JSON 传相同 base64。大图可生成浏览器 WebP 衍生图，并按原件哈希、转换参数和转换器版本复用独立的 64 MiB IndexedDB 缓存。缓存容量不足仅淘汰可重新生成的衍生图，不清理未完成原件。
- 未完成上传会话保留 30 天，过期返回 MEDIA_UPLOAD_EXPIRED；客户端仍保留自己的原始字节，可创建新会话。`CaptureMediaUploadManager.cleanupExpired()` 默认只预览，支持排除活跃 uploadIds；显式 `dryRun:false` 也只移除过期且无回执的临时目录。已完成回执和原始文件永不由该方法删除。本次只在临时测试目录执行清理测试；未接入生产定时清理。

## 旧数据与产物

旧 Capture 的缺省完整性继续兼容，但标为 legacy_unverified；不会伪装成新协议验证。未完整的新采集尝试另存，已有完整且原件齐全的版本继续有效。完整重采生成新的资产/文件/分段版本，旧文章图片外键和旧证据位置保留；列表、覆盖审核和媒体修复只读当前版本。冻结 Packet 按精确资产 ID 继续使用获授权的历史图片，仍检查当前授权与耐久化状态。

迁移只将现存旧资产/文件归属到当时来源的有效采集版本，不推测此前已被旧代码删除的资产关系。`GET /api/sources/:id/versions/:version` 提供历史正文、保留的资产/文件/分段与图片预览；`assetLinkage=snapshot_only` 表示没有保留的资产行（也可能该版本本来无媒体），不能把快照计数当作原件已找到。原始 capture_versions 快照仍保留；不存在的版本返回 404。

旧 Writing Packet 的 context 为 `{}`，Narrative 的证据选择为 `[]`，保留旧路径。只在明确运行该文章的 Narrative/Packet 阶段时生成新快照。已有知识证据缺少 claim_id 时，Packet 尝试按来源、规范键、值和引文精确补引用；不能对应时给出 WRITING_PACKET_EVIDENCE_UNRESOLVED，不伪造关联。新证据哈希不再依赖 updated_at；旧审核哈希可能不匹配，须针对该文章重新审核，不全库重写草稿。

新 artifact 输入契约使旧缓存自然失效；失效本身不排全库作业。缓存命中仍检查当前输出哈希并补必要的下游任务。分段、补提取及审核、来源汇总、页面编排、商业编排、发布包和 WordPress 回执补齐短事务边界；无效页面保留诊断，不能把 job 标为成功。商业/交付阶段记录实际正文、审核、选定事实、媒体、商业/页面版本和配置，在异步返回时拒绝过期输入；这些阶段不直接复用 succeeded 来跳过外部投递核验。

实体解析每页和定向补提取的每次模型返回先写 `pipeline_step_receipts`，按阶段输入、步骤、实际配置及输出 hash 校验复用，最后事务提交业务结果及下游任务。覆盖审核失败时，旧提取结果继续有效；重试仅调用未完成的审核。普通 model stage 仍使用已有完整阶段 artifact；本次没有给每个单次模型调用都增加返回回执。真实进程终止已覆盖实体第 1/2 页落盘、业务写入与 enqueue 之间、迁移提交之前。回执也包含研究派生内容，应随数据库备份保留；不保存请求头或完整输入提示词。

模型提供方和 SQLite 不共享事务；在模型返回尚未落盘时断电仍可能再次收费。WordPress 延续已有 draft-only 幂等标识、文章关联及防覆盖协议；外部已接收但本地尚未记账时继续按已有协议核对，不宣称网络与数据库原子提交。

## 回退

暂停新写入，保留当前数据库、原件、回执及浏览器暂存，再恢复升级前匹配的数据库与文件快照以及对应代码/镜像。不要直接把 schema 65 标记改回 59，不要删新增列来冒充回退，也不要仅退旧容器后继续写新数据库：旧代码不知道版本视图，会错误读取多代资产，并可能按旧策略清理生产产物。

恢复旧后端会保留旧扩展协议；新扩展的未完成 v2 会话无法在旧端继续 status 查询，应先保留暂存并恢复匹配的服务端版本，或在确认回退后从同一暂存重新创建兼容上传。不要为回退删除原件或清空 IndexedDB。

所有真实测试、性能样本及残留工作见 [实施审计](audit/CMS_PIPELINE_RELIABILITY_2026-09-12.md)。
