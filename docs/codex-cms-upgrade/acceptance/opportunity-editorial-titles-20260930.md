# 机会阶段英文编辑标题验收：2026-09-30

Change class: AI_PROVIDER / PIPELINE / DATABASE_LOGIC
Release class: CODE_ONLY_RELEASE，版本 2.0.73，schema 保持 83。

用户明确要求机会阶段生成具体英文标题，并授权完成验收、提交、推送、部署到生产。当前状态：发布前验收，正式切换记录将在发布后补充。

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
