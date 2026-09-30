# 内容生产中断：开发修复与验证（2026-09-30）

Change class: PIPELINE / DATABASE_LOGIC / AI_PROVIDER。DEVELOPMENT 模式；schema 未改变。没有 commit、push、Cloud Build、生产部署、生产数据库写入或 WordPress 写入。

## 根因与生产证据

只读排查时，API 与 worker 均 running、RestartCount=0、OOMKilled=false；队列无 queued/running 任务。此次中断发生在业务阶段。

1. 重庆动物园：`job_ce76b4c0bf064bcda9ba70eb10192790`，`plan_content`，`article_bundle_v1`，失败码 `DRAFT_EVIDENCE_VALUE_INVALID`。正文遗漏受保护证据值 `08:30-09:50` 和 `15:00`。合并生成流程没有旧版 Editorial Assembly，但状态投影仍要求该前置产物，因而把真实写作失败降为“素材组装未完成”，恢复目标也转回旧链路。恢复排队还会默认创建 legacy 任务。
2. 罗中立美术馆：`job_652a01420e7248348443a083af0ec2b4`，`generate_visuals`，`MEDIA_DISCOVERY_BUDGET_EXHAUSTED`。旧代码把三次原图检查设为整个任务上限，即使存在未检查候选图也立即永久失败。尚未证明剩余原图中存在符合本篇相关性与质量要求的照片。

## 修复

- 按当前 owner 和 scope 重置后的生产任务版本构建阶段依赖；bundle 流程不再依赖旧 Assembly、Narrative、Writing Packet 或 Page Plan 记录。真实失败保持 failed，并指向 `plan_content`。
- 恢复沿用原 `pipeline_version` 和唯一 production owner，保持幂等；生产重放审计增加版本不变量。
- bundle 对证据范围、受保护值、正文结构失败，最多进行一次携带具体错误的纠正。第二次不合格继续阻止持久化；403、网络等 Provider 错误不进入内容纠正。
- 选图每批最多三张，在同一个 durable Job 中继续；总检查调用上限为十二次，调用计数包含 Provider 请求失败。保存的分析结果复用，分批等待不消耗任务重试次数。没有候选图或达到总预算仍会明确停止，不会使用无关图或生成替代景点图。
- 错误文案不再声称历史初稿已经做过定向修订。

## 测试与真实覆盖

| 层级 | 状态 | 已覆盖范围 |
| --- | --- | --- |
| L1 Targeted Tests | PASS | 证据漏写、纠正上限、Provider 错误、阶段版本、恢复幂等、分批选图等定向回归；check/build 与 diff check |
| L2 Module Regression | PASS | 内容、生产状态、恢复、媒体预算、视觉规划及直接相关 pipeline 回归：160 项 |
| L3 Production DB Replay | PASS（限定范围） | 当前只读生产依赖投影 → 本地不可变 baseline → 独立 work；17 个生产/历史 owner，两个故障的真实状态与恢复目标、幂等和 owner/version；正文及 WordPress 记录保留。没有执行美术馆全部媒体处理 |
| L4 Browser E2E | PASS（限定范围） | 登录本地副本 → 内容列表 → 实际点击两条记录的重试按钮 → 确认正确阶段 → 排队。动物园再用真实 canary 返回值执行本地 worker，实际保存 Brief/Draft 并创建唯一 `generate_visuals` 下游任务，浏览器刷新显示图片处理排队 |
| L5 Real Provider Canary | PASS（限定范围） | 固定动物园真实 planning package，1 次 Vertex `gemini-3.8-flash` 请求，70,984 ms；结构与证据校验通过，正文和 ledger 保留两个受保护时间。输入 27,638、输出 8,932、thinking 1,621，总 tokens 38,191。未出现 400/429/MAX_TOKENS |
| L6 Full Production Replay | NOT REQUIRED | 本次为定向修复；未进行 Capture 至 WordPress 全流程或正式 Release 验证 |
| Post-Fix Exploratory Audit | PASS（限定范围） | 当前来源状态：82 processed、2 manual_article_stored、6 media_only；没有 processing 且无 active job 的 Source，没有成功 bundle 但无 Draft 的断点；恢复副本无重复 active owner 或孤儿 production job |

生产投影省略账号/会话/凭据、runtime settings、raw HTML/payload 和内嵌 AI derivative；保留业务事实、原文、状态及关系。baseline 与初始 work SHA-256 相同，SQLite integrity_check=ok。复制和修改全部发生在本地，未在生产上创建完整数据库 backup。

首次本地 Vertex 请求因网络传输失败，没有模型结果；随后通过既有云端网络执行独立 canary 进程，最多允许四次 dispatch，实际一次成功。新代码仅在该独立进程内加载，生产 API/worker 代码及容器未替换；canary 没有连接生产数据库。它验证了首次生成与受保护值校验，真实 Provider 的第二次纠正分支未触发，仅由永久回归覆盖。

永久回归还验证：前三张无关、第四张相关时，worker 重启后只检查第四张，选用通过现有相关性检查的原图并创建页面编排任务；该用例使用已有 3.8 视觉匹配 fixture，3.9 的严格媒体身份/相关性门槛由视觉规划模块回归覆盖，未被放宽。

## 已知限制与上线状态

- NOT TESTED：美术馆剩余真实原图的完整像素识别与最终选图；动物园独立内容 QA；生产恢复执行；实际 WordPress 写入。
- 不保证所有内容永不中断。缺少合适原图、模型连续不合格、Provider 或基础设施故障仍应明确停止；本次防止的是三张图后过早停止、bundle 证据错误没有纠正，以及状态/恢复切换到错误旧链路。
- 修复尚未部署，生产中的两条记录没有被本次开发任务恢复。必须收到明确“部署到生产”或“发布到生产”指令才能进入 RELEASE 模式。

本地详细证据：`output/production-interruption-20260930/`（忽略目录），包括只读线上诊断、baseline identity、重放、测试日志、canary、浏览器截图和实际下游任务。
