# 写作配图修复与生产发布验收（2026-09-29）

Change class: PIPELINE / DATABASE_LOGIC / AI_PROVIDER。发布方式：CODE_ONLY_RELEASE，schema 83 不变。用户要求优先修复写作配图并部署上线，且明确全部来源实景图均已授权。

## 已发布行为

- 策略 3.9 及后续版本的正文使用授权来源原图，禁止 AI 生成景点场景补位。模型即使输出生图提示，计划归一化与生图调用入口也分别拦截。
- 不因缺少逐张授权字段拒绝原图；保留来源、采集版本、文件指纹、相关性与像素内容检查。
- 来源标题只用于排列待识别图片，不能证明图片拍摄地点。原图质量审计也不能替代画面识别。图片说明来自实际画面。
- 已识别的来源图片复用结果，不因识别版本升级反复付费。缺图识别采用有上限的调用预算，失败不无限自动重试。
- 专题来源的原图优先检查，避免被大量城市攻略卡片挤出候选范围。攻略卡片不得冒充景点外观；精确地点要求仍须满足。
- 显式照片编号与来源说明可以用于建立来源关系。同一地点别名存在历史歧义时，只允许作为正文已提及地点的上下文照片，不把它认定为精确入口、建筑外观等证据。
- 来源实体解析每次处理两页后让出队列；业务质检或过期输入错误不再降低全部任务的模型并发。界面正确标注来源解析使用 DeepSeek。

## 发布身份与回滚

- 版本：2.0.72；patch SHA256 `e5e00c6c4dd345ba7667d6405c4603977503597e69b4bd306a12af1dde0e3155`。
- 镜像：`asia-east1-docker.pkg.dev/project-4bcb9146-c37b-43b0-b11/solo-to-china/engine@sha256:80656dbb625ef00c6590663d7f253afd1d2d2d147033ebc3d4e198f95998a999`。
- Cloud Build：`faf3e87b-52ea-4bd1-a941-97d1eb9fc145`，SUCCESS。
- API 与 worker 均已切换。公开 readiness、采集 Origin 验证、品牌文件校验通过。切换流程 12.81 秒；启动 metadata 已更新并读回验证。
- 保留 `engine-before-writing-media-20260929` / `engine-worker-before-writing-media-20260929` 及旧镜像 `sha256:4f85ae895d0b7745a0607b65178ff78df9066f4c1721cf376e2812a98827579f`。
- 回滚材料在服务器 `/opt/solo-to-china/code-releases/writing-media-20260929`：原环境文件、原 startup script、原容器配置。回滚需停止新 worker/API、恢复旧容器名称及 `solo-to-china` 网络、恢复 restart policy、环境与 startup metadata，再启动并检查 readiness。旧镜像不会识别本次修复的全部语义，恢复已处理媒体应单独评估，不能盲目重跑历史文章。
- 未 commit/push；未迁移 schema、执行历史全量 backfill、创建磁盘快照或清理生产 Docker 镜像。

## 真实覆盖范围

| 层级 | 结果 | 范围 |
| --- | --- | --- |
| L1 Targeted Tests | PASS | 定向媒体测试；最终图片身份与手写卡片回归 44 项通过；check/build 与 diff 检查通过 |
| L2 Module Regression | PASS | 相关模块组合 147 项通过；最后媒体改动另有 75/80 项定向复测和最终 44 项回归 |
| L3 Production DB Replay | PASS | 只读生产副本的独立工作库；88 来源、1,546 资产、6,457 claims、14 草稿、12 发布记录；仅工作库修改 |
| L4 Browser E2E | PASS | 本地真实 Content → 南滨路详情 → 视觉资产 → 原图预览，实际载入 1080×1440；上线后另核验原图接口及字节哈希 |
| L5 Real Provider Canary | PASS（限定范围） | 2 次 Vertex 原图识别、2 次写作 canary。第一次写作的严格原始提示断言失败，随后按实际归一化链路验证通过；不宣称模型原始输出始终合规 |
| L6 Full Production Replay | NOT TESTED | 已完成媒体阶段从缺图、识别、选图、落库到成功的专项生产数据重放及重复执行；未重放完整 Capture→WordPress 全链路 |
| Post-Fix Exploratory Audit | ISSUES FOUND | 南滨路完成；博物馆在有界识别后仍未得到合格实景图，已终止并明确显示预算耗尽；没有活跃或重复生产任务 |

生产副本省略大体积 raw HTML、原始 payload、内嵌图片、source family 分析 JSON、会话及凭据；保留正文、资产关系与业务状态。媒体重放只提供核验过的固定原图，不代表对全部 1,546 张图片做了真实模型识别。重放使用真实 canary 返回值，新增付费调用为 0，WordPress 记录不变。

写作 canary 原始输出仍可能带不可靠地点说明和描述性生成提示；确定性归一化拒绝不符合要求的槽位。因此本次防线不只依赖 prompt。

## 线上文章核对

南滨路 `draft_22d92a74cf014b279c9d55e5bff0e6bb`：

- 图片任务 `job_fbb90b412d034bae996af3a34a099fb5` 已成功。
- 选用 `asset_5119c401ff26454ca624f774356edea7`，`use_authorized_source_image`，原始 WEBP 1080×1440。
- 线上预览 HTTP 200，SHA256 `9796d6e0b9ac7ccb4d7f8e3e9c455756b5398b47ec74e8fd303d976a6b549876` 与留存原图一致。
- 说明描述四人在栏杆处眺望隔江夜景，不虚构精确机位。图片专项恢复时未重新生图、重写正文或发布 WordPress。

## 页面编排续接（22:18 CST）

图片专项恢复使用了不执行后续页面编排的进程配置，因此图片任务成功后没有创建 `compose_frontend_page` 子任务。生产状态在最近一次任务更新后的 15 分钟内把这一断链暂时标为“等待中、系统会自动继续”；这个说明对该记录并不准确。超过宽限期后才显示可恢复的流程中断。

已按生产恢复入口为南滨路创建一次页面编排任务 `job_3e8a0ccc37434487ba96aaad86316cee`，生产 owner 和草稿均核对，操作幂等键 `writing-media-release-20260929:continue-nanbin-page`。22:18 CST 查询时任务已由 worker 领取并运行；原图仍为同一资产，WordPress 发布记录仍为 0。首次恢复接口客户端超时，但服务端后来完成提交；后续查询到幂等操作记录与唯一任务，故未再重试。该任务的最终结果以实时队列为准。

三峡博物馆 `draft_891d814afe4941cbb9097a845a0279fd`：

- 图片任务 `job_bc62b15da53b4adcb0bad3984976046f` 于 22:06:38 CST 以 `MEDIA_BUDGET_EXHAUSTED` 明确终止；没有无限重试，也没有生成替代景点图。
- 本轮识别的 3 张图分别是多景点预约说明、三日游攻略卡片、多景点手写攻略，均不是已核验的博物馆外观照片。之前的多景点手写卡片已从原选择中排除。
- 88 条来源中没有标题直接指向三峡博物馆的专题来源。这不证明其他来源完全没有博物馆照片；本次没有付费扫描全部图库。
- 当前仍需确认相关实景图。该文章的图片恢复没有完成，不能宣称全部生产问题已经解决。

## 成本与队列调查

此前大额 DeepSeek 调用来自 `resolve_entities` 任务 `job_1bed52a234fe4bdea0e49065dfbbda79`：55 次调用（50 成功、5 失败），合计 3,651,753 tokens。这个任务是来源实体解析，不是正文写作或生图。单任务长时间处理多页、曾发生 worker OOM，以及业务失败错误降低全局并发共同影响队列推进。

实际写作、质检、图片识别使用 Vertex `gemini-3.8-flash`；图片生成配置为 `gemini-3.1-flash-image`。已看到真实 Vertex 调用回执，不能根据赠金页面暂时未变化认定没有调用；未对账确认赠金显示原因。

22:08:31 CST 最终上线后审计：3 次 Vertex 原图识别、0 次 DeepSeek、0 次图片生成；12 条发布记录；活跃任务 0、重复活跃生产 owner 0；新 API/worker 均正常、0 次重启、无 OOM。唯一新失败是上述博物馆预算耗尽。线上南滨路原图预览再次校验通过。

本次验证生成的一次性服务器工作库已删除，保留 baseline 和本地压缩副本；释放约 697 MB，生产磁盘剩余约 1.7 GB。未删除生产数据库或媒体。

原始证据位于工作区 `output/writing-media-release-20260929/`，包含发布身份、镜像验证、canary、重放、线上恢复、预览字节校验与审计结果。
