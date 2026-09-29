# 覆盖重建队列修复：生产发布验收

2026-09-29 17:53（北京时间）完成生产切换与开机恢复配置验证。用户明确授权“发布到生产”。分类：DATABASE_LOGIC / PIPELINE；CODE_ONLY_RELEASE。

## 发布内容

- WordPress 清单未变化时不再创建全目的地重建任务；实际内容变化仍沿用原刷新逻辑。
- 同一次覆盖重建复用来源资格与来源族映射，避免每条机会重复读取全库；保留数据库重任务独占机制。
- 只替换 src/repository.mjs 与 src/opportunity-family-evidence.mjs。未夹带本地扩展修改，未更改 schema，未执行生产迁移、历史回填、数据库备份或磁盘快照，未提交或推送 Git。

版本保持 2.0.72，使用独立不可变 hotfix 镜像：

`asia-east1-docker.pkg.dev/project-4bcb9146-c37b-43b0-b11/solo-to-china/engine@sha256:deefdfc5fd49d0e278c74265734a92fccfbbbd1567b4a0413d094e22f1b824a7`

Cloud Build：08a70b22-6a45-49d3-969f-859f3cab2119，SUCCESS，仅一次构建。

API 与 Worker 实际文件哈希均符合验证版本：repository 0da9c43c86b312bc1c0fdb65c78d7c919124edd57792f222963cb3937098b16d；family evidence d958a30377cb18bb9c100cb219f7a080502c1a9b3e5249ca02d9a998c34f73b8。

## 验证范围

| 层级 | 结果 | 覆盖 |
| --- | --- | --- |
| L1 | PASS | 35 项定向测试，npm run check |
| L2 | PASS | 来源族、知识、WordPress 清单及发布、topic；另 2 项 pipeline/contract 测试通过 |
| L3 | PASS | 生产归档副本完整重庆覆盖重建，1336 条机会；624 条适用投影逐条核对计数及指纹；五类受保护数据哈希一致；12 条真实清单重复同步新增任务 0 |
| L4 | NOT TESTED | 本次未执行真实浏览器采集到后台的全流程 |
| L5 | NOT REQUIRED | 本补丁未修改 AI；未调用付费模型作为验证 |
| L6 | NOT TESTED | 模拟 provider 的 pipeline/contract 测试通过，但不等同于完整生产数据 Capture→QA 重放 |
| Post-Fix Exploratory Audit | ISSUES FOUND | 当前队列 queued/running 均空；原来源基础提取成功，experience 仍有既存 DeepSeek token/context 上限失败 |

隔离候选 API 启动、鉴权正反例及无新增任务/模型调用检查通过。上线后两个域名 readiness=200/ready，三个既有扩展 ID 的合法令牌空身份查询均 200；错误令牌 401，未授权来源 403。实际 API/Worker 均运行新 digest，RestartCount=0。启动元数据已读回逐字核对，保留仅恢复现有容器的启动方式，不执行迁移和回填。

## 发布过程异常与恢复

第一次切换的 Python 外部 HTTP 检查失败，自动回滚成功。第二次探测明确为 readiness HTTP 403；回滚改名与第一次保留的 failed 容器名称冲突，未完成自动回滚。随后恢复新 API/Worker 运行，用独立 Node 客户端验证公网 readiness、鉴权及实际镜像和文件哈希，确认通过后完成环境文件与开机元数据更新。没有修改网关访问策略，没有重新构建镜像。发布曾造成短暂中断；未测得可靠完整中断时长，不报告猜测值。

原脚本不应原样重复使用：需保留本次异常记录，并在后续使用前修复探测客户端差异、每次尝试的唯一回滚容器名及幂等恢复流程。当前生产状态已独立验证，不以该脚本退出状态代替验收。

回滚保留：engine-before-coverage-20260929、engine-worker-before-coverage-20260929（停止状态），旧镜像 digest 3fe1cc4459a4346a753f4ffa88a36845e63a5c1e107e173f8172e2a165418d80。发布记录目录 /opt/solo-to-china/code-releases/coverage-20260929-retry2；内部 env/inspect 文件包含机密，不作为公开附件。

## 未解决事项

来源 src_00f770704f8d4635ab3b4a5fe53f963a 的 capture version 2 完整，基础提取各阶段成功；extract_source_experience 已尝试 3 次，09:25:09 UTC 失败，原因 DeepSeek output reached its token or context limit。本发布未重试或修复该 AI 问题，不能表述为整条业务链全部修复。未写入生产 WordPress。
