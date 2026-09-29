# 模型调用优化与品牌资源生产发布 — 2026-09-29

状态：已发布，2026-09-29 18:43 CST 完成重启配置核验。

变更分类：AI_PROVIDER / PIPELINE / UI_ONLY；CODE_ONLY_RELEASE。

生产镜像：`asia-east1-docker.pkg.dev/project-4bcb9146-c37b-43b0-b11/solo-to-china/engine@sha256:4f85ae895d0b7745a0607b65178ff78df9066f4c1721cf376e2812a98827579f`

补丁：`1a1785c7c938b1c90d0afc3539fc2dab583472b1af5d50a848ae80486ce4ac8c`。应用版本沿用 2.0.72，schema 83。

## 发布内容

- 同一模型请求公共上下文去重，保留完整正文和逐图证据；七图生产副本当前逐图路径文字字符数减少约 28.5%，这不是总账单下降比例。
- 片段、图片批次、体验提取的模型成功结果持久化复用，业务提交失败恢复时避免重复付费；capture/config 变化拒绝复用。
- DeepSeek 不再传应用侧 max_tokens，保留原 thinking 配置；体验证据引用可逆短编号及完整 schema；修复 nullable 校验。
- 输出截断及耗尽修复次数的无效输出终止重复重试，429/传输错误保留重试。
- CMS 顶栏、登录页和站点 icon 使用用户原始品牌图片。

未包括工作区其他扩展改动。没有 commit/push、schema 迁移、生产数据转换、全量备份、磁盘快照或 WordPress 写入。未批量重试历史失败任务。

## 验证

| 层级 | 状态 | 覆盖范围 |
| --- | --- | --- |
| L1 Targeted Tests | PASS | 定向模型、上下文、恢复测试 |
| L2 Module Regression | PASS | 发布时 65 项，含 pipeline/content pipeline 至 QA 和 mock WordPress；npm run check PASS |
| L3 Production DB Replay | PASS | 已有只读生产副本派生一次性 work DB；七图上下文完整性、结果跨实例复用、capture/config 失效；非整库重放 |
| L4 Browser E2E | PASS（限定） | 生产来源页加载、刷新按钮、新 Logo 36×36 加载；登录 Logo 此前本地验证；未新建生产来源 |
| L5 Real Provider Canary | PASS（限定） | 发布前固定一图 26 Claims、固定复杂体验来源 13 blocks/4天路线；未覆盖全部 Golden Sources |
| L6 Full Production Replay | NOT TESTED | 完整真实生产来源 Capture→QA 尚未执行；fixture 全链路不能替代它 |
| Post-Fix Exploratory Audit | ISSUES FOUND | 历史体验失败仍在；本次发布后运行任务/待发布为 0，无自动恢复触发，两个角色重启计数 0 |

候选镜像在 network none、一次性数据库副本中通过全部发布文件哈希、readiness、有效/无效令牌检查，Job 和 model metrics 数量不变。没有额外付费模型请求。

生产两个域名 readiness 200；三个现有扩展 origin 均通过正确令牌 identity-check，OPTIONS 204、错误令牌 401，未允许 origin 403。Logo SHA256 与原图一致：`0b66c76bd86c496e6d59906fcf53eafb8ce0fb26441454a9bd1f22f35b36d539`，HTML favicon 路径正确。

切换过程约 9.37 秒，API 切换窗口约 8.88 秒。startup metadata 已回读确认，仅恢复已验证容器，不运行迁移或回填。容器运行镜像 digest 与发布镜像一致。

## 回滚与剩余问题

上一版本镜像 `sha256:deefdfc5fd49d0e278c74265734a92fccfbbbd1567b4a0413d094e22f1b824a7` 及停止的 `engine-before-model-cost-20260929` / `engine-worker-before-model-cost-20260929` 保留。原环境、启动配置及发布结果存于主机 `/opt/solo-to-china/code-releases/model-cost-20260929`，包含私密环境文件，不应公开。

磁盘剩余约 2.8GB（97% 已用）；没有清理回滚资产或生产数据。历史失败体验任务未重跑，因此不能宣称历史生产问题均已解决。真实全链路、更多 Golden Sources 与长期节费统计仍未验证。

本地证据：`output/model-cost-release-20260929/identity.json`、`public-auth-verification.json`、`output/model-cost-release-tests.log`、`output/model-cost-release-check.log`、`output/model-cost-validation/replay-result.json`、`canary-result.json`、`output/experience-semantic-replay.json`。

发布后日志抽查（10:42 UTC 起）：API 与 worker 均未出现 error/fatal 或 HTTP 400/429/5xx 事件。仅为观察窗口结果，不代表长期运行验证。
