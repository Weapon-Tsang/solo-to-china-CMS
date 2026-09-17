# SoloToChina Content Production Strategy 3.0

状态：superseded（历史快照；当前规则见 CONTENT_PRODUCTION_STRATEGY_3.1.md）；生效日期：2026-09-12。应用 2.0.5；schema 59。唯一版本清单为 `config/content-strategy.json`。

## 2.0.4 运行约束补充

- Writer 返回多少个有效视觉方案，就只保留多少个；`target` 仅作建议，不得补齐占位图。零视觉文章可以通过编辑质量检查。
- 当前没有地图和信息图渲染器，`map_or_route` 与 `infographic` 不进入执行计划，也不降级为插画或阻塞任务。
- 实景图只允许使用持久化原件且来源与资产均经所有者确认并允许发布。`localize_source_image` 只能翻译画面内中文，必须落地真实本地文件并完成 WordPress 上传，不能改变事实场景。
- 内容页只展示已经进入生产且存在任务、Brief、Draft 或发布记录的项目。仅批准、等待证据、系统推荐或历史测试数据不得占位。
- 知识库内统一处理严格冲突、Claim 提取复核和实体判断；商业资产默认只展示 operational 数据，零有效资产属于正常状态。

## 目标

系统将人工选择并明确授权的来源，转化为可追溯的研究资产、可执行的内容机会和只到 WordPress 草稿的生产结果。它不自动发现来源、不绕过网站访问控制、不自动发布，也不把来源正文或数据库记录直接倾倒成文章。

## 来源与媒体

小红书采集必须保留完整正文、DOM、作者、来源身份以及发现的全部图片和视频。媒体分别记录发现、原件耐久化和 AI 可读性；远程 URL、缩略图或衍生图不能冒充已保存原件。图片和视频原件通过校验 MIME、大小、SHA-256 的分块上传落到持久化目录。只要任一已发现媒体原件未达到 `ORIGINAL_STORED`，来源抽取就保持阻塞。

扩展提供三种互不混淆的动作：Incremental 只处理新收藏，Repair 只修复 CMS 清单标出的历史缺口，Full 同时遍历历史并修复缺口。服务端优先尝试公开 URL 恢复；需要登录态或 URL 失效时，清单明确要求浏览器重新采集。所有回填均有运行记录，且默认 dry-run。

## 研究语义

Claims 保存可核验的原子陈述。Claims 之后运行独立的 Experience 提取，将路线、步骤顺序、条件、权衡、提醒、替代方案和旅行者决策逻辑保存为 Experience Blocks。每个 Block 必须引用本次来源的 Segment，并至少引用有效 Claim 或 Evidence Span；无法满足溯源条件的内容不得入库。Experience 不覆盖 Claims，也不直接写入目的地事实共识。

Knowledge 变化是内容机会的主要事件源。一个主题达到当前证据和独立来源门槛时可以新增或刷新多来源机会；证据失效时只改变机会状态或提出更新建议，不静默删除历史研究。

## 建议与机会

来源诊断可以提出 `ARTICLE_CANDIDATE`、知识沉淀或研究缺口，但“建议”收件箱只显示当前可执行的文章机会。一个来源可以同时形成 `SOURCE_ADAPTATION`、`TOPIC_FEATURE` 和 `MULTI_SOURCE_SYNTHESIS` 路线，每个方向独立批准、暂缓或忽略，批准其中一个不会消耗其他方向。

每个机会具有 `recommended → approved → producing → finished` 主生命周期；失败后进入 `recommended_again`，证据不足的已批准机会等待 Knowledge 事件自动恢复。与已发布内容的关系必须显示为 `NEW`、`UPDATE`、`EXPAND`、`MERGE` 或 `SKIP`，任何操作都需要编辑批准，禁止自动修改线上文章或自动发布。

## 写作流水线

批准且证据就绪后依次生成：

```text
Editorial Assembly → Narrative Plan → Writing Packet → Draft → independent QA → delivery composition
```

Editorial Assembly 只选择服务本次读者承诺的 Facts、Experience Blocks 和 Sources。Narrative Plan 负责开场任务、因果推进、路径顺序、条件分支、权衡和结尾决策。Writing Packet 将上述选择渲染为面向写作者的可读说明，保留证据 ID 但不暴露数据库 dump。Draft 模型不得接收全库数据。

QA 将字数视为软信号，短而完整的文章允许通过；FAQ 仅在真实帮助读者时出现。代码与模型检查统一识别 `DATABASE_DUMP`、`GENERIC_AI_TRANSITIONS`、`REPETITIVE_EXPLANATION`、`UNIFORM_SECTION_RHYTHM`、`EXCESSIVE_HEDGING`、`NO_TRAVELER_DECISION`、`NO_CAUSAL_FLOW` 和 `FAKE_FIRST_PERSON`。正文 QA 与媒体可用性分别判定，媒体故障不能触发正文重写。

## 失败学习与人工反馈

普通生产失败达到有界终态后，系统创建 Failure Lesson，取消同次生产的剩余任务，删除 Brief、Draft、Narrative、Writing Packet、页面和投递等瞬态产物，保留 Sources、Claims、Knowledge、Experience 和编辑经验，并将机会送回 `recommended_again`。数据库损坏、认证、配额、网络等系统故障仍进入系统异常；媒体缺失进入媒体修复而不删除正文。

编辑可对草稿记录“满意、AI 味重、太啰嗦、信息太平、像数据库、结构不好、很好”等反馈，并保存 Golden Article。反馈作为可追溯的 Editorial Lesson 供后续 Assembly 和 Writing Packet 参考，不允许无边界地复制历史文章。

## 运维与信息架构

后台顶级菜单固定为：来源、建议、内容、知识库、商品、设置。系统健康、WordPress、异常、迁移、回填、Experience、Failure Lessons 和 Golden Articles 都是设置中的高级能力，不新增顶级技术菜单。

队列优先级从高到低为：交互操作、来源完成与媒体修复、覆盖审计和关键知识重建；Experience、诊断、机会重算和已批准生产；普通维护；历史回填。等待超过 15 分钟的任务仍获得年龄公平提升。

## 不变的安全边界

- 原始来源、证据、Claims、Knowledge 与 Experience 不因内容生产失败而删除。
- Commercial 数据不进入 Research 或 Writing Packet。
- 真实场景缺图时不生成伪纪实图片；地图与信息图只从验证数据确定性生成。
- WordPress 始终只接收草稿；已发布内容的更新必须再次人工批准。
- 历史破坏性清理必须先生成 dry-run 报告，并用该报告 ID 明确批准执行。
