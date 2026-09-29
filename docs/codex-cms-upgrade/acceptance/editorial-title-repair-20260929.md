# 内容机会与历史文章模板标题修正 — 2026-09-29

状态：本地开发修正完成；未部署，未回填生产数据库，未提交或推送。用户明确排除已发布文章与生产队列中的记录。

Change class: DATABASE_LOGIC / PIPELINE（确定性标题处理，无 Prompt、模型或 Provider 配置变更）。

## 修改

- `src/editorial-title.mjs`：删除统一的 independent travelers guide 后缀；只根据可用事实的谓词表达预约、费用、时间、交通、路线、点餐等信息维度，最多三个。未知、隐藏、过期或冲突事实不产生标题承诺。证据不足时保留主题名。中文主题使用中文维度，不编造英文地名。
- `rebuildKnowledgeOpportunities` 使用新标题规则，并为新生成/未批准的机会保存 `titlePolicy: evidence-v1`。已批准、生产绑定和终结状态跳过；反向候选关联和 active owner job 同样保护。
- 新规则机会的正文保存阶段识别模型再次输出的同类套话，修正标题及对应 SEO/OG/card 标题；具体、有信息量的标题保留。既有生产 owner 没有该标记，保持原生成行为。无额外模型请求。
- 历史工具 `scripts/repair-editorial-titles.mjs` 默认只读预览。写入入口仅允许明确的 `*work.sqlite` 工作副本，不随启动运行。事务内重读预览，状态变化拒绝写入。
- 未批准机会修正标题及规则标记，保留身份、证据、就绪度和审批信息。已批准、绑定候选/组装、活动任务或终结机会跳过。
- 历史闲置草稿只处理 `review` / `approved` / `qa_failed`，并检查 draft→brief→candidate→opportunity 全链任务、provider batch、WordPress publication/投递绑定；其余状态保守跳过。通过现有元数据编辑逻辑生成新修订与内容哈希，同步 SEO/OG，保留正文、slug、全部现存媒体；使旧派生页面失效，停留在 review，不新增任务。
- 机会审计改为优先从 `proposal.targetEntities` 找主题；旧记录仍兼容原后缀。标题显示方式不再决定主题匹配。

## 验证

| 层级 | 状态 | 实际覆盖 |
| --- | --- | --- |
| L1 Targeted Tests | PASS | 新增10项标题、历史修正、审批/队列保护、预览失效、幂等与新旧生产规则测试；语法与构建检查 |
| L2 Module Regression | PASS | 63项：editorial-title、major-refactor、production-state-hotfix、content-pipeline；包含保留媒体和两种内容链路的 mock WordPress |
| L3 Production DB Replay | PASS（限定） | 既有生产只读归档的标题依赖数据投影→本地只读 baseline→一次性 work。不是完整数据库或当前线上状态 |
| L4 Browser E2E | PASS（限定） | 隔离本地 API：打开建议、暂缓、刷新；标题保持；内容列表确认闲置草稿新题与排队/WordPress绑定记录旧题同时存在。无线上操作 |
| L5 Real Provider Canary | NOT REQUIRED | 没有 Prompt/Provider 改动；新后处理用已返回模型输出验证 |
| L6 Full Production Replay | NOT REQUIRED | 本次未发布，无 schema 变化；未做完整 Capture→QA 的真实生产链路重放 |
| Post-Fix Exploratory Audit | PASS（限定） | 原有同主题多版本重名保留；无新增不同原题合并，无孤儿生产 owner job / draft→brief 断链；不能代表完整系统健康审计 |

`npm run check` 通过。浏览器验证使用 Browser 技能，服务禁用 worker、维护和真实 Provider。

## 真实归档覆盖

来源：既有 `/opt/solo-to-china/upgrades/b65794b42bc25d11ca92e0f21e31456e72eaabb3/boundary.sqlite`，以只读连接导出标题与生产关联所需列；未创建新的生产备份。

- 机会 1,427；草稿 12；Job 19,382；事实 4,493。
- 匹配套话记录 653；工作副本修正 637 个未批准机会，其中原 ACTIONABLE 181 个。
- 保留 16 条匹配记录：11 个已批准/生产绑定/不可编辑机会，5 篇 WordPress 绑定草稿。
- 12 篇真实归档草稿全部逐表指纹不变；此归档没有可修改的闲置匹配草稿。闲置草稿修订覆盖来自真实 Repository fixture 和本地浏览器，不能称为真实历史草稿修改重放。
- 所有导出表除 `content_opportunities` 外指纹相同；受保护机会逐行相同；重复执行新增修改 0。
- 全库同题分组 151→132，包含已取代与合并的历史版本；未合并此前不同的原标题。没有清理这些历史记录。
- 无真实 Provider 调用，无生产数据库或 WordPress 写入。

真实示例：

| 主题 | 修正后的机会标题 |
| --- | --- |
| Guotai Arts Center | Guotai Arts Center: Costs, Opening Hours |
| Chongqing local snacks | Chongqing local snacks: Costs, What to Order |
| 重庆科技馆 | 重庆科技馆：预约、费用、开放时间 |

证据：`output/title-repair-20260929/` 下的 `tests.log`、`check.log`、`title-final.log`、`projection-identity.json`、`preview.json`、`applied.json`、`replay-result.json`、`exploratory-title-audit.json`、`fixture-audit.json` 与浏览器截图。投影不包含完整媒体字节、无关表及原数据库约束，不能替代正式发布验证。

## 后续应用边界

生产历史记录尚未修改。当前 DEVELOPMENT 规则禁止默认部署及生产 backfill；正式应用需独立发布/数据修正步骤，并重新读取当时的审批、发布及队列状态，不能直接复用本次旧归档预览。

本次读取发现生产主机磁盘余量不足约1GB，本机亦不足以容纳完整归档双份副本；已停止完整文件传输并删除本次临时文件，改用小范围只读投影。未清理用户既有数据库、镜像或回滚资产。
