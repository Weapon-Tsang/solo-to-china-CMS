import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const evidence = path.join(root, 'docs/codex-cms-upgrade/evidence/phase-02');
const prepend = (file, text) => {
  const prior = fs.readFileSync(file, 'utf8');
  if (!prior.startsWith(text)) fs.writeFileSync(file, text + prior);
};
prepend('docs/codex-cms-upgrade/STATUS.md', `# 当前状态：A1 剩余功能接续检查点（2026-09-27）

- **PARTIAL / NOT_READY_FOR_A2**。最新事实以 [A1 接续检查点](evidence/phase-02/a1-closure-checkpoint.md) 为准；下方旧记录保留，不代表当前缺口清单。
- 已接通五类来源关系与限定范围的明确冲突、真实适配器请求中的有界上下文补读、无 Claim 实体召回、显式 ID 超过旧 160/12 上限的保留、规划/写作不可用素材清单，以及 Source 页面真实文件与缺图诊断。
- 最终模块回归 99/99、npm run check、历史副本 1,364 图/627 关系事务回放、12 Brief/12 冻结包/1,748 候选记录只读审计、五屏宽浏览器交互均 PASS（限定覆盖范围见检查点）。L5/L6 NOT TESTED；无真实付费模型调用。
- **BIND-011 / T02-46 仍未闭环**：PDF 能准确报告独立化不支持并保留文档定位，但没有独立提取资产或可用绑定补图流程；D 的上传/采用生命周期与 A2 路线集成未实现。不能以 MIME 门控或诊断接口冒充整项通过。
- 下一条可执行开发：BIND-011/T02-46 的有界、可靠 PDF 独立素材路径；若只能依赖补图，明确保留 D 依赖，不擅自扩展范围。不要重做已完成的关系/补读/召回功能，不进入 A2。
- 应用 2.0.70、schema 81、main/HEAD 未改；绑定策略 source-media-binding-4。原未提交成果和原检查点保留。没有 commit/push/生产部署/生产写入/WordPress 写入。
- current_authorized_step=NONE
- phase_end_stop=true

---

`);
prepend('docs/codex-cms-upgrade/acceptance/phase-02.md', `# Latest A1 remaining-function evidence — 2026-09-27

**PARTIAL / NOT_READY_FOR_A2**. [Current checkpoint and exact remaining IDs](../evidence/phase-02/a1-closure-checkpoint.md). This section supersedes older continuation summaries below; all 68 requirements / 90 cases and historical evidence remain.

| Area | Current subcase result | Acceptance boundary |
|---|---|---|
| BIND-004/005/007; T02-36/39/43 | Typed preview/persist/read/match, scoped conflicts, negative evidence and legacy score/publication vetoes tested | Full malicious-source/provider and downstream lifecycle not claimed |
| BIND-002/003/010; T02-35/37/38/43 | Retained locators and bounded supplement reach actual realtime/Batch/reanalysis mock transport payloads | Real Provider NOT TESTED; historical sample had zero supplementation |
| BIND-001/006/008/012; T02-33/34/40/41/44/45 | Claim-free entity recall, explicit IDs beyond 160/12, actual 181st-slot repair, inventory and planning/writer snapshots, real file/slot diagnostics tested | Full A2 route/product and D adoption lifecycle remain |
| BIND-009/012; T02-42/45/63 | CAS and revocation retained, typed backup/restore and protected-history rollback tested | Whole-phase restore not claimed |
| BIND-011; T02-46 | PDF document capability, provenance and honest unsupported UI/API implemented | **Still PARTIAL**: no independent extracted asset or usable bound supplement flow; blocks A1 completion |
| MUP-001/002/006; T02-47–49 | Dependency described with source/capture identity | D implementation excluded and still missing |

L1/L2 PASS: 99/99 final module tests and npm run check. L3 PASS within existing historical-copy scope: 1,364 images/627 bindings with transaction rollback, plus read-only 12 Brief/12 frozen-packet/1,748 candidate entries. L4 PASS within five-width Source repair/diagnostic flows. L5 and L6 **NOT TESTED**. Scoped exploratory audit PASS after regression fixes. Evidence filenames and limits are recorded in the checkpoint; no whole-case PASS is inferred from these subcases. Policy4, no schema migration. Continue A1 at BIND-011/T02-46, not A2.

- current_authorized_step=NONE
- phase_end_stop=true

---

`);

const files = [
  'src/repositories/media-bindings.mjs', 'src/repositories/media-diagnostics.mjs',
  'src/media-context.mjs', 'src/media-availability.mjs', 'src/repository.mjs',
  'src/publication-eligibility.mjs', 'src/server.mjs',
  'frontend/src/workspaces/source-binding-repair.jsx',
  'test/media-bindings.test.mjs', 'test/media-context.test.mjs',
  'test/media-availability.test.mjs', 'test/media-context-api.test.mjs',
  'test/media-binding-repair.test.mjs',
  'scripts/verify-stage02-media-diagnostics-browser.js',
  'scripts/stage02-availability-read-audit.mjs',
  'docs/codex-cms-upgrade/STATUS.md', 'docs/codex-cms-upgrade/acceptance/phase-02.md',
  'docs/codex-cms-upgrade/phases/phase-02-a1-remaining-v1.0-20260927.txt',
  'docs/codex-cms-upgrade/evidence/phase-02/a1-closure-checkpoint.md',
];
fs.writeFileSync(path.join(evidence, 'a1-closure-files.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  head: 'e9f7c8e82ff760f4d18f2d2e0673452eb8744290',
  note: 'Current byte fingerprints, not an assertion that entire files were authored in this continuation. Earlier dirty work is preserved.',
  files: files.map(file => ({ path: file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') })),
}, null, 2) + '\n');
console.log('Updated status and acceptance summaries; wrote current file fingerprints.');
