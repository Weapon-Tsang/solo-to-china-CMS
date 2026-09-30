# 生产中断修复发布记录（2026-09-30）

用户明确授权提交、推送、部署到生产以及清理远端分支。本次为 CODE_ONLY_RELEASE：App/Extension `2.0.76`、schema `83`、Content Strategy `3.9`。未执行生产 schema 迁移、全量 backfill、生产数据库备份、磁盘快照或 WordPress 写入。

## 代码与镜像

- 代码提交：`04d231706d49e3632f62112e50394b74be52e81f`，已推送 `origin/main`。
- 构建输入来自该提交的 `git archive`，排除本地数据库、凭证和开发输出；镜像 revision/version labels 已在切换前验证。
- Cloud Build：`a64ac625-7818-4a71-ade6-687e85f34671`，SUCCESS。
- 不可变镜像：`asia-east1-docker.pkg.dev/project-4bcb9146-c37b-43b0-b11/solo-to-china/engine@sha256:6a4c50781560d0542f237987d1705f9cff3c4ea274d434d15d8ca771d2bf4395`。

## 切换与生产验证

发布前生产 schema 为 83，API/worker 正常，无 queued/running 任务。先通过无网络、一次性数据卷的实际镜像启动、API/worker 角色、网络切换和恢复探针，再通过隔离 API canary readiness，最后切换生产 API/worker。探针的 backup/restore 只针对临时测试卷，未访问生产业务数据卷。

- 公网 Engine health/readiness、Capture health 均验证为 `2.0.76`；readiness 为 true，database 为 ready。
- 生产 Content API 返回 200，17 条记录；API/worker restart count 为 0，OOMKilled 为 false。
- 切换后的 15 份草稿正文及 hash、14 条 WordPress 发布记录与发布前 fingerprint 完全相同。
- 动物园保留实际 `DRAFT_EVIDENCE_VALUE_INVALID` 失败，current/recovery stage 为 `plan_content`，pipeline 为 `article_bundle_v1`，不再误报旧 Assembly 中断。
- 博物馆 current/recovery stage 为 `generate_visuals`，pipeline 为 `article_bundle_v1`。
- 没有重复 active production owner、孤儿 active production job 或意外新增活动任务。
- 本次未重试两条历史失败记录，也未运行生产模型生成或 WordPress 写入。部署修复与重新执行业务任务是不同的操作；本记录不宣称两篇文章已经生产完成。
- 切换期间 readiness 轮询曾收到短暂 502，随后正常；最终所有公开探针通过。
- 已保留旧 startup script，并将 GCE startup metadata 更新为仅恢复已验证的新容器，未执行 VM 重启。新 metadata Bash 语法及 revision/image identity 验证通过；SHA-256：`9dd126d2c411451efa6eefcdaae54b68cbdb933e826cbcfcfe24d81a80af7e7d`。
- ENGINE_IMAGE 已固定为新 digest，其余 runtime configuration 保持不变。

## 回滚保留

旧容器 `engine-before-04d23170` / `engine-worker-before-04d23170` 已停止并保留，旧镜像为 `sha256:7bb1e112d9708516818446338483fe14eef1c44676a18c1823b7e836490cdd78`。没有清理旧容器或 Docker 镜像。

发布目录：`/opt/solo-to-china/upgrades/04d231706d49e3632f62112e50394b74be52e81f`，保存 previous startup、previous image configuration、canary/public readiness、切换记录和生产数据 fingerprint。代码回滚应停止新版 API/worker，恢复旧容器名称、network/restart policy、旧镜像配置及 startup metadata；schema 不变，不应通过覆盖数据库丢弃后续业务写入。

## 验证覆盖

| 层级 | 状态 | 实际覆盖 |
| --- | --- | --- |
| L1 Targeted Tests | PASS | 永久 bug regressions、check/build、diff 检查 |
| L2 Module Regression | PASS | 160 项定向模块测试；正式 `npm run release:check` 全量离线测试、固定 Frontend Contract 和隔离服务门禁通过，50 项 mandatory checks，0 failures |
| L3 Production DB Replay | PASS（限定范围） | 当前生产只读投影的本地 baseline/work 恢复重放，owner/version、幂等、保护数据；发布前后生产只读 fingerprint 验证 |
| L4 Browser E2E | PASS（本地副本） | 实际点击恢复、排队、动物园保存真实 canary 输出并创建实际图片下游任务；生产浏览器点击恢复 NOT TESTED |
| L5 Real Provider Canary | PASS（限定范围） | 固定动物园 planning package，1 次真实 Vertex 生成并通过本地证据校验；第二次纠正分支由 mock regression 覆盖 |
| L6 Full Production Replay | NOT TESTED | 全量离线门禁包含 legacy / bundle / editorial-v2 的完整 approval→QA→mock WordPress 链；真实生产 baseline 从 Capture 到 QA 的完整链未重放，不将 fixture 称为完整真实生产验证 |
| Post-Fix Exploratory Audit | PASS（限定范围） | 当前生产状态、owner/孤儿活动任务、成功 bundle 缺 draft、本地恢复幂等、发布后数据与状态投影；没有全量媒体像素或 Knowledge 语义扫描 |

博物馆剩余原图是否满足本篇文章的视觉要求、两篇文章的生产重试及独立最终 QA、真实 WordPress 写入仍为 NOT TESTED。完整开发根因、回归及 canary 边界见 [开发验证记录](production-interruption-development-fix-20260930.md)。

## Git 分支

远端分支检查仅有 `refs/heads/main`，没有可删除的功能分支；保留主分支，不删除发布代码。Git archive、构建/部署日志和验证 JSON 保存在忽略目录 `output/production-interruption-20260930/`。
