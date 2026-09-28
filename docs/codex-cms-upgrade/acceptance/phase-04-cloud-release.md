# 2026-09-29 原云端升级执行记录

**最终发布结论：BLOCKED / ROLLED_BACK。代码已提交推送并合并，候选镜像构建成功；新版没有对外上线。原云端 API/Worker 已恢复 2.0.70/schema79。**

决策：`LOCAL_DEVELOPMENT / EXISTING_CLOUD_PRODUCTION`。保留原云端 GCE、数据卷、数据库、媒体、队列及 `https://engine.solotochina.com`；公开站 `https://solotochina.com` 为独立 WordPress。旧本机生产迁移计划 DEFERRED。此文件只记录实际执行，不以离线测试推断线上成功。

## 目标锁与基线

- 仓库 `Weapon-Tsang/solo-to-china-CMS`，基线 `main/490dd7464d4beb46d3f89a578337c253917fbf7a`；候选 app 2.0.71/schema83。
- GCE project `project-4bcb9146-c37b-43b0-b11`，VM `solo-to-china-engine`，zone `asia-east1-b`；原 API/Worker 容器及 Cloudflared 正常运行。持久卷 `solo_to_china_data`，正式 SQLite schema79；只读观察 Sources 84、Source assets 1454、Jobs 19239、Drafts 12。新表 `article_media_revisions` 在原库不存在。
- 原线上 image digest `sha256:8339aa10cd3a02b4178d7137943aa648ab10251ab3ab5213f84d5b3d54ecb313`，API/Worker 共用。备份/迁移前可用空间约 41.05 GB，非备份数据约 5.73 GB。
- 真实 WordPress 公开只读合同 1.4.1、组合 SHA `9154dc68540d9922c11109e4cfe00aee871d850e61124fd7edb624ee20b2c422`。限定封面/正文媒体刷新未见必要 CAS/幂等/回执能力，保持门控；最小外部请求见 `EXTERNAL_DEPENDENCIES.md`。

## 候选验证

- 风险类型 DATA_MIGRATION + PIPELINE + 媒体 UI；生产来源 schema79 升至候选83，须原地备份、恢复演练、隔离迁移后才允许替换。
- 本地 `npm run check` PASS；相关备份、恢复、媒体、合同模块测试 PASS；发布总检查结果以本轮最终运行日志更新。
- 受控发布脚本不执行全历史机会协调或清理旧容器/镜像，备份禁用裁剪。Worker 在本次发布时关闭自动启动历史补排，仅消费既有合法队列；本地回归验证该门控不写 `claim_resolution` 补排标记。
- 扩展云端包 `output/phase04-cloud-extension-2.0.71.zip`，SHA256 `4692b6e87db505dcaeb7a380c8857c595810ddd57ede41a26d85e1d1a91adb80`，默认 endpoint `https://capture.solotochina.com`，不嵌入 token；包在本机输出目录，用户浏览器配置未改。

## 执行结果

### 源码与固定制品

- PR [15](https://github.com/Weapon-Tsang/solo-to-china-CMS/pull/15)、[16](https://github.com/Weapon-Tsang/solo-to-china-CMS/pull/16)、[17](https://github.com/Weapon-Tsang/solo-to-china-CMS/pull/17) 已正常合并。各 PR 的离线发布门禁和真实 Linux Docker API/Worker 冒烟通过；未绕过保护、未改写历史。
- 最终发布提交 `a11bcf1711c6b31b52725cdc925c4817629037f3`，app/扩展版本 `2.0.71`；镜像 `asia-east1-docker.pkg.dev/project-4bcb9146-c37b-43b0-b11/solo-to-china/engine@sha256:f6f4fe0039f1ae8d946c4b14a0821bed3ae18872053a81e5b536291a769cd242`。
- 3 次 Cloud Build 均成功，已用尽本轮上限：`d9255595-e470-476b-b2f8-c1e5acfc0cc3`、`6ba8c931-087c-426c-90d8-86c32a51982c`、`3a5734e2-b0b0-4dc6-8b20-f03a2771b501`。没有第 4 次构建。制品来自固定 Git archive，不包含本机私有证据、数据库或 Windows node_modules。
- 最终源码 ZIP SHA256 `c1753c28e9168c028af60099ffdec76732b7226bb15abf93df5ab9700dbcb0f3`；最终部署 wrapper SHA256 `2ca08e2f175eed5a7bc772eae7858a5cd76703c10fecce1eac08ee07c2fb8c26`。

### 真实发布阻断与修复

前三次部署尝试均在备份关卡停止，未迁移正式 schema；每次恢复原 API/Worker 与原 startup metadata，并确认原 2.0.70 健康。

1. 缺失的一份 24,572 字节派生 WebP 被 5 条存储引用指向；同 SHA 原件存在且 transform 为空。仅以独占创建方式逐字节恢复这一个文件，未改数据库、未生成图片。随后 1,417 条 source_assets 文件 SHA 全部匹配，明确媒体引用缺失数为 0。
2. capture JSON 中历史 `media/...` 路径错误落到 `/app/media/...`；修复备份解析器，只接受文件名 SHA 与当前媒体根字节完全匹配的别名。
3. 同类 `.derived/...` 历史路径遗漏；补齐相同严格规则及回归。真实审计共 1,069 个别名（1,041 media、28 derived）均找到同 SHA 字节，未批量重写正式 capture JSON。

最终备份模块 30 项通过（包括两类路径的相对/绝对形式、错误字节拒绝和恢复演练）。没有降级备份完整性门禁。所有失败尝试、原镜像与旧容器保留。

### 功能边界

| 功能 | CMS 实现/接线 | 真实接收端 | 本轮线上写入冒烟 |
|---|---|---|---|
| 既有完整 package 新稿发布 | 既有正式通路保留 | 合同 1.4.1 只读核对通过 | 尚未执行 |
| 封面独立刷新 | 本地持久修订及交付服务存在；正式调用链未完整接通 | 缺限定 CAS、幂等及可查询回执能力 | 未执行，保持门控 |
| 正文媒体独立刷新 | 本地持久修订及交付服务存在；正式调用链未完整接通 | 缺限定 CAS、幂等及可查询回执能力 | 未执行，保持门控 |

真实 Provider 验收未执行，本轮主动新增模型调用预算为 0。不得把 fixture/受控 HTTP 验证描述为真实 WordPress 端到端交付。未修改独立前端仓库、既有 WordPress 文章、DNS、认证或浏览器 profile。

### 本轮完整备份

云端同一受限数据卷内快照：`/var/lib/solo-to-china/backups/solo-to-china-2026-09-28T19-26-25-108Z.snapshot`。实际输入 schema79，文件数 1,449，数据库 2,335,653,888 字节，数据库 SHA256 `7af3b10dc9196f6efba54b8a4b35eb7577ca9c75282be505625317e19bb6d32a`，完整性校验 `ok`。运行配置保留于原受限 `.env.production`，秘密未导出到交付报告。快照没有下载到本机开发库。

### 最终尝试、回滚与当前运行态

- 完整备份、隔离恢复通过；恢复读取 1,417 份来源预览、15 份稿件媒体，离线交付探针通过，无外部副作用。副本迁移 121,888 ms、正式库迁移 145,782 ms，均达 schema83，integrity=ok、foreignKeyErrors=0、旧内容指纹不变。
- 2026-09-29 北京时间约 03:24 开始维护，最终只读 Opportunity 审计发现 6 条 `knowledgeAdmissionViolations`，退出码 1。失败时 `exposed=0`，尚未创建新版公开 API/Worker、没有新版业务接收。没有跳过门禁。
- 6 条异常均为 `storedFamilyMismatch`：保存来源族数/实际来源族数分别为 14/12、3/2、18/17、31/30、24/23、3/2；所选事实均可用，缺失事实和未完成来源均为 0。备份与失败 schema83 库的 `content_opportunities`、`knowledge_facts`、`source_family_memberships`、`knowledge_resolutions`、`topic_clusters` 全表指纹一致，确认审计输入没有被迁移改写。不能直接 SQL 改数以凑通过，需后续区分投影陈旧与计算口径问题，再做定向修复及回放。
- 相邻审计还观察到 7 个不满足完整证据条件且无活动 Job 的来源、134 个 EVIDENCE_GAP 机会、31 个 readiness=0 机会；未批量重试或清空历史状态。该观察不等于这 7 个来源都应自动重跑。
- 脚本从本轮验证快照恢复 schema79，失败的 schema83 库保留在云端 `failed-database-1790625139987`。03:52:43/44 原 API/Worker 分别重启，最后一次维护窗口约 28 分钟。前三次备份失败尝试另有维护窗口，未合并伪装为一次短时发布。
- 原域名 `https://engine.solotochina.com/api/health` 返回 2.0.70、HTTP/DB ready；浏览器通过原 HTTPS 打开登录页。API 与 Worker 都运行旧 digest `sha256:8339aa10cd3a02b4178d7137943aa648ab10251ab3ab5213f84d5b3d54ecb313`，实际 revision `e9f7c8e82ff760f4d18f2d2e0673452eb8744290`，仍使用原持久卷和原数据根。
- 原 startup metadata 已恢复，SHA256 `6e74c5fdad9b67276187076e3871c1e01835c5000faaea8e6c8976391234d878` 与发布前一致；未执行候选镜像 pin。没有留下失败 wrapper 作为 VM 下次启动入口。
- 回滚后只读核验 Sources 84、Assets 1,454、Claims 5,465、Drafts 12 与本次备份一致；media_dispatches 仍有 1 条未知结果，未释放或重投。Worker 的原正常轮询已经恢复，并观察到实际领取任务；这不是新版 Worker 验收通过。

### 测试层级与未覆盖范围

| 层级 | 状态 | 真实覆盖范围 |
|---|---|---|
| L1 Targeted Tests | PASS | 备份最终 30 项、运行门控 13 项及 check；测试组重叠不累加 |
| L2 Module Regression | PASS | 相关媒体/恢复/合同模块 61 项；最终 PR Linux CI 离线 gate 与真实 Docker API/Worker 冒烟 |
| L3 Production DB Replay | PASS（迁移/恢复范围） | 当前云端一致快照、隔离恢复、79→83 副本迁移及内容指纹；不代表业务审计通过 |
| L4 Browser E2E | NOT TESTED（新版） | 回滚后原 HTTPS 登录页可打开；无新版登录后操作或写入 E2E |
| L5 Real Provider Canary | NOT TESTED | 本轮禁止新增模型验收调用，新能力不据此启用 |
| L6 Full Production Replay | NOT TESTED | 未执行 Capture→QA 全生产链；不能以离线 gate 代替 |
| Post-Fix Exploratory Audit | ISSUES FOUND | 6 条来源族计数不一致阻止发布，其他历史状态见上 |

### 交付、副作用与停止边界

- **没有执行**准备好的上线图片冒烟：测试来源 0、测试草稿 0、测试上传图片 0、WordPress draft/附件/文章写入 0。新版未公开，因此没有在旧版本上冒充新版验收。
- 本轮主动模型测试调用 0；旧 Worker 恢复生产后的调度并非零副作用。最终只读对比显示相较最终备份 Jobs +27（19,320→19,347），模型遥测 +3（6,520→6,523）。这 3 条均为真实 `experience_extraction` Provider 请求，HTTP 200 / `response_received` 后以 `MODEL_OUTPUT_LIMIT` 失败，`cost_usd=null`，**费用未知，不是 0**。当天同类失败遥测共 12 条，涵盖先前恢复期间记录，不能宣称整轮零模型副作用。
- 旧版自身启动逻辑生成了覆盖矩阵/主题/机会重建及批准机会协调各 5 个成功 Job、合同同步 1 个成功 Job和体验提取 1 个失败 Job；没有手工执行全库 backfill/reconciliation 或“全部重试”，但必须披露原程序自动启动行为。新候选启动门控未上线。观察时队列 queued/running=0，历史失败共 1,226；不清失败状态，不额外重启。没有提高预算或发起 Provider Canary。
- 新版候选、3 次构建、备份、失败 schema83 库、旧容器/镜像均保留。云端 VM/卷/数据库未删除，本地没有启用正式生产或第二个消费者，公开前端未改。
- 扩展加载目录 `output/phase04-cloud-extension-2.0.71/` 和 ZIP 已交付，用户浏览器尚未更新。需要更新时保留现有扩展 ID/存储，仅替换现有加载目录内容并在扩展管理页重新加载；不卸载、不清队列、不切 localhost。真实小红书 DOM 抓取未测。
- 后续只针对上述 6 条不一致做定向诊断与永久回归，再安排新的有限发布窗口；本轮 3 次构建上限已用完，不自动追加构建/再次维护。新封面/正文刷新还须独立接收端能力与正式 dispatcher 接线。

`current_authorized_step=NONE`；`phase_end_stop=true`。本轮临时浏览器检查页已关闭；原正式 API/Worker 保持运行。决策仍为 `LOCAL_DEVELOPMENT / EXISTING_CLOUD_PRODUCTION`，旧本机生产迁移 DEFERRED。
