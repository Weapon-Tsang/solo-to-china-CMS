# 2026-09-29 原云端升级执行记录

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

待本轮实际动作填写。只有原域名新版、数据身份与 Worker 续跑均确认，才记录生产恢复。不得把受限 receiver 缺口描述为已交付。
