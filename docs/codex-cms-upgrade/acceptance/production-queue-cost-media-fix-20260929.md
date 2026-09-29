# 生产队列、DeepSeek 费用与实景图片修复（2026-09-29）

后续已完成写作配图修复上线；以下是开发阶段的历史调查记录。最新发布和真实验证结果见 [写作配图生产验收](writing-source-media-production-release-20260929.md)。

模式：DEVELOPMENT。变更类别：PIPELINE / DATABASE_LOGIC，附带提供商标签修正。
未 commit、push、部署、停止生产 worker、重试生产任务或修改生产数据库；未调用付费 AI，未写 WordPress。

## 只读证据

生产数据库：`/var/lib/docker/volumes/solo_to_china_data/_data/solo-to-china.sqlite`，以 SQLite `mode=ro` 读取。
证据保存于 `output/production-queue-audit-20260929/`，主要文件：`live.json`、`schema.json`、`projection.json`、`current-cost.json`、`replay-report.json`。

- 20:41 北京时间快照：重庆 `resolve_entities` 正在运行，两篇文章分别等待 `generate_draft` / `generate_visuals`。
- 该任务为 `job_1bed52a234fe4bdea0e49065dfbbda79`，19:33 开始。21:04 再次只读查询时已不在运行列表，南滨路 `generate_draft` 已于 21:00 开始。
- 该任务的 DeepSeek 账本共 55 次记录：50 成功、5 失败；输入 2,810,727 tokens，输出 841,026 tokens，合计 3,651,753。最新 DeepSeek 记录时间为 20:58:58。这是知识实体解析，不是文章写作。
- 当天账本也记录了 Vertex Gemini 3.8 Flash 的正文、编排和审核，以及 Gemini 3.1 Flash Image 的 3 次成功生图请求。赠金页面不变不能据此推出 Vertex 未调用；未核实 Google 账单入账/赠金抵扣原因。
- worker 自动并发初始 2，上限 4。日志先因 `STALE_PIPELINE_INPUT` 降为 2，后在 20:19 因 `VISUAL_QUALITY_QA_FAILED` 降为 1。随后单个实体解析任务占住唯一执行槽。
- 南滨路两个视觉槽均为 Strategy 3.9，声明 `illustration`、`factual_image_required=false`、`generate_illustration`，主题却分别是南滨路江景和钟楼广场。原分支直接返回插画，跳过来源媒体匹配。
- 南滨路证据键对应 19 个来源、358 个资产，其中 338 个 `ORIGINAL_STORED`。42 个有分析记录，316 个无分析记录；这不是“338 张均已确认是南滨路实拍”。

## 修改

1. 实体解析只提交尚未 resolved 的知识主张。已经确认的身份不重复购买解析。
2. 每轮至多新增两个实体解析页面的模型结果，然后释放租约、延迟五秒重新排队，不扣失败次数。已完成页使用持久化 step receipts，重启后不重付费；最终仍统一提交，维持输入版本检查。
3. 业务 QA 失败和输入过期不再触发全 worker 并发削减；真正的提供商限流、超时等仍退避。
4. Strategy 3.9 及后续版本的正文插画请求进入授权来源图片选择；没有合格原图时不会虚构景点图。显式必需槽保留缺图阻塞，空方案进入已有的有预算图片识别流程。
5. 生图客户端再加一道正文原图策略检查；明确授权的抽象封面保留独立受限流程。历史版本行为保留兼容。
6. 对缺少旧图片说明的来源，选图发现优先检查标题匹配目标地点的原图，扩大只读候选检索上限至 1000；来源标题仅用于检查顺序，不能当成画面内容证据。每个 durable job 最多 3 次发现调用的原有预算不变。
7. 顶栏由错误的 `Kimi · deepseek-flash` 改为 `来源解析：DeepSeek · deepseek-flash`，明确此标签不代表写作/生图/质检角色。

## 测试与真实覆盖

- L1 Targeted Tests: PASS。
- L2 Module Regression: PASS。11 个相关测试文件合计 113 项通过；清理测试改动后视觉传输测试再次通过。覆盖分批让出、恢复不重复调用、原子提交、输入过期拒绝、已解析身份跳过、实景原图选择、无图不生图、历史兼容、封面流程。
- `npm run check`: PASS。顶栏修改后另行 build：PASS。`git diff --check`: PASS。
- L3 Production DB Replay: PASS（限定真实元数据投影）。6457 条 claims、3976 条 aliases、1546 个 assets、142 条图片分析等从只读来源导出，生成本地 baseline，再复制为 work SQLite。没有复制巨型图片 data URL，也没有写生产库。
  - 重庆合格主张由 4678 条降为 3189 条：排除 1489 条已解析身份，80 条/页由 59 页降为 40 页。
  - 南滨路旧的两个生成插画槽均不再被采用；仅凭当前导出的元数据无法选择合格实拍，因此新槽数为 0，后续必须检查保存原图，不能宣称图片已替换完成。
  - 三峡博物馆仍选中原来源卡片转换槽；真实卡片质量问题仍需在实际图片处理时验收。
- L4 Browser E2E: PASS（本地 API-only fixture）。刷新后显示来源解析 DeepSeek，进入内容页，点击生产中筛选，正确保留排队记录。本地服务无 worker、无付费调用，已停止。
- L5 Real Provider Canary: NOT REQUIRED。本次修改是确定性筛选、调度和发送前门禁，没有修改模型、prompt、schema 或传输格式。真实图片识别与替换：NOT TESTED。
- L6 Full Production Replay: NOT TESTED。未授权正式发布；未执行完整付费生产链或 WordPress 发布。
- Post-Fix Exploratory Audit: ISSUES FOUND。发现已解析主张重复送模、顶栏提供商误标并修正；仍存在大量历史原图未做图片级识别，且三峡博物馆卡片 QA 尚待真实媒体验收。

## 限制及上线前事项

本地只读投影不是完整生产库/媒体重放。追加完整媒体关联导出遭遇 GCloud 502/SSH 128，未因此扩大为生产备份。图片字节未下载、未逐张复核，未运行真实模型；绝不能据本次测试声称两篇线上文章已经恢复或原图替换已经完成。

截至本轮结束，线上仍运行旧代码。正式部署需用户明确授权；现有两篇文章的媒体修复/任务恢复应在部署后另行核验，已发布文章不属于本次修复范围。
