# SoloToChina CMS Agent Rules

## 默认工作模式

除非用户明确说“部署到生产”或“发布到生产”，否则任何任务都属于 DEVELOPMENT 模式。

用户说：

- 修改
- 修复
- 优化
- 测试
- 检查
- 验证
- 看看效果
- 调整

均不代表授权生产部署。

## DEVELOPMENT 模式允许做什么

可以：

- 修改本地代码
- 运行相关单元测试
- 运行 npm test
- 运行 npm run check
- 运行 npm run build
- 启动本地开发服务器
- 使用生产数据库的副本测试
- 使用本地测试数据
- 在明确需要时进行少量真实 AI API 测试

默认不得：

- 自动 git commit
- 自动 git push
- 自动运行 Cloud Build
- 自动创建 GCE 磁盘快照
- 自动执行生产数据库备份
- 自动执行生产数据库迁移
- 自动替换生产 Docker 容器
- 自动修改 GCE startup script
- 自动执行生产 backfill / reconciliation
- 自动写入 WordPress
- 自动清理生产 Docker 镜像
- 自动对生产数据库执行 POST / PUT / DELETE 操作

## Git 规则

修改完成和测试通过，不代表用户授权 commit 或 push。

只有用户明确要求：
“提交”
“commit”
“push”
“推送到仓库”

才能执行对应操作。

## 生产部署授权

只有用户明确说：

“部署到生产”
或
“发布到生产”

才能进入 RELEASE 模式。

不得根据上下文自行推断生产部署授权。

## 正式发布分成两种

### CODE_ONLY_RELEASE

适用于：

- UI 修改
- CSS 修改
- 文案修改
- 普通前后端代码 Bug
- API 代码调整
- 数据库 schema 没有变化
- 不需要修改历史持久化数据

这种发布不要执行完整数据库迁移流程。

只需要：

- 最终测试
- 构建不可变镜像
- 隔离启动新容器
- readiness 检查
- 切换运行容器
- 保留上一版本容器/镜像用于回滚

不要因为普通代码变化就执行：

- 完整数据库 backup
- migration rehearsal
- production migration
- 整块 GCE disk snapshot
- 全媒体 SHA 校验

### DATA_MIGRATION_RELEASE

只有出现以下情况才使用完整重型发布流程：

- 数据库 schema 变化
- 历史数据需要转换
- 媒体存储结构变化
- 持久化字段语义变化
- 需要执行不可逆数据操作

这种情况才执行：

- backup
- restore drill
- migration rehearsal
- production migration
- 数据 fingerprint 校验
- rollback 准备

## 测试优先级

永远优先使用成本最低的测试方式：

1. 单元测试
2. 本地服务
3. 生产数据库副本
4. 少量真实 AI API
5. staging
6. production

低成本方式可以解决的问题，不允许使用更昂贵的方式。

Cloud Build、磁盘 snapshot、完整 production backup、正式镜像发布不得用于普通 UI 或代码测试。

























# Risk-Based Testing and Real-World Verification

## 核心原则

“测试数量很多”不等于“已经覆盖真实生产行为”。

单元测试、fixture、mock、release gate 全部通过，只能证明已经覆盖的测试场景没有失败，不能单独作为“问题已彻底解决”或“可以安全上线”的依据。

Agent 不得仅因为以下内容通过，就宣称一个涉及真实业务流程的问题已经完全解决：

- npm test
- npm run check
- 数百项 unit/integration tests
- mocked provider tests
- fixture database tests
- release:check

如果真实生产问题涉及数据库历史状态、队列、浏览器操作、AI Provider、媒体、长期状态迁移或跨阶段 Pipeline，则必须选择对应的更高测试层级。

---

## 一、首先对改动进行风险分类

开始修改后，Agent 必须判断本次变更属于以下哪一类：

### UI_ONLY

例如：

- CSS
- 布局
- 文案
- 图标
- 移动端菜单
- 不改变业务逻辑的组件调整

### LOCAL_LOGIC

例如：

- 普通函数逻辑
- 数据格式化
- 本地确定性计算
- 不涉及持久化状态的判断

### DATABASE_LOGIC

例如：

- SQL
- Knowledge Resolution
- Source 状态
- Opportunity
- Recovery
- 数据投影
- 历史数据兼容逻辑

### PIPELINE

例如：

- Job 创建
- Job 状态
- Source Processing
- Claims
- Coverage
- Experience
- Knowledge
- Content Production
- Worker / Queue / Retry / Backoff

### AI_PROVIDER

例如：

- Vertex / Gemini Client
- Prompt
- JSON Schema
- Structured Output
- Thinking Level
- 图片 Batch
- Provider Retry
- 模型输入输出
- AI Token / Context 优化

### DATA_MIGRATION

例如：

- Schema 变化
- 历史数据迁移
- 存储格式变化
- 大规模 Backfill
- 数据清理
- 媒体迁移

---

## 二、根据风险选择最低足够测试层级

不得每次修改都运行所有测试。

同时也不得因为快速测试通过，就跳过本次改动真正需要的高层验证。

遵循以下原则：

小改动 → 小测试
模块改动 → 模块测试
数据库改动 → 真实生产数据副本
AI 改动 → 少量真实 Provider Canary
正式发布 → 完整 Production Replay

---

## 三、L1：Fast / Targeted Tests

适用于：

- UI_ONLY
- LOCAL_LOGIC
- 每次代码修改后的第一轮验证

优先运行受影响模块的定向测试，而不是默认运行全部测试。

例如：

node --test test/claim-resolution.test.mjs

或其他与本次修改直接相关的测试。

必要时运行：

npm run build
npm run check

目标：

快速发现语法、构建、局部逻辑和明显回归。

L1 默认不得：

- 调用真实 Vertex
- 调用真实 Kimi
- 使用生产数据库
- Cloud Build
- 生产部署

---

## 四、L2：Module Regression

适用于一个完整模块修改完成之后。

例如修改：

- Knowledge Resolution
- Source Recovery
- Content Workbench
- Pipeline
- Media Processing

应运行该模块及其上下游直接相关测试。

不要因为修改 Knowledge Resolution 就默认运行与 WordPress、Search Console、商业系统完全无关的全部测试。

如果项目已有合理测试分组，应使用测试分组。

如果没有，应逐步建立：

npm run test:knowledge
npm run test:sources
npm run test:pipeline
npm run test:content
npm run test:frontend

---

## 五、L3：Production Database Replay

涉及以下内容时必须考虑 Production Replay：

- DATABASE_LOGIC
- PIPELINE
- 历史兼容
- 状态恢复
- Knowledge
- Source Processing
- Opportunity
- Content Workbench

Production Replay 必须使用：

生产数据库的只读来源副本
↓
复制为本地 baseline
↓
再复制为一次性 work database
↓
所有修改只作用于 work database

禁止直接让本地开发代码写生产数据库。

Production Replay 默认不需要真实 AI Provider。

应优先验证确定性逻辑，例如：

- 当前真实 Knowledge 中有多少 pending review
- 新 Resolution Engine 执行后还剩多少
- 是否存在 captured but no active job
- 是否存在 processing but no active job
- 是否存在孤儿 Job
- 是否存在 current capture 与旧 Experience 混用
- 是否存在重复 Production Owner
- 是否存在已成功 Job 但缺少下游阶段
- 是否存在自动可解决却进入人工队列的事实

Agent 完成 DATABASE_LOGIC 或 PIPELINE 修改时，不得只使用小型 fixture 宣称真实数据问题已解决。

---

## 六、L4：Browser E2E

涉及实际用户操作流程时，应运行浏览器端端到端测试。

优先使用 Playwright。

Browser E2E 应模拟真实用户操作，而不是只检查 DOM 是否存在。

例如：

### Knowledge 场景

打开 Knowledge
→ 查看人工 Review 数量
→ 打开具体主体
→ 检查 24/7 / 全天 / 24 hours 是否仍被当成冲突
→ 检查 free / 0 CNY
→ 检查 Scope Split
→ 检查保存后的 UI 状态

### Source 场景

打开 Sources
→ 查看 captured Source
→ 查看当前 Job
→ 执行 Recovery
→ 等待 Pipeline 状态变化
→ 验证下一阶段确实出现

### Content Workbench 场景

打开 Content
→ 进入详情
→ 执行 Recovery
→ 验证 Recovery Target
→ 验证真实下一阶段
→ 验证错误信息是否对应真实失败原因

UI_ONLY 修改只需相关页面 E2E，不得因此跑整套业务系统。

---

## 七、L5：Real Provider Canary

真实 AI Provider 测试默认关闭。

只有以下改动需要运行 Real Provider Canary：

- AI_PROVIDER
- Prompt
- JSON Schema
- Vertex transport
- Structured Output
- Gemini model 配置
- 多图 Batch
- 模型输入压缩
- AI Retry
- AI Token/Context 优化

不得因为普通 UI、SQL 或确定性业务逻辑修改就调用付费模型。

Real Provider Canary 必须：

- 使用固定 Golden Sources
- 限制并发
- 限制最大调用数
- 禁用无关 Batch
- 控制预算
- 不使用整个生产来源库

建议 Golden Sources 至少包含：

1. 短文本来源
2. 5 张普通图片来源
3. 20+ 图片来源
4. 文字密集截图
5. 多地点复杂来源
6. 必要时视频/PDF

默认建议：

AI_CONCURRENCY_MODE=fixed
AI_CONCURRENCY_INITIAL=1
AI_CONCURRENCY_MAX=1
VERTEX_AI_BATCH_ENABLED=false

Real Provider Canary 必须验证：

- 请求是否真正到达 Provider
- Schema 是否被 Provider 接受
- 是否确认进入生成
- Output 是否满足本地 Schema
- Token 是否异常
- 是否发生 400 / 429 / MAX_TOKENS
- 实际延迟
- 必要的语义质量

Mock Provider 测试不能替代这一层。

---

## 八、L6：Full Production-Like Replay

Full Production Replay 不是每次修改都运行。

只在以下情况运行：

- 正式发布前
- 大型 Pipeline 修改
- AI 生产流程大改
- 数据库 Schema 修改
- Recovery 系统大改
- Knowledge / Content Production 顶层逻辑大改

Production-Like Replay 应尽可能模拟：

Capture
→ Preflight
→ Claims
→ Coverage
→ Experience
→ Knowledge
→ Opportunity
→ Approval
→ Assembly
→ Plan
→ Draft
→ QA

WordPress 最终写入默认使用 mock 或 staging，不允许默认写正式 WordPress。

如果本次改动不涉及 AI，可关闭真实 Provider。

如果涉及 AI，则只对固定 Golden Sources 启用真实 Provider。

---

## 九、每一个生产 Bug 都必须成为永久 Regression

用户在生产环境发现一个真实 Bug 后，修复不能只修改代码。

必须同时判断：

“如何让这个问题以后自动被测试发现？”

只要合理可行，应新增 Regression Test 或 Business Invariant。

例如：

### 已发现：

1 text + 19 images
曾导致 requiresManualStart

必须永久测试：

完整来源
+ 19 images
→ 自动进入处理
→ 不允许因为工作量进入人工启动

### 已发现：

24/7
全天
24 hours
24_hours

曾进入人工 Knowledge Review

必须永久测试：

这些值归一后：
manual review count = 0

### 已发现：

free
0 CNY

曾被视为冲突

必须永久测试：

typed semantic equality
→ 不产生人工 conflict

### 已发现：

生产 Opportunity 错绑 Job

必须永久测试：

每个 Production Job
→ 只能属于唯一明确 Production Owner

用户提供的生产截图和真实故障应逐步形成 Regression Corpus。

不要只修复当前症状。

---

## 十、建立 Business Invariants

除具体 Regression Test 外，还必须建立能够自动发现未知问题的系统不变量。

建议长期维护以下 Invariants：

### Source

complete Source
+ required original media complete
→ 不允许长期没有 active job 或明确 terminal reason

processing Source
→ 必须存在 active job、provider batch、scheduled retry 或明确 blocker

core pipeline 完成
→ 必须存在对应 persisted outputs

### Pipeline

Job succeeded
→ 必须有预期 downstream job / artifact
或明确终止原因

Job failed
→ 必须有明确 failure class
→ 不允许 UI 将失败显示为正常等待

### Knowledge

typed semantic equality
→ 不允许进入 HUMAN_REQUIRED

24/7 / 全天 / 24 hours
→ 不允许进入人工 review

free / 0 CNY
→ 不允许进入人工 review

不同 scope
→ 不允许错误强制竞争为单一事实

### Capture Version

UI 展示的媒体、Experience、Extraction、Knowledge 状态
→ 必须属于当前 capture version
或明确标为历史结果

### Production Content

approved Opportunity
→ Job / Artifact / Recovery 必须绑定明确 owner

未批准 Opportunity
→ 不允许进入 Production Workbench

这些不变量应逐步形成：

npm run audit:prod-replay

或等价工具。

---

## 十一、修复完成后必须进行 Exploratory Audit

对于中高风险修改：

- DATABASE_LOGIC
- PIPELINE
- AI_PROVIDER
- DATA_MIGRATION

在确认原始 Bug 已修复以后，还必须执行一次相邻问题扫描。

不要只问：

“这个 Bug 修好了吗？”

还要主动查：

- 是否还有同类 Source 卡住
- 是否还有无 active job 的 processing Source
- 是否有孤儿 Jobs
- 是否有重复 Jobs
- 是否有错误 version linkage
- 是否有自动可解决的 Knowledge Review
- 是否有异常模型调用数量
- 是否有异常 token
- 是否出现新 400 / 429
- 是否产生状态机断点
- 是否产生新的 UI/Backend 状态不一致

这一步称为 Post-Fix Exploratory Audit。

---

## 十二、完成标准 Definition of Done

涉及真实业务问题的任务，不得仅以：

“551 tests passed”

作为完成标准。

根据风险等级，应报告以下状态：

L1 Targeted Tests:
PASS / FAIL / NOT REQUIRED / NOT TESTED

L2 Module Regression:
PASS / FAIL / NOT REQUIRED / NOT TESTED

L3 Production DB Replay:
PASS / FAIL / NOT REQUIRED / NOT TESTED

L4 Browser E2E:
PASS / FAIL / NOT REQUIRED / NOT TESTED

L5 Real Provider Canary:
PASS / FAIL / NOT REQUIRED / NOT TESTED

L6 Full Production Replay:
PASS / FAIL / NOT REQUIRED / NOT TESTED

Post-Fix Exploratory Audit:
PASS / ISSUES FOUND / NOT REQUIRED / NOT TESTED

如果某一必要层级没有执行：

必须明确写：

NOT TESTED

不得使用：

“已彻底修复”
“完全验证”
“生产问题已经解决”

等确定性描述。

---

## 十三、避免测试过度

风险分级测试的目的不是每次都跑更多测试。

目标是：

最低成本获得足够可信度。

例如：

### 修改按钮 CSS

运行：
- frontend targeted test
- build
- Browser smoke

不要运行：
- Production Replay
- Vertex
- 全 Pipeline

### 修改 Knowledge Resolution

运行：
- Knowledge targeted tests
- Production DB Replay
- Knowledge Browser E2E

通常不要运行：
- Vertex
除非本次修改涉及 AI Claim Repair / Verification。

### 修改 Vertex JSON Schema

运行：
- Provider unit tests
- Real Provider Canary
- 相关 Pipeline integration

通常无需：
- 全量生产数据库重放

### 正式 Release

才执行当前版本要求的完整 Release Validation。

---

## 十四、Cloud 和 Token 成本控制

本地 Node Tests、SQLite Replay 和 Browser E2E 应优先执行。

不得因为存在 Codex 就把所有测试改成模型推理。

以下操作默认视为昂贵测试：

- Vertex / Gemini paid requests
- Kimi paid requests
- Cloud Build
- GCE Snapshot
- Production Backup
- Artifact Registry image publishing
- Full Production Deployment

只有对应风险层级需要时才能执行。

测试系统本身不能成为新的资源浪费来源。

---

## 十五、推荐逐步建立这些命令

项目应逐步提供：

npm run test:fast

npm run test:knowledge

npm run test:sources

npm run test:pipeline

npm run test:content

npm run test:prod-replay

npm run test:e2e

npm run test:vertex-canary

npm run audit:prod-replay

npm run test:release

其中：

test:fast
应非常快，并用于日常开发。

test:vertex-canary
默认不得由普通修改自动触发。

test:release
只在正式发布准备阶段运行完整测试集合。

---

## 十六、测试报告必须说明真实覆盖范围

Agent 最终报告不应只写：

“所有测试通过。”

应写成类似：

Change class:
DATABASE_LOGIC

Executed:
- targeted Knowledge tests: PASS
- npm run check: PASS
- production DB replay: PASS
- Knowledge E2E: PASS
- Vertex Canary: NOT REQUIRED
- full production replay: NOT REQUIRED

Real production baseline:
- manual reviews before: 259
- projected after: 12
- unresolved HUMAN_REQUIRED: 12

Known untested areas:
- production WordPress
- real Vertex generation

只有这种报告才算有效验收。