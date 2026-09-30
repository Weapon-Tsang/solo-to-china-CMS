# 机会阶段英文编辑标题验收：2026-09-30

Change class: AI_PROVIDER / PIPELINE / DATABASE_LOGIC
Release class: CODE_ONLY_RELEASE，版本 2.0.74（2.0.73 已正式上线），schema 保持 83。

用户明确要求机会阶段生成具体英文标题，并授权完成验收、提交、推送、部署到生产。当前状态：2.0.74 已完成正式上线，health/readiness 通过，正式拟题正在完成剩余机会。

## 问题与改动

旧 evidence-v1 根据事实字段拼接固定列表，导致 Booking, Costs, Opening Hours 等标题再次出现。改为 writing runtime 的 compose_opportunity_titles 阶段，输入当前可用事实的真实值、范围、限制和关联当前 Claims 的 grounded Experience；每批最多六个机会，每个机会最多 48 条事实。输出包含英文标题、编辑角度、读者承诺和可核对的事实键。

仅处理 ACTIONABLE、未批准、未绑定候选、装配或生产任务的 Knowledge 机会。已批准内容保持原有标题。证据指纹变化后重新拟题；批准时再次检查指纹。生成标题不批准机会、不创建正文、不写 WordPress。刷新和重复请求复用当前有效结果。

模板、中文标题、纯主题名、重复/未知 ID、未知证据键会在模型缓存及 durable receipt 写入前被拒绝。第一轮真实模型返回 Hours, Booking, and Metro Access 变体，已加入拒绝规则及永久 Regression；第二轮固定样本通过。失败可显式重试。UI 显示读者承诺及排队/失败状态，标题未完成时禁止批准。正文阶段的泛化标题回退到已批准的具体标题。

## 验证范围

| 层级 | 状态 | 覆盖 |
| --- | --- | --- |
| L1 Targeted Tests | PASS | 标题校验、身份保持、证据变化、批准竞态、owner 保护、分批、失败重试、正文回退 |
| L2 Module Regression | PASS | 内容 Pipeline、Provider schema、模型阶段策略、版本及构建；最终 release gate 另有完整日志 |
| L3 Production DB Replay | PASS（限定） | 当前生产只读标题依赖投影 → 本地 baseline → 一次性 work；1,463 机会、19,884 jobs、5,235 facts；真实模型六个输出仅更新 title/coverage_json，其余机会字段及所有其他投影表 fingerprint 不变；未做完整数据库备份 |
| L4 Browser E2E | PASS（本地） | 真实本地 API + 模型 mock：生成、模板拒绝、失败提示、重试、批准恢复、暂缓及刷新保持；320/768/1024/1440 无横向溢出或 console error |
| L5 Real Provider Canary | PASS | GCE 网络上隔离容器，仅挂载 work 数据库；固定六个重庆机会，gemini-3.8-flash，第二轮单次请求，schema 接受且本地校验通过；生产写入 0 |
| L6 Full Production-Like Replay | PASS（模拟） | 授权来源 Capture → Extraction → Knowledge → Opportunity → 拟题 → 人工批准 → 正文 Pipeline → QA → mock WordPress 草稿；legacy、article_bundle_v1 和 editorial-v2 路径；不代表全生产来源真实 AI 链路已测试 |
| Post-Fix Exploratory Audit | ISSUES FOUND（既有） | 当前投影 owner orphan=0、running jobs=0；旧归档有重复历史标题；扩展城市 fixture 揭示既有 Knowledge review_type CHECK 不兼容，未扩大本次发布修改范围 |

当前只读 baseline SHA256：ef015788755a700b6ebbd5d395a3c981d06b508bd21ef1bfc77c5bc92a59af13。

第二轮模型 39,672 input tokens、1,807 output tokens、14.7 秒、实际延迟和 usage 以 output/title-release-20260930/vertex-canary-final.json 为准（验收报告保存原始 usage，不估算未知费用）。没有 400、429 或 MAX_TOKENS。首次本机请求连接失败，未产出模型结果；随后两次 GCE 隔离请求各六个机会，首轮用于发现漏网列表，第二轮用于最终验证。

具体样本包括：Yangtze River Cableway: Boarding from Shangxinjie on the South Bank to Cut Waits；Chongqing Zoo: Early East Gate 2 Entry for Morning Panda Activity；Luo Zhongli Art Museum: Two-Day Booking Rule and Monday Closures。数字和限制对应原始引用证据，仍由编辑在批准前审阅。

## 发布边界

候选和现有生产均确认 schema 83，使用显式 unchanged-schema guard 的 code-only-release.sh。隔离初始化及 readiness 后再切换 API/Worker，保留上一版本容器和不可变镜像。启动关闭历史 reconciliation。更新运行镜像和 VM 的既有 verified-container 启动检查，避免重启时仍要求旧 digest。无需数据库迁移、生产备份、磁盘快照、镜像清理或 WordPress 写入。

尚未覆盖：生产 WordPress 写入、浏览器真实新来源采集、整库真实 AI Capture→QA、SEO/流量结果。L4 的本地模拟和 L6 的 mock 输出不能用于声称这些方面已经验证。

本地证据：output/title-editorial-20260930/ 与 output/title-release-20260930/，包括 targeted-tests.log、full-pipeline-debug.log、current-replay.json、semantic-evidence.json、vertex-canary-final.json、release-check-final.log。原始生产依赖投影和模型输入不提交到 Git。

## 2.0.73 实际发布与 2.0.74 性能补丁

2.0.73 代码提交并推送：4716ea5a42434fb76a47198eb3cd64d6be24bd6f。不可变镜像：sha256:89bce345108a93acf34278146fd403313047da0b47165b3eb9b2f4365e0caf86。2026-09-30 公开 health/readiness 均返回 2.0.73；API/Worker 镜像一致、startup reconciliation=false；上一版本保留为 engine-before-4716ea5a 和 engine-worker-before-4716ea5a。VM verified-container 启动检查同步更新，无重启、迁移或生产备份。

正式 admin 拟题 endpoint 返回 202、三个目的地队列。真实模型生成了具体英文标题。上线后的 fingerprint 对比：189 条受保护机会、14 篇草稿、31 个候选、14 条 WordPress 记录、90 个来源的状态/版本投影、5,235 个 Knowledge 的值/状态投影全部保持不变。owner orphan=0、同目的地并发重复拟题 jobs=0；当前工作只在正常机会拟题队列运行，不批准、不创建正文、不写 WordPress。

真实生产 batch 后期从约 24 秒增长到 142 秒，而 Provider 调用仍约 10–12 秒。相邻扫描发现 title package 为每个已拟题机会重复检查当前媒体完整性和来源 families，导致同步耗时随已完成记录增长。2.0.74 在每次同步 package/save 内共享 createFamilyProjectionContext；跨 jobs 不复用。原六个真实 Golden 样本的完整输入 SHA256 在优化前后完全一致：679aeeea7f6c8497d146529dedb69ca109e8d90d7577b60ba5a445ae2afcc2dc。因此无需为没有改变的 Prompt/Schema 重复付费 Canary；仍通过正式队列的真实调用确认发布后行为。

2.0.74 定向标题/正文链路测试 22 项通过，完整 unit/integration 1,207 项通过，最终 release gate 50 项必需检查通过、0 失败；隔离镜像的 API/Worker 启动、网络切换及跨挂载回滚演练通过。生产浏览器完整交互 NOT TESTED：内置浏览器停在登录页面，Chrome 连接超时；已完成本地浏览器 E2E 和生产 authenticated API 验收，不能将这两者称为生产浏览器 E2E。

## 2.0.74 正式切换

代码提交并推送：9efe631df175f37e67012c131572f0ef031445e6。不可变镜像：sha256:12da2f785eca53bd0a95f18d8e364299f7e796cf47956f8ab7d2a5f1f940bd84。公开 health/readiness 返回 2.0.74，schema=83；API/Worker 和 VM verified-container 启动检查均已固定到新镜像。上一版本保留为 engine-before-9efe631d / engine-worker-before-9efe631d，2.0.72 容器也未清理。

新版本真实拟题 batch 已验证：9,921 / 12,950 / 13,610 / 14,343 / 12,447 毫秒，相比旧慢 batch 的 141,789 毫秒显著降低。首屏实际 20 项全部 editorialTitle=ready，facet-list template=0，已生成标题中文=0、完全重复=0。一个旧后续 batch 被严格校验拒绝，使用正常重试入口返回 202 并成功继续队列；旧失败记录作为历史保留，拒绝结果未成为可批准标题。

最终全部机会数量和 Post-Fix Audit 以同期 summary JSON / 本地 final audit 为准。生产 WordPress 写入、浏览器真实采集、全库真实 Capture→QA 不在验收覆盖内。


## 2.0.75 signage regression

2.0.74 normal production generation reached 177 of 198 pending opportunities. Four semantic-rejected batches were retained as failed job history; no invalid output became an approvable title. Two consecutive failures on the same six inputs triggered bounded diagnosis rather than continued blind retries.

One isolated real-provider diagnostic (production writes=0) confirmed that a proposal copied the Chinese signage “我在重庆” into an otherwise English title. The output validator correctly rejected it. The prompt now requires 12–140 characters, forbids Chinese characters in titles including quoted signage and parenthetical names, and translates or describes signage in English. Evidence retains original text. The output validator and current ready-title hashes remain unchanged.

A second bounded canary used the same six blocked current production inputs with the patched prompt: PASS, one dispatch, 5,084 input tokens, 930 output tokens, 9,630 ms, production writes=0. All six proposals passed the unchanged local semantic validator. Targeted title/editorial/content-chain tests: 23 PASS, including permanent quoted-signage and parenthetical-name regression. Final production counts and 2.0.75 deployment evidence will be appended after the immutable release completes.
