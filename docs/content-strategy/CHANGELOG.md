# SoloToChina Content Strategy changelog

## App 2.0.40 / schema 73 - 2026-09-18

- Keep Strategy 3.7 unchanged while making independently QA-passed generated visuals immutable.
- Exclude destination-wide collage/map fallbacks whose article coverage is below the strengthened threshold.
- Reuse the verified promoted candidate locally when the legacy Ciqikou visual plan is restored.

## App 2.0.39 / schema 73 - 2026-09-18

- Keep Strategy 3.7 unchanged while requiring stronger article-level relevance for fallback media.
- Remove a previously stabilized weak fallback instead of allowing generated alt text to become circular relevance evidence.
- A qualified article may use fewer visuals than its editorial target when no second relevant authorized asset exists.

## App 2.0.38 / schema 73 - 2026-09-18

- Keep Strategy 3.7 unchanged while making visual fallback selection converge across retries.
- Regenerate after conclusive visual QA failure instead of reusing the same failed candidate bytes.
- Skip redundant no-analysis media normalization; this code-only release introduces no schema migration or bulk recovery.

## App 2.0.37 / schema 73 - 2026-09-18

- Bounded prose repair preserves the current visual plan and only re-enters image generation when a slot is still planned or failed.
- Production state counts planned visual rows as pending, and previously promoted candidates with passing QA can be reused without another provider request.

## App 2.0.36 / schema 73 - 2026-09-18

- Keep Strategy 3.7 unchanged while freezing an existing generated visual plan across page composition.
- Recover a missing required media manifest from image processing without rewriting approved article content.
- This code-only release introduces no schema migration, historical bulk repair or WordPress publication.

## App 2.0.35 / schema 73 - 2026-09-18

- Keep Strategy 3.7 unchanged while tightening asset-level relevance, destination-topic fallback matching and itinerary/map routing.
- Capacity-check dense text cards before provider translation and retain deterministic failure attribution.
- Production recovery remains targeted to the approved Ciqikou Opportunity; there is no schema migration or bulk historical replay.

## App 2.0.33 / schema 73 - 2026-09-17

- Activate Strategy 3.7 role-isolated model routing and immutable per-Job provider profiles.
- Add encrypted DeepSeek/OpenAI credential state, manual Luna dispute review and fixed Vertex writing/image roles.
- Preserve frozen Draft QA when Knowledge changes and keep approved evidence-waiting reconciliation idempotent.
- This release does not insert production API keys, activate a new extraction provider, replay historical work or run a real-provider canary.

## App 2.0.32 / schema 72 - 2026-09-17

- Activate Strategy 3.6 evidence-complete production diagnostics, visual provider subcall accounting and immutable post-transform QA checkpoints.
- Add revision-safe Affiliate Asset editing, semantic content hashes, old/new impact calculation and article/slot/delivery usage tracking while keeping plain saves isolated from production execution.
- Preserve evidence, prose, media, last-good delivery and WordPress identity. Production deployment is authorized; historical record recovery is not automatic and remains dry-run plus explicit selection.

## App 2.0.31 / schema 71 - 2026-09-16

- Activate Strategy 3.5 image-level persistence, verified media transforms, media-only repair, vertical mobile TOC, and two-level commercial placement.
- This is a development change only. No production migration, enqueue, WordPress mutation, commit, push, or deployment was performed.

## App 2.0.30 / schema 70 - 2026-09-16

- Preserve the stable page identity during delivery-only recomposition so a refreshed layout cannot detach an existing WordPress draft.

## App 2.0.29 / schema 70 - 2026-09-15

- Activate Content Production Strategy 3.4 for reader-task page composition, shared visual classification/pixel qualification, scoped final preview, and versioned commercial overlays.
- Preserve approved scope, frozen prose/evidence, QA, media successes, production ownership, leases, finite retries, `recovery_run_id`, and draft-only WordPress delivery.
- Add a read-only-by-default delivery repair/audit path. This development entry does not authorize production migration, enqueue, WordPress mutation, commit, push, or deployment.

## App 2.0.28 / schema 69 - 2026-09-15

- Apply the current Quality Review issue taxonomy to historical review projections without altering the preserved provider/audit response, keeping Workbench and Recovery aligned on the actual mandatory Brief repair target.
- Fail closed when a production runtime omits `DATABASE_PATH` or would create a missing database implicitly. This deployment guard does not change Strategy 3.3 editorial behavior or enqueue production work.

## App 2.0.27 / schema 69 - 2026-09-15

- Treat automatic QA convergence as a bounded recovery-run concern rather than a lifetime Draft counter; historical repair attempts remain auditable but cannot strand a current approved production flow.
- Canonicalize a reviewer alias that cites a mandatory Brief id to one mandatory-requirement blocker and restore fact-bearing requirements only from the frozen fact/ledger scope.

## App 2.0.26 / schema 69 - 2026-09-15

- Preserve the current independent quality review as the recovery authority for its immutable Draft revision; never replace its mandatory checks or explicit blockers with an empty diagnostic review.
- Treat unsupported assertions as atomic value-level failures. QA must distinguish a selected, ledger-backed fact from another same-predicate fact outside the frozen article scope.
- Give bounded repair the exact unsupported assertions and only the article's frozen fact allow-list. Repair may remove invalid factual mappings but may not import global Knowledge that was not selected for this production instance.
- Keep Strategy 3.3, `production_state` 2.0 and Frontend Contract 1.4.0 unchanged. No Source, Claim, Evidence, Experience, approval, Draft history or Failure Lesson is deleted, and delivery remains WordPress draft-only.

## App 2.0.24 / schema 69 - 2026-09-14

- Ensure every explicit or automatic Draft regeneration consumes the current QA blockers and cannot reuse the failed writer artifact under a different recovery dedupe namespace.
- Preserve the frozen evidence scope while sending each fact once with bounded evidence excerpts and compact grounded experiences; independent review consumes only reader-visible content and traceability required for editorial judgment.
- Bound Narrative Planning independently to the approved outline, selected fact provenance and selected Experience Blocks. Complete destination Sources, media inventories, historical attempts and lessons can no longer expand a single planning request to six-figure token counts.
- Promote exact planned labels to semantic H2 sections and fail closed when an evidence-bearing planned section is still absent after one structured correction, keeping visible prose and evidence ownership synchronized.
- Treat the seven approved records as a permanent production regression corpus: current Opportunity ownership, exact-stage recovery, durable input immutability, QA supersession and WordPress draft-only delivery are system invariants for every later approval.
- Seed relevant authorized visuals before freezing the visual/page dependency snapshot, preventing deterministic source selection from invalidating its own Job and requiring a duplicate retry.
- Admit a provider response to the local completion cache only after the stage's semantic validator accepts it. Rejected Draft structure cannot be replayed as a fake retry, and every evidence-bearing approved heading is now an explicit writer contract.
- Preserve Brief adaptation, conflict and verification requirements in both full-Draft and bounded-repair DTOs. QA explicitly audits every mandatory requirement, cannot downgrade its omission to a warning, and recent blockers remain revision guardrails instead of being forgotten after the next rewrite.
- Reserve the QA stage's output budget for its compact audit instead of hidden MEDIUM reasoning. The review DTO now removes duplicated Brief/Canonical data and repeated evidence metadata, bounds issues/checks/unsupported claims, and a reasoning-stage `MAX_TOKENS` gets one explicit LOW-thinking retry with complete attempt telemetry.
- Escalate a content blocker repeated across consecutive revisions from bounded repair to Draft regeneration while preserving the frozen Writing Packet and all successful upstream artifacts. Repeated page/media blockers remain page/media recovery and never trigger writing.
- Isolate real-provider production-copy canaries from unrelated durable queue rows and disable fake Contract sync sources, preventing test-only background Jobs from consuming provider capacity or polluting acceptance results.
- Keep Gemini 3.8 Flash as the production text path and Gemini 3.1 Flash Image as the independent visual path. A canary-only text fallback can never disable, replace or simulate real image generation/localization acceptance.
- Attribute Vertex, Kimi and Flash Image network/time-limit failures to the actual provider and retain `retryable_provider` after the durable attempt budget is exhausted. Kimi's optional canary transport consumes long structured output as SSE instead of depending on a five-minute non-streaming response.
- Reject internal Claim-key dumps as reader alt text. Deterministic authorized-photo fallback now uses a clean stored description or evidence-linked subject, while preserving the exact Source asset and media provenance.
- Exercise binary WordPress media uploads separately from the bounded JSON Publish Package in the draft-only canary, and join visual evidence through Brief/Candidate ownership instead of a nonexistent Opportunity draft column.
- Reject a generated Draft before downstream image/page work when any evidence-ledger fact omits or changes a protected amount, duration, date, negation, audience, condition or exception. The same bounded generation receives an exact correction list; natural time ranges such as `09:00-17:00` and `09:00 to 17:00` remain semantically equivalent.
- Apply the same protected-value gate to bounded Draft repairs before any downstream Job is scheduled. One exact correction is allowed inside the current repair Job; a second omission is terminal for that repair and recovery promotes to full Draft regeneration without rerunning the frozen upstream packet.
- Rehydrate legacy visual provenance from the authoritative Source and Source Asset rows at WordPress delivery, then merge WordPress URL/dimension/hash metadata without erasing original-byte, authorization or localization proof. Historical empty visual metadata can no longer make a fully authorized retained original fail the final media gate.
- Treat an older failed bounded repair as history after a newer full Draft generation succeeds, even when current QA finds another blocker. Current status and recovery now describe the latest revision instead of reviving `INVALID_DRAFT_REPAIR_SCOPE` from superseded prose.
- Keep all imported Source media authorized for editorial use under `AGENTS.md`, while preserving attribution, durable bytes, relevance, alt text and Frontend Contract validation. Schema, strategy and approval semantics are unchanged.

## App 2.0.23 / schema 69 - 2026-09-14

- Keep the approved scope, complete frozen evidence set and Strategy 3.3 selection semantics while changing recovery depth according to the real failure: global quality or invalid bounded-repair failures regenerate only the Draft; page-only failures recompose the Frontend Page; stale Writing Packet scope resumes at Editorial Assembly.
- Feed the authoritative failed QA report into manual Draft regeneration. The writer must produce traveler decision logic with varied section rhythm and plain reader-facing Markdown; legacy table syntax is deterministically translated into Contract-native content and raw presentation markers fail the final artifact gate.
- Apply the project-wide authorization that all imported source media is cleared for editorial and production use. Missing historical per-item authorization flags cannot suppress a retained original, while factual/destination relevance, provenance, alt text, durable bytes and the Frontend Contract remain enforced.
- Keep schema 69 and Content Strategy 3.3. No migration, automatic enqueue, model call, approval change, production deletion or WordPress publication is introduced by startup.

## App 2.0.22 / schema 69 - 2026-09-14

- Align retained page-block provenance signatures with delivery-only entity normalization only after exact original-signature verification; stable evidence identities remain unchanged and tampered content continues to fail closed.
- Calculate provenance for newly generated Frontend pages after delivery normalization, preventing transport spelling from creating a false final-page QA break.

## App 2.0.21 / schema 69 - 2026-09-14

- Preserve Strategy 3.3 and all current Draft facts while canonicalizing safe inline HTML entities at the WordPress delivery boundary.
- Keep the exact public text unchanged; only its entity spelling is normalized to the form retained by the deployed theme sanitizer.
- Upgrade `production_state` to 1.8 so a matching remote component-data rejection rebuilds the Publish Package instead of retrying writing or a known-invalid request.
- Keep schema 69. No migration, startup retry, new approval, production publish or evidence rewrite is introduced.

## App 2.0.20 / schema 69 - 2026-09-14

- Keep Strategy 3.3 content selection, evidence, Draft, QA and commercial semantics unchanged while translating the internal article taxonomy at the delivery boundary.
- Map every supported CMS content type to one of the four guide types accepted by the deployed WordPress Content Contract; unknown types fail locally before any WordPress request.
- Rebuild only the Publish Package for retained legacy page payloads and preserve current writing, evidence, media, QA and approval artifacts.
- Keep schema 69. No migration, startup retry, approval change, automatic production recovery or automatic WordPress publish is introduced.

## App 2.0.19 / schema 69 - 2026-09-14

- Keep Strategy 3.3 selection and approval semantics unchanged while tightening the production writing contract around the frozen Writing Packet, exact planned sections and selected facts.
- Normalize planned article sections to an accessible H2 hierarchy, remove duplicate title H1s, and regenerate a structurally truncated Draft instead of allowing a bounded patch to consume its later sections.
- Treat warning-only model review output as editorial guidance; only explicit blockers can fail the quality gate. Deterministic evidence, safety, SEO/GEO and Frontend Contract checks remain mandatory.
- Rebuild Content AST, Page Payload and Publish Package from the current Draft and active Frontend Contract, preserving semantic evidence provenance without copying JSX/CSS.
- Keep schema 69. No migration, startup retry, bulk reconciliation, automatic model call, approval change or automatic WordPress write is introduced.

## App 2.0.18 / schema 69 - 2026-09-14

- Upgrade `production_state` to 1.5 so a failing quality review remains the authoritative content gate when parallel image/page work fails later; `revise_draft` is included as the exact next stage before a repair Job exists.
- Add a durable, idempotent terminal join for post-Draft branches. Deferred content repair is released after the sibling image/page Job settles, using the existing bounded automatic-repair counter and dedupe key.
- Retry previously failed visual slots on an explicit visual-stage recovery and pass retained WebP originals to Vertex Gemini with their real MIME type. This changes neither source authorization nor the Frontend Contract boundary.
- Keep schema 69 and Strategy 3.3. The upgrade performs no migration, startup retry, bulk reconciliation, model call or production-record deletion.

## App 2.0.17 / schema 69 - 2026-09-14

- Keep Content Strategy 3.3, the approved scope and the frozen evidence package unchanged while repairing the Vertex transport used by bounded Draft revision.
- Vertex receives a compatible OpenAPI response schema without provider-rejected array-bound keywords; the unchanged canonical schema is still enforced locally after every response.
- Draft repair now uses LOW thinking and a larger JSON budget, filters non-blocking/page-only issues, and sends a deterministic compact evidence projection. It neither expands the approved topic nor deletes retained research artifacts.
- No migration, bulk retry, approval change, model call at startup, WordPress action or Frontend Contract change is introduced.

## App 2.0.16 / schema 69 - 2026-09-14

- Production recovery resolves the approved Opportunity to its Candidate before loading bounded planning input, without changing the Content Strategy 3.3 selection policy.
- A destination correction now creates a scope boundary: older failures/artifacts remain auditable history and the corrected scope requires explicit confirmation before a new Editorial Assembly is queued.
- Failed QA with content blockers targets bounded `revise_draft`; media-only and page-only failures retain their existing specialized recovery rules.
- No schema migration, bulk retry, model call, evidence deletion or Frontend Contract change is introduced.
- Production was upgraded to final revision `4333c7ba559139f42da43e78b3b696978fa1ef69`; the post-rollout seven-record projection has mutually exclusive lifecycle counters, zero active production Jobs and preserves the 5,748-call model ledger.

## App 2.0.15 / schema 69 - 2026-09-14

- Keep Strategy 3.3 selection semantics unchanged while bounding the first Editorial Assembly model projection by materiality, evidence and byte/token budgets. Full research and approval records remain retained.
- Reuse durable model-call receipts to resume Vertex structured-output transport and enforce finite provider retry budgets. No recommendation, approval, scope, migration or automatic production-enqueue behavior changes.
- Production was upgraded to 2.0.15 after its offline release gate and production-copy checks passed.

## App 2.0.14 / schema 69 - 2026-09-13

- Keep Content Production Strategy 3.3 unchanged. Vertex structured-output transport now negotiates JSON Schema, OpenAPI Schema and prompt-enforced JSON while retaining the same authoritative local schema validation.
- Treat destination/title conflicts as deterministic production-scope failures before any model request, and distinguish non-blocking historical failures from the first missing prerequisite in the current production pipeline.
- This application-only repair adds no migration, automatic retry, reconciliation or production deployment.

## App 2.0.13 / schema 69 - 2026-09-13

- Keep Content Production Strategy 3.3 unchanged; this patch corrects execution ownership, status projection, bounded planning input, retry idempotency and responsive operator UI.
- Define the approved Opportunity as the production owner. Candidate IDs remain research/topic identity and cannot by themselves admit a row to production or propagate a Job across sibling Opportunities.
- Migration 69 deterministically assigns only uniquely provable historical owners and leaves ambiguous history unowned for audit. It performs no model request, enqueue, approval change or destructive reconciliation.
- Production rollout used a network-isolated deterministic reconciliation and retained all seven persisted approvals while excluding 174 unapproved false projections from the Content Workbench. No production Job, model request or WordPress write was created by the rollout.

## App 2.0.12 / schema 68 - 2026-09-13

- Content Strategy remains 3.3; unified production state, targeted recovery, archive/delete controls and structural page preview are application-layer changes.
- Schema 68 introduces no migration-time production replay or model invocation.

## App 2.0.11 - 2026-09-13

- Opportunity reconciliation derives Knowledge identity from the resolved topic entity and reconciles a primary city together with its nested destination scopes, so bilingual titles and parent/child destination aliases cannot create parallel Knowledge opportunities.
- Source-backed adaptations retain their exact destination and declared production path; conservative same-intent matching merges only redundant paths and preserves distinct modes, durations and reader promises.
- Every existing-installation upgrade now runs a deterministic offline opportunity reconciliation and an enforced admission audit before traffic is exposed. The gate verifies current Source evidence and strategy, declared paths, usable Knowledge facts, independent Source families, readiness consistency, lifecycle/type/mode/title/promise fields, generic-topic exclusion, canonical and semantic duplicates, migration references, SQLite integrity and foreign keys.
- Evidence-gap opportunities remain visible for editorial consideration but stay outside content production until coverage is ready; the gate reports this hold separately from admission failures.

## App 2.0.10 - 2026-09-13

- Completed Sources are reconsidered under Strategy 3.3 regardless of the label on a compatible historical diagnostic; the stored output is normalized and its opportunities are recalculated without another model call.
- Multi-source opportunity coverage uses only completed Source evidence. Sources still processing stay in the Source queue and contribute after their own completion.
- Rebuilding the same opportunity updates its active strategy and readiness, while semantic deduplication continues to merge only matching destination, content type, production mode, duration and topic intent.

## App 2.0.9 - 2026-09-13

- Source status polling no longer surfaces a superseded failed extraction after the current Source has completed.
- Recommendation reconciliation uses a reviewed dry-run fingerprint to refresh diagnostics that still belong to an older strategy.
- Local backup retention defaults to one verified snapshot, and successful GCE upgrades prune rehearsal databases, obsolete rollback containers and unreferenced image layers.

## 3.3 - 2026-09-12

- Knowledge now uses typed canonicalization before scope, validity-period and independent-source resolution. Ordinary dynamic ambiguity becomes targeted verification; human review remains for safety-critical or otherwise unresolved current, same-scope hard conflicts.
- Predicate/value mismatches create deterministic local repairs or Claim repair jobs. Equivalent, repaired, scoped, temporal, consensus, verification and human outcomes have durable history.
- Historical Source recovery starts from an exact dry-run fingerprint and queues the first missing stage. Every child retains the `historical_recovery` priority, execution route and recovery ID, while new interactive captures stay ahead.
- Experience opens the Entity and Knowledge core path immediately. Family, Blueprint, Diagnostic, Coverage and Opportunity enrichment run in the background; heavy repository work and scheduled backup use child processes.
- Dirty fact keys drive incremental Coverage Matrix refresh, and Intake uses a compact Claim/Knowledge projection. This strategy maps to App/Extension 2.0.8 and schema 67.

## 3.1 — 2026-09-12（本地未发布实现）

- 采集先保存清单，再验证媒体；断点及回执可恢复，旧协议保留未验证质量等级。
- 完整重采保留各版本资产、文件、分段及旧文章/证据引用；当前来源使用当前版本视图。
- 实体分页与补提取模型返回持久化；组合补提取/审核及页面交付补齐事务与迟到结果校验。
- Writing Packet 冻结选定陈述与叙事上下文；页面按内容节点保留值、条件和精确引用。
- 普通失败归档并保留批准和产物，明确范围失效才重新推荐；Failure Lesson 按当前机会筛选。
- 自动合并实体需要正向身份依据；实时与 Batch、文字与视觉压力分开，复杂度轻量路径默认关闭。
- 规范见 `CONTENT_PRODUCTION_STRATEGY_3.1.md`；以下各版本属于历史规则，不是当前失败处理策略。

## 3.0 — 2026-09-11

- 授权图片和视频原件必须校验后持久化；媒体缺口通过服务端恢复或浏览器 Repair 清单闭环，未落盘时不开始来源抽取。
- Claims 后新增可溯源 Experience Blocks，显式保存路线、顺序、条件、权衡、提醒与决策逻辑。
- 写作链路升级为 Editorial Assembly → Narrative Plan → Writing Packet → Draft，避免把全库记录直接交给写作模型。
- “建议”只展示可执行机会，每个方向独立决策，并明确 NEW、UPDATE、EXPAND、MERGE、SKIP。
- 普通生产终态失败生成 Failure Lesson、清除瞬态产物并回到 recommended_again，研究资产保持不变。
- 后台固定六个顶级入口；回填默认 dry-run，历史清理必须引用经检查的 dry-run ID。
- 规范见 `CONTENT_PRODUCTION_STRATEGY_3.0.md`。

## 2.1 — 2026-09-11

- “建议”保留为唯一人工文章批准入口；“内容”按已批准文章一一展示创建结果、失败原因和处理入口。
- 移除“创作规划”菜单、人工命题接口和专用模块，保留不对用户暴露的自动写作准备阶段以维持生产链路。
- 运营界面错误与确认操作统一为中文站内对话框；缺字段的质量问题也会显示非空原因与处理建议。
- 授权来源图片必须先校验并保存真实字节，按图片自身上下文匹配；中文图通过原图输入做仅文字翻译的保真派生。
- 用户选择来源中的日常动态信息按输入使用，不增加官方复核或日期门槛；只有真正互斥的信息进入一次人工决定。
- 正文质检与媒体／页面交付独立并行；修复携带相关完整证据，内容 AST 阻止跨章节证据继承并保留列表与媒体结构。
- 规范见 `CONTENT_PRODUCTION_STRATEGY_2.1.md`。

## 2.0 — 2026-09-10

- 来源只沉淀 Claims、知识和编辑建议；未批准的单来源文章方案不再算作实际内容机会。
- “批准创作方向”和“批准文章”统一为批准一份可继续生产的文章方案；批量操作使用相同语义。
- 规划最多选择 48 条证据、每节最多 12 条；质量审核检查正文是否支撑所写事实，不再要求穷举素材库。
- 正文、证据、页面和图片故障显示中文诊断并进入最多两次的有界自修复；超过次数或需外部材料时转人工。
- 采集保留普通尺寸授权图片的实际字节，重复采集可补回旧素材，并分别记录来源编辑／发布时间与采集时间。
- 规范见 `CONTENT_PRODUCTION_STRATEGY_2.0.md`。

## 1.9 — 2026-09-10

- 以人工批准的明确提案为生产单位，分开来源建议、创作方向和生产记录。
- 冻结审批边界和指纹，提供逐条事务批量决策、人工命题兼容、规划引用准入和覆盖分语义澄清。
- 正文／交付分层与单阶段恢复共同约束生产；升级保留历史、不自动重分析旧来源，不降低交付门禁。
- 规范见 CONTENT_PRODUCTION_STRATEGY_1.9.md；1.9_DRAFT 仅作设计历史。

## 1.8 — 2026-09-10

- 把 Claim 判定从“遇到一个例子补一条规则”升级为通用开放世界语义：未知谓词默认可并存，只有结构定义明确互斥、适用范围相同且不能同时成立的陈述才可能构成冲突。
- 日常票价、营业时间、预约、班次、入口和交通信息不再要求人工或永久官方核验，改为独立来源、来源质量、提取置信度、完整度和证据时间共同加权的自动共识。
- 同一作者、完全重复、近似转载和派生转载只计算一次投票；独立笔记和文档分别计票，避免复制内容制造虚假多数。
- 时间权重按事实变化速度衰减：营业时间/预约/班次 30 天、票价/可用性 45 天、地址/入口/交通 90 天、其他动态事实 120 天。
- 稳定多数形成“时效加权共识”；证据分裂时采用“最新加权暂定值”，照常供内容创作使用，但必须披露证据日期和变化风险。
- 过时动态事实从“人工异常和创作硬阻塞”改为“低权重证据与后续采集信号”；文章 QA 检查时效披露，不再要求把整条事实删掉。
- 只有安全、医疗、过敏、紧急疏散和法律义务等少量高后果冲突保留严格处理。
- 迁移 38 保存完整的共识方法、置信度和候选值明细，并自动重建全部目的地知识以清理历史误报。

## 1.7 — 2026-09-09

- 异常数量按“事实组”和“成对比较”分别展示和判断：同一个事实组内 4 条不同来源会形成 6 个比较对，但不代表 6 次系统故障，更不能据此要求 6 次人工处理。
- 地铁站名、地铁口编号先做交通实体标准化；例如“上新街地铁站1号出口”“上新街1号口”“上新街站一号出入口”是同一事实，自动记为同义佐证。只有出口编号或车站确实不同且适用条件相同时才保留为硬事实冲突。
- 拥挤程度、拍照位置、菜品清单和普通别名默认按主观观察或多值知识处理；不同来源给出不同答案可以同时成立，不进入人工异常队列。
- 营业时间、是否必须预约、当前票价等会直接影响游客决策的事实仍保持严格判定；只有在票种、日期、季节、渠道和限定条件都不能解释差异时，才要求人工或官方来源核验。
- Claim 判定规则带独立版本号。版本升级后，系统会自动重建仍有待处理异常的目的地知识，不要求运营人员逐条点击旧异常。
- 单一来源改写、专题创作和多来源综合改为可以同时成立的并行机会；一次文章生产只选择其中一个主路线，但不会关闭其他路线。
- 一日游与两日游、不同路线顺序、不同菜品和不同机位默认是作者选择或多值推荐，不再因为文本不同就产生冲突异常。
- 增加价格、全天开放等同义硬事实标准化，并收紧否定和限定语遗漏检查，减少无意义的人工处理。
- 内容建议新增详细中文解释，逐条说明读者承诺、可写原因和证据边界。
- 大批量分段提取和文本覆盖审计接入 Vertex Batch；批任务完成后统一更新，小批量、视频和失败项由实时请求兜底。首轮生产批任务已成功写回 18 个分段结果。
- “同一个知识键”不再被误当作“同一个事实”：拍摄视角、相邻位置、建筑描述、作者建议和行程耗时估算可以并存；营业时间、票价、预约要求等硬事实仍严格核验。
- 模型明确建议 `part_of`、`located_in`、`related_to` 等关系时，只保存关系，不再要求人工把两个不同对象合并成同一实体。

## 1.6 — 2026-09-09

- 用一个边界清楚的读者承诺判断文章是否就绪，不再要求目的地百科式完整。
- 增加窄专题和已授权单一来源改写，支持美食、住宿、路线、机位等系列内容。
- 来源可以给出多个具体后续选题。
- 单条无法回溯的提取结果会被排除，不再阻塞同一来源中已被证据支持的内容。
- 调整队列，使靠前来源及其诊断尽快完成，并避免把整队任务统一显示为冷却。

## 1.5 实施说明 — 2026-09-08

- 明确“小红书收藏同步”是由所有者主动选择的研究来源入口，并保存完整授权和来源信息。
- 明确并发数和模型批量大小只是每次请求的限制，不能造成来源内容截断。
- “建议”继续作为唯一的人工文章生产批准入口。

## 1.5 — 2026-09-08

- 将审核、页面组合和商业输出绑定到准确的草稿版本、内容哈希和证据哈希。
- 根据真实读者任务和证据决定文章篇幅、问答数量和配图，不用统一硬门槛。
- 审核最终可见页面；FAQ 结构化数据只来自页面中真正显示的问答。
- 展示读者可核实的来源，内部链接只来自已同步的 WordPress 内容。
- 记录模型来源和用量，但不记录提示词、密钥或来源正文。

## 1.4 — 2026-09-07

- 把来源建模为证据容器，经过预检、文本/PDF/媒体分段、原子信息主张提取和覆盖审计。
- 增加证据片段、提取覆盖、来源家族、主题聚类、覆盖矩阵和证据驱动的内容机会状态。
- 人工批准会被持久保存；证据不足的机会继续等待，满足后自动恢复且只创建一个候选。
- 增加可撤销的信息主张排除和知识显示控制，不删除原始证据和历史。
- 增加大视频分块上传和分阶段进度，并提高文件、图片、视频和总上传上限。

## 1.3 — 2026-09-03

- 分开处理实体身份、语义相关性和信息主张，加入实体类型、粒度和地域约束以及可撤销复核。
- 在判断冲突前，先识别可兼容、补充和细化的关系。
- 引入独立的联盟供应商、素材、意图、位置、机会和事件阶段。
- 安全组合商业 WordPress 区块，记录前端能力缺口并限制商业密度。

## 1.2 — 2026-09-01

- 内容所有者确认：人工选择并保存的来源图片已获得原作者和平台的发布授权。
- 获批文章优先使用与证据匹配的实景来源图片，并在 WordPress 草稿媒体中保留来源追踪。
- 没有匹配实景图时，才使用数据确定的地图/信息图或非纪实原创插画。

## 1.1 — 2026-09-01

- 增加后台可查看且不可篡改的策略版本历史，下游记录保留创建时的版本。
- 保存的来源图片可以用于文字识别、多模态理解和研究证据。
- 实景图只有在自有、官方、许可或已确认授权时才能公开发布；相关性本身不等于发布许可。
- 地图和信息图必须由数据确定性生成，生成式图片只承担非纪实插画用途。

## 1.0 — 2026-08-23

- 建立最初的结构化内容生产流程：人工选择来源、AI 给出建议、人工批准、规范内容、结构化渲染、搜索优化、图片规划和仅投递 WordPress 草稿。
