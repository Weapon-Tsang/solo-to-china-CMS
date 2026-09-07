# SoloToChina 全量修复进度

更新时间：2026-09-08

本文记录 `docs/audit/handoff/01_问题清单.txt` 与 `02_完整修复提示词.txt` 对应问题的实施、验证和部署状态。附件中的提示词作为审计输入；实际变更以当前代码、测试和发布检查为准。

## 当前结论

- A01–A19、B01–B10 的仓库内修复均已完成。
- CMS 已升级到 `1.15.0`，数据库迁移链为 1–31，内容生产策略升级到 `1.5`。
- 前端 Parent Theme 已升级到 `0.28.0`；Component Registry 保持兼容版本 `1.1.0`，Content Contract 保持 `2.1.0`。
- 两仓库真实契约门禁、CMS 全量测试/构建/release check、WordPress Playground PHP 8.3 运行验证和前端发布打包均已通过。
- 提交、推送和生产部署正在执行；最终 commit、镜像、线上健康检查与回滚点将在本文件末尾补记。

## 问题状态

| 编号 | 状态 | 修复与验证证据 |
| --- | --- | --- |
| A01 | 已完成 | 修正 PowerShell JSON 数字、数组和嵌套结构序列化；生成物执行递归一致性校验，并用真实前端工件通过跨仓库门禁。 |
| A02 | 已完成 | Vertex 优先使用完整 `responseJsonSchema`，保留无损 OpenAPI fallback；Vertex/Kimi 均对原始返回执行本地 Schema 校验和一次纠正。 |
| A03 | 已完成 | Opportunity 只使用标题/主题实体范围内的 Claim 与 `selectedFactKeys`，无关来源不能抬高 readiness。 |
| A04 | 已完成 | 多模态覆盖审计记录计划模态、实际模态、资产 ID、缺失图片/视频和 coverage gap。 |
| A05 | 已完成 | QA 输入包含最终 Page Payload；商业合并后执行最终页面硬门禁，检查非空页面、标题、Evidence Ledger 与获批商业资产。 |
| A06 | 已完成 | Draft、QA、Page、Commercial、Publish 均绑定精确 revision/content hash/evidence hash；草稿变化会使下游失效并阻止旧产物发布。 |
| A07 | 已完成 | 必需事实型图片缺失时阻断；地图/信息图在真实 renderer 产出前保持 incomplete；可选插画才允许明确降级。 |
| A08 | 已完成 | 图片生成和 WordPress 上传按单项持久化进度；slot+fingerprint 保留未变资产；瞬时失败退避重试，已成功项不重复处理。 |
| A09 | 已完成 | 区分 published/observed/verified/effective 时间；生产 Claim 要求可定位原文 offset 或视觉证据，伪引用不能进入 Knowledge。 |
| A10 | 已完成 | 真实照片必须与目标实体/主题达到语义阈值并关联授权来源；不再默认取第一张图，alt/caption 使用实际匹配资产。 |
| A11 | 已完成 | PHP 以 WordPress 最终标题、永久链接和修改时间收敛 canonical/JSON-LD；检测 Yoast/Rank Math/AIOSEO，避免重复 meta/schema；人工改稿后不输出过期 schema。 |
| A12 | 已完成 | CMS 与 PHP 对 blocks、HTML、URI 和跨字段规则对齐；危险协议、凭证 URL、不安全 HTML 和无效组件数据均被拒绝。 |
| A13 | 已完成 | 超长段落按自然边界并带硬上限切分，不静默截断；页码、时间范围和模态审计信息保留。 |
| A14 | 已完成 | 中文重复检测使用字符 n-gram；corroboration 按独立来源家族计数，转载/派生来源不冒充独立证据。 |
| A15 | 已完成 | 密码使用异步 `scrypt`；会话持久化到数据库，可按登录、退出、改密、改用户名即时撤销，旧 cookie 验证无效。 |
| A16 | 已完成 | Job 增加 owner、lease、heartbeat、CAS complete/fail 和过期回收；启动不会窃取活跃任务，worker 并发有界。 |
| A17 | 已完成 | WordPress 首次写入使用跨 worker 原子锁；新建后立即保存 CMS 标识；查询禁用旧结果缓存；重试不会重复建稿且不覆盖已发布文章。 |
| A18 | 已完成 | 增加官方证据人工审核 API/UI/历史；authority/verified 变化触发 Knowledge 重建，只提供建议而不自动背书。 |
| A19 | 已完成 | Registry 明确 `cmsUsable`、interface 和 renderMode；Page Block 与 Presentation 能力分离，基础原语始终可用。 |
| B01 | 已完成 | 按 content type、意图和证据量生成动态字数/FAQ/配图策略；固定 1200 字与固定组件数量已移除。 |
| B02 | 已完成 | Prompt DTO 提供可读来源标题、公共 URL 与日期；成稿必须包含读者可见 Sources，内部 Claim/Source ID 不进入正文。 |
| B03 | 已完成 | FAQ 仅在问题意图且证据充分时生成；FAQPage 与可见 FAQ 严格一致，否则删除；策略 1.5 记录 2026-09-08 的官方政策核验。 |
| B04 | 已完成 | Opportunity 标注 create/update/merge/retire、目标 post 与影响；提供管理员生命周期 API，update/merge/retire 均需编辑批准且不自动覆盖/下线。 |
| B05 | 已完成 | 最终页面生成稳定 blockId 和 semantic role，并保存对应 Claim/Source provenance；内部链接只允许来自已同步的已发布 WordPress inventory。 |
| B06 | 已完成 | Pipeline 使用 1–8 的有界并发、任务 lease/heartbeat、Retry-After 和指数抖动退避，避免无限并发与重复执行。 |
| B07 | 已完成 | 模型调用记录 stage/provider/model、哈希身份、tokens、缓存 tokens、延迟、attempt/status/error；未知成本保持 null，不伪造费用。 |
| B08 | 已完成 | Writer/Reviewer 使用白名单 DTO 与版本名；只记录 prompt/schema/input SHA256；增加 128 项 LRU 进程内响应缓存和并发请求合并，不落原始提示词/来源正文。 |
| B09 | 已完成 | Provider 错误区分永久/瞬时，支持 Retry-After；Frontend snapshot 使用 Registry/Page/Publish 三工件复合 checksum，发布前复核 snapshot ID 与 checksum。 |
| B10 | 已完成 | `test:cross-repo` 读取 sibling 前端真实生成物、同步临时数据库并验证真实 Publish Package；该门禁已纳入 `release:check`。 |

## 验证记录

- CMS `npm test`：127/127 通过。
- CMS `npm run check`：Vite production build 与所有 Node syntax check 通过。
- CMS `npm run release:check`：39 个强制检查通过、0 失败；包括迁移 1–31、SQLite integrity、隔离 HTTP/API/UI smoke、Extension 清单和跨仓库门禁。
- 跨仓库门禁：Contract `1.1.0`，复合 checksum `e81cf6bd8cf2ff6f6e6c6a6e233edfccdf46fb60633a2500a2ef8638a7d8dbe1`。
- 前端静态验证：project、page architecture、component registry、content contract 全部通过。
- WordPress Playground：CLI `3.1.52`、PHP `8.3` 下的蓝图 CMS Publish Adapter 测试通过；Child Theme Content Runtime 验证通过。
- 前端发布包已生成：`dist/solo-to-china-theme.zip`、`dist/solo-to-china-child-theme.zip`、`dist/solo-to-china-tools-plugin.zip` 和 `dist/release-manifest.txt`。
- release check 未调用真实 Kimi/Vertex 计费请求、真实 Search Console 或生产 WordPress 写入；生产连接状态由部署后的只读健康检查和实际部署结果记录。

## 部署与回滚记录

- 待补：CMS commit / remote push commit。
- Frontend commit：`fcd1cb0e936b666c888ade7ea8b648799e3fb3be`；remote push 待完成。
- 待补：Artifact Registry 镜像标签与 digest。
- 待补：GCE engine 容器版本、数据库升级结果与 `/api/health`、`/api/ready`。
- 待补：WordPress Parent Theme `0.28.0` 安装结果及公开 Contract endpoint checksum。
- 回滚点：部署前生产 SQLite 备份；前端上一版本 Parent Theme `0.27.0`；CMS 上一镜像 `1.14.1`。
