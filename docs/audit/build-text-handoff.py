import json
import re
import shutil
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parent
data = json.loads((root / 'repair-handoff-content.json').read_text(encoding='utf-8'))
out = root / 'handoff'
out.mkdir(exist_ok=True)
single = out / '逐项提示词'
single.mkdir(exist_ok=True)
bar = '=' * 64

baseline = '''交接日期 2026-09-07
CMS 仓库 https://github.com/Weapon-Tsang/solo-to-china-CMS
前端仓库 https://github.com/Weapon-Tsang/solo-to-china
CMS 审计提交 1a597ecfe2b89ce75f491bcbbf606f9c52d294ca
前端审计提交 ccfab41f25cd2323bfcd049485bdcb44a71df622

重要边界
1. 本交接包是修复任务书，不表示这些问题已被修复。
2. 原审计 CMS 118 项测试通过、静态与构建检查通过、35 项本地 smoke 通过；这些测试没有覆盖所有发现。
3. 已复现包括隔离代码和 mock 行为，不代表真实模型或生产 WordPress 已发生相同错误。
4. 原审计未执行真实付费模型、生产 WordPress/PHP、线上 HTML 和浏览器验收；A02 真实模型兼容性、A17 故障窗口等需在适当环境验证。
5. P1 表示扩大自动生产前优先处理，P2 表示明确的可靠性、安全或质量缺口；未定性为 P0 或已被利用的公网漏洞。
6. 路径均以对应仓库根目录为基准。新账号应重新核对当前 HEAD，不能假定仍是审计版本。
'''

usage = '''如何在另一个账号使用
推荐方式：将“01_问题清单.txt”和“02_完整修复提示词.txt”上传到新账号的同一任务，发送：
“请读取这两个文件，按总提示词和建议批次执行全部修复及优化，持续更新 repair-progress.md，不要只给计划。”

分批方式：先发送总提示词，再按批次粘贴对应 A/B 条目。若开启全新任务，可上传 ZIP 内“逐项提示词”中的对应 TXT；每个文件都包含仓库、基线、通用约束、问题描述和验收，不需要前一个账号的聊天记录。

节省额度：优先完成批次一至四的 A 类缺陷；B 类是已纳入任务范围的优化，继续在批次五执行。跨账号中断前要求保存 repair-progress.md 和精确下一步，不重复从零审计。

各提示词允许修复所需的代码、测试和迁移；不等于授权生产部署、破坏性数据操作或任意付费请求。
'''

batches = '''推荐批次
批次一 任务与契约基础：A16 A01 A19 A02 A12
批次二 证据闭环：A18 A03 A04 A09 A14 A13
批次三 最终页面与素材：A06 A05 A07 A08 A10
批次四 交付 SEO 与认证：A17 A11 A15
批次五 优化任务：B01 B02 B03 B04 B05 B06 B07 B08 B09 B10
最终执行总验收提示词。
依赖可以协同推进；未通过前置验收时不要把下游标为完全完成。
'''

common = '''通用执行约束
请实际修改代码并验证，不仅输出建议。先读取仓库 AGENTS.md、Git 状态与当前实现，若问题已修复则用测试证据关闭，不重复改动。保护用户改动和历史记录。
保持精确文章机会审批、研究与商业隔离、WordPress draft-only、非草稿保护和项目既有素材授权政策。不得通过关校验、降门槛、标所有来源官方或删失败数据来取得通过。
测试使用内存/临时数据库、mock 或明确测试 WordPress，不触碰生产库或偷偷批量调用付费模型。真实外部验证条件不足时完成本地实现并标 NOT TESTED，记录可执行验证步骤，不伪造通过。
涉及数据库、队列、QA、媒体和契约变更时提供迁移、历史兼容和回滚方案；记录 docs/audit/repair-progress.md 中对应编号、代码位置、测试证据、状态和下一步。不要把未部署的实现说成已上线。
原审计复现脚本断言的是错误行为，修复后应新增正确期望的回归测试，而不是继续维持原缺陷断言为绿。
'''

def write(name, text):
    p = out / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text.rstrip() + '\n', encoding='utf-8-sig')
    return p

checklist = [data['title'], '问题清单与修复顺序', bar, data['intro'], baseline, usage, batches, '一 19 项审计问题', bar]
for a in data['items']:
    checklist.extend([f"{a['id']}  {a['priority']}  {a['title']}", f"仓库：{a['repo']}；证据：{a['evidence']}", f"问题：{a['summary']}", f"代码入口：{a['paths']}", f"依赖：{a['depends']}", f"关闭标准：{a['tests']}", '对应提示词：02_完整修复提示词.txt 中同编号，或 ZIP 中同编号独立文件。', ''])
checklist.extend(['二 10 项改进任务', '以下为优化建议，不一概视为已发生漏洞。', bar])
for b in data['optimizations']:
    checklist.extend([f"{b['id']}  {b['title']}", b['prompt'], ''])
checklist.extend(['三 状态记录格式', '编号 | 状态 | 复核证据 | 修改文件 | 测试及结果 | 迁移影响 | 未测项 | 下一步', '状态：待复核／已确认／实现中／已实现待外部验证／已验证完成／已不存在。', '', '四 官方参考', 'Vertex 结构化输出 https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/control-generated-output', 'Vertex Schema https://cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1/Schema', 'Google Search 更新 https://developers.google.com/search/updates', 'Google AI 搜索 https://developers.google.com/search/docs/appearance/ai-features', '官方行为可能变化，执行修复时重新核对并记录日期。'])
write('01_问题清单.txt', '\n\n'.join(checklist))

all_prompts = [data['title'], '完整可复制提示词', bar, usage, baseline, batches, '总提示词开始', *data['master'], '总提示词结束', bar, common]
write('逐项提示词/00_总提示词.txt', '\n\n'.join([baseline, usage, *data['master']]))

for a in data['items']:
    prompt = [f"{a['id']} {a['title']}", f"请修复 {a['id']}，优先级 {a['priority']}。责任范围：{a['repo']}。", f"审计证据：{a['evidence']}。已观察的问题：{a['summary']}", f"首先检查：{a['paths']}", f"依赖：{a['depends']}。", '实现要求：']
    prompt.extend(f'{i}. {s}' for i, s in enumerate(a['actions'], 1))
    prompt.extend(['验收要求：' + a['tests'], '交付：实现、针对性回归、迁移/兼容说明、对应编号状态与未测项。不得仅交付方案。'])
    all_prompts.extend([bar, f"{a['id']} 提示词开始", *prompt, f"{a['id']} 提示词结束"])
    write(f"逐项提示词/{a['id']}_{a['title']}.txt", '\n\n'.join([baseline, common, *prompt]))

all_prompts.extend([bar, 'B 类优化提示词', '与 A 类同样受通用约束限制；以改进收益和回归证据验收，不把策略建议误报为已利用漏洞。'])
for b in data['optimizations']:
    all_prompts.extend([bar, f"{b['id']} {b['title']} 提示词开始", b['prompt'], f"{b['id']} 提示词结束"])
    write(f"逐项提示词/{b['id']}_{b['title']}.txt", '\n\n'.join([baseline, common, f"请执行 {b['id']} {b['title']}。", b['prompt'], '完成后更新 repair-progress.md，记录实现、测量/测试、收益、兼容影响和剩余外部验证。']))
all_prompts.extend([bar, '最终验收提示词开始', *data['final_prompt'], '最终验收提示词结束'])
write('02_完整修复提示词.txt', '\n\n'.join(all_prompts))
write('逐项提示词/99_最终验收提示词.txt', '\n\n'.join([baseline, *data['final_prompt']]))

original = (root / '2026-09-07-full-audit.md').read_text(encoding='utf-8')
plain = re.sub(r'^#{1,6}\s+', '', original, flags=re.M).replace('`', '')
write('证据附件/原详细审计报告.txt', plain)
shutil.copy2(root / '2026-09-07-reproduce.mjs', out / '证据附件/2026-09-07-reproduce.mjs')
shutil.copy2(root / '2026-09-07-reproduction-results.json', out / '证据附件/2026-09-07-reproduction-results.json')
write('00_使用说明.txt', '\n\n'.join([data['intro'], usage, baseline, batches, '文件说明', '01_问题清单.txt：19 项缺陷、10 项优化、优先级、证据边界和关闭标准。', '02_完整修复提示词.txt：总提示词、19 项修复、10 项优化、最终验收，可整体上传。', '逐项提示词：每项独立 TXT 均带交接上下文，适合分任务执行。', '证据附件：原审计详细报告与隔离复现。复现脚本依赖两个源码仓库，不是独立可执行产品。原缺陷断言不适用于修复后的验收。', '本包不含生产密钥、Cookie、数据库或凭据。']))

# Verify complete numbering and prompt sections before packaging.
assert [x['id'] for x in data['items']] == [f'A{i:02}' for i in range(1,20)]
assert [x['id'] for x in data['optimizations']] == [f'B{i:02}' for i in range(1,11)]
text = (out / '02_完整修复提示词.txt').read_text(encoding='utf-8-sig')
for a in data['items']:
    assert f"{a['id']} 提示词开始" in text and f"{a['id']} 提示词结束" in text
for b in data['optimizations']:
    assert b['prompt'] in text
assert '\ufffd' not in text
for p in out.rglob('*.txt'):
    assert '\ufffd' not in p.read_text(encoding='utf-8-sig'), p

archive = root / 'SoloToChina_完整修复交接包_TXT.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
    for p in sorted(out.rglob('*')):
        if p.is_file():
            z.write(p, p.relative_to(out))
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
print(json.dumps({'issues': len(data['items']), 'optimizations': len(data['optimizations']), 'individual_prompts': len(list(single.glob('*.txt'))), 'prompt_characters': len(text), 'archive_files': len(z.namelist()), 'output': str(out), 'archive': str(archive)}, ensure_ascii=False, indent=2))
