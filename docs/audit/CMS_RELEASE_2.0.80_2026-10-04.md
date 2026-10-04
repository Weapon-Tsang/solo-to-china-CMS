# CMS 2.0.80 生产发布与远端分支复核

2026-10-04，用户明确授权提交、推送、部署上线和清理远端分支。生产切换于 **22:51:13（Asia/Shanghai）** 完成。

发布类型：**CODE_ONLY_RELEASE**。数据库保持 schema 83，Content Strategy 保持 3.9；没有启动历史 backfill 或 reconciliation。旧媒体计划修订发生在受保护的正常恢复工作流内，发布本身不转换历史记录。

## 发布身份

| 项目 | 验证值 |
|---|---|
| 应用／扩展版本 | 2.0.80 |
| 代码提交 | `78e6ba6176b8aa95090a837e82cf46d302839c1b` |
| 远端 | `Weapon-Tsang/solo-to-china-CMS` 的 `main` |
| Cloud Build | `321bb8bd-0527-419d-bba8-ae68b0b0db8c`，SUCCESS |
| 不可变镜像 | `asia-east1-docker.pkg.dev/project-4bcb9146-c37b-43b0-b11/solo-to-china/engine@sha256:722e8a6b5907721d9b006cc7fc63ad7aecabbc704cb9f15201e280782c7eadbb` |
| 生产地址 | https://engine.solotochina.com |
| Linux CI | [Release gate 37210316461](https://github.com/Weapon-Tsang/solo-to-china-CMS/actions/runs/37210316461)，SUCCESS；包括运行镜像构建和隔离测试 |

构建来源是该固定提交的 Git archive，不包含本地数据库、测试输出、凭证或未提交文件。使用提交中的代码发布脚本和镜像固定脚本；传输后核验内容哈希。候选在断网的一次性数据库上启动并通过 readiness，然后才切换 API／Worker 和公网流量。

## 发布验证

- 最终本地 `release:check`：50 项 mandatory PASS、0 failures；全量测试 **1,278/1,278 PASS**。5 项 warnings 与 5 项外部／未测试维度保留。
- 首次正式门禁发现两条旧断言仍期待“识别结果未知”和“静默截断体验块”。更新回归以验证识别失败与生成 unknown 的区别、普通包超预算拒绝及分区包完整保存。定向 33 项通过后，完整门禁重新通过。
- 真实历史全库副本重放：来源连续性、6 个缺失提取任务的本地恢复／回滚、队列排空优先级和保护记录数量通过；不是当前全库生产状态的证明。
- 3 篇历史文章及 2 个来源诊断的提交中断／重启重放通过，成功响应各只使用一次，前后指纹相同。
- 本轮两篇文章、两条长来源的真实样本重放再次通过；使用保留的成功真实 Provider 响应，不重复购买调用。
- 5 条受控完整流程通过：legacy、article_bundle_v1、editorial-v2，以及 legacy／bundle 重启恢复，覆盖 Capture → 提取／Coverage → Experience／Knowledge → Opportunity／批准 → 写作 → QA → mock WordPress。

| 测试层级 | 结论与实际范围 |
|---|---|
| L1 Targeted Tests | PASS；本轮及发布门禁暴露的回归 |
| L2 Module Regression | PASS；最终全量离线门禁及 Linux CI |
| L3 Production DB Replay | PASS；历史全库副本与当前问题的 31 表关系样本，全部写入一次性 work database |
| L4 Browser E2E | PASS；已完成本地真实恢复操作。生产登录后的浏览器操作 NOT TESTED |
| L5 Real Provider Canary | PASS，限定范围；开发阶段固定 Vertex 文本、写作、原图与两条长来源。真实 DeepSeek 本轮 NOT TESTED |
| L6 Full Production-Like Replay | PASS，受控 5 条完整链路；真实来源使用真实模型从 Capture 全程到文章 QA NOT TESTED |
| Post-Fix Exploratory Audit | PASS，执行范围内；样本修复不变量及发布后运行／队列／Owner 状态 |

真实 Vertex 测试的 Schema 400 回退、先前诊断尝试和 Token 数量见 `CMS_INTERRUPTION_RECOVERY_2026-10-04.md`，不把隔离测试称为真实生产模型调用。正式 WordPress 写入和长期生产失败率 NOT TESTED。

## 生产核验及回滚

发布前后 API 和 Worker 的 schema 均为 83。新容器均运行同一不可变镜像与代码提交，启动历史 reconciliation 均为 false；检查时重启数为 0、无 OOM。公网 `/api/health`、`/api/ready` 和首页均返回 200；版本 2.0.80，database ready。

| 保护对象 | 数量 | 发布前后相同 SHA-256 |
|---|---:|---|
| article_drafts | 18 | `b08d5c32dfb5b77f34e57be2bb214ca319ec233c63d97d3d4b0bead4276c33d7` |
| wordpress_publications | 14 | `1f44f43f905736f28a0801e2ff56e1a01c3f54f2dbb42f177fc5c97cd0b2095f` |
| required_media_manifests | 29 | `42189c8512d6fe73460f0199c6c478f2c9560eb7f1b21381af6ca307f8d352ed` |

发布后只读扫描：无 queued／running Job，无孤儿批准 Owner、重复活跃 Owner 阶段或从发布准备开始新增的失败 Job；Worker 已记录 `worker.ready`。这是一段有限观察窗口，不是对未来失败率的承诺。

保留 2.0.79 回滚容器 `engine-before-78e6ba61`、`engine-worker-before-78e6ba61` 及原不可变镜像；旧容器停止且 restart=no。运行环境只更新 ENGINE_IMAGE，其余配置逐字节保持一致。VM startup-script 更新为只启动已验证的新容器，回读与本地目标字节一致，SHA-256 为 `a34138b6f2c6a2e4c3dd86b23d5f360f80cefb20a5ec9905b9f1ab6ef5a112c5`。没有执行 VM 重启测试。

没有执行生产迁移、完整生产备份、磁盘 snapshot、Docker 镜像清理或 WordPress 写入。

## 远端分支与历史待处理项

提交前和发布后均通过远端实际 heads 清单确认只有 `main`，没有可删除的遗留远端分支。已执行 `fetch --prune` 清除失效远端引用；没有删除本地分支或其它工作目录。

本次部署不自动重新排队历史失败任务。两个原 Experience 来源的旧 `MODEL_OUTPUT_LIMIT` 失败记录仍保留；文章历史计划也没有因容器切换而被批量改写。此前本地修复／真实 Canary 的成功结果不能代替线上恢复执行。

原始发布材料保存在忽略目录 `output/release-2.0.80/`：`production-release.json`、`before.json`、`after.json`、`post-audit.json`、`rollback.json`、`public-check.json`、构建／CI 状态和测试日志。生产服务器保存发布记录于 `/opt/solo-to-china/upgrades/78e6ba6176b8aa95090a837e82cf46d302839c1b/`。本报告单独归档提交，不改变运行镜像的代码身份。
