// Technical/resource problems are not requests to rewrite reader-facing prose.
export const DELIVERY_ISSUE_CODES = new Set([
  'required_visual_missing', 'visual_renderer_incomplete', 'final_page_invalid',
  'final_page_content_missing', 'final_page_evidence_invalid',
]);

const ISSUE_GUIDANCE = {
  invalid_evidence_key: ['证据编号无效', '草稿台账引用了本篇证据包里不存在的编号。', '修正证据台账后重新质检。'],
  confirmed_topic_coverage_missing: ['文章结构与证据范围不一致', '至少一个计划章节没有引用任何可用证据；不再要求把素材库里的每条事实都写进文章。', '让自动修订补齐缺证据的章节，或删去没有证据支撑的承诺。'],
  protected_evidence_mismatch: ['关键事实被改写错了', '正文中的金额、日期、否定条件、适用人群或例外，与证据台账不一致。', '只修订涉及这些事实的段落并重新质检。'],
  missing_temporal_disclosure: ['时效信息缺少日期说明', '正文使用了票价、营业时间、预约或交通等会变化的信息，却没有说明证据截至什么时候。', '补充“截至某日”和可能变化的提示，再重新质检。'],
  hidden_conflict: ['证据冲突没有说明', '正文使用了存在冲突的事实，却没有向读者说明不确定性。', '补充冲突说明或删除该事实。'],
  commercial_contamination: ['研究正文混入商业内容', '面向读者的研究正文出现了联盟、佣金或预订导向内容。', '移除商业措辞；商业模块应保持在独立层。'],
  internal_metadata_leak: ['内部编号泄漏到正文', '读者正文里出现了 claim key、证据台账或内部来源编号。', '自动清理内部标记后重新质检。'],
  prompt_injection_leak: ['来源指令混入正文', '采集来源中的提示词式文本被当成文章内容。', '删除这些文本并重新质检。'],
  seo_metadata_missing: ['SEO 基础字段缺失', '标题、焦点短语或摘要至少缺少一项。', '仅补齐缺失的 SEO 字段。'],
  unsupported_title_promise: ['标题承诺超出证据', '标题承诺的范围比已确认选题或证据能够支持的范围更大。', '缩小标题和正文承诺，不新增未经证实的内容。'],
  seo_title_description_duplicate: ['标题和摘要重复', '搜索摘要只是重复标题，没有告诉读者文章具体解决什么问题。', '重写摘要，不必重写全文。'],
  strategy_version_mismatch: ['草稿和规划版本不一致', '这篇草稿不是按当前已确认的内容规划版本生成，继续交付可能混入旧规则。', '用当前规划重新生成或修订草稿，然后重新质检。'],
  canonical_content_incomplete: ['文章的核心回答结构不完整', '当前规划缺少直接回答或结构化答案块，读者可能看不出文章究竟解决什么问题。', '补齐文章开头的直接回答和必要答案块，不扩写无关内容。'],
  schema_inconsistent: ['结构化数据与文章不一致', 'Article 结构化数据缺失、含占位值，或没有与当前可见正文同步。', '重新编排页面并生成与正文一致的结构化数据。'],
  heading_hierarchy_invalid: ['标题层级不连续', '正文标题顺序跳级或结构不清，影响读者和机器理解页面层次。', '只调整标题层级，不改写事实内容。'],
  image_strategy_invalid: ['配图类型与事实要求不匹配', '需要实景原图的地点或路线被当成可生成插图，或者图片缺少可追溯用途。', '改用已授权实景图，或删除没有证据支持的配图计划。'],
  faq_policy_mismatch: ['FAQ 与正文不一致', '结构化 FAQ 与读者可见正文没有一一对应，或当前文章不适合 FAQ。', '同步 FAQ 与正文，或删除无证据的 FAQ。'],
  required_visual_missing: ['缺少可交付的实景图', '文章要求真实地点或实物图片，但当前没有已授权且已留存文件字节的图片。', '打开下方原文链接重新采集并绑定对应原图。'],
  visual_renderer_incomplete: ['图表尚未生成', '规划了路线图或信息图，但渲染任务没有产出可交付文件。', '修复或重跑图表渲染；不需要重写文章。'],
  final_page_invalid: ['页面编排结果无效', '页面数据不符合当前前端组件契约，无法安全交付。', '仅重新编排页面。'],
  final_page_content_missing: ['页面漏掉正文内容', '编排后的页面没有完整承载当前正文。', '仅重新编排页面并复核。'],
  final_page_evidence_invalid: ['页面证据映射错误', '页面块与正文证据台账的对应关系不完整或不一致。', '仅重新编排页面；若仍失败再修证据台账。'],
  draft_below_suggested_length: ['篇幅低于建议值', '这只是编辑提醒，不等于质量失败；证据较少时不应为凑字数而扩写。', '确认读者问题已回答即可，无需强行扩写。'],
  seo_keyword_repetition: ['关键词重复偏多', '标题或摘要重复使用同一短语，读起来不自然。', '精简重复措辞。'],
  seo_length_suggestion: ['SEO 文本偏长', '标题或摘要超过显示建议值，但不是排名硬门槛。', '有必要时精简，不阻塞交付。'],
  answer_structure_suggestion: ['直接答案不够醒目', '文章可能没有尽早回答读者最关心的问题。', '把直接答案前移；这是提醒，不等于失败。'],
  reader_sources_presentation_suggestion: ['读者来源展示可改进', '内部证据链仍然存在，但正文没有可读的来源展示。', '按内容需要补充来源区；不是强制阻塞。'],
  visual_plan_suggestion: ['配图计划数量需复核', '配图数量超出证据与素材所能支持的合理范围。', '只保留有用途且有证据或授权素材的图片。'],
  repetitive_copy: ['正文存在重复段落', '相同或近似内容重复出现，影响英文可读性但不应通过堆字数解决。', '删除重复段落，保留信息最完整的一处。'],
  readability_suggestion: ['英文句子过长', '部分句子过长或结构过密，读者需要反复阅读。', '拆分长句并保持金额、日期和限定条件不变。'],
};

function compactDetails(message, limit = 6) {
  const text = String(message || '').trim();
  const separator = text.indexOf(':');
  if (separator < 0) return text.slice(0, 500);
  const prefix = text.slice(0, separator + 1);
  const items = text.slice(separator + 1).split(',').map((item) => item.trim()).filter(Boolean);
  if (items.length <= limit) return text.slice(0, 800);
  return `${prefix} ${items.slice(0, limit).join(', ')}，另有 ${items.length - limit} 项（技术明细中可查看全部）`;
}

export function explainQualityIssue(issue = {}) {
  const code = String(issue.code || 'unknown_quality_issue');
  const [title, reason, action] = ISSUE_GUIDANCE[code] || [
    issue.severity === 'warning' ? '需要编辑复核' : '质量规则未通过',
    '系统检测到一项尚未归类的质量问题。',
    '查看技术明细并按失败阶段进行有界修复。',
  ];
  return { code, severity: issue.severity || 'blocker', title, reason, action, technicalDetail: compactDetails(issue.message) };
}

export function explainOperationalFailure(job) {
  if (!job) return null;
  const message = String(job.last_error || job.error || '');
  const type = String(job.type || '');
  if (/requires a configured Kimi key or Vertex AI project/i.test(message)) return {
    category: 'configuration', headline: '生产模型尚未配置',
    reason: '系统没有可用的 Kimi 密钥或 Vertex AI 项目，因此生产阶段无法执行；这不是文章内容错误。',
    action: { id: 'configure_ai', label: '先到“设置”配置 AI 模型', why: '配置完成后再重试失败阶段，否则重复点击仍会失败。' },
    technicalDetail: compactDetails(message),
  };
  if (/403|Authorized source image download failed/i.test(message)) return {
    category: 'media', headline: '授权图片只有失效链接，没有留存文件',
    reason: '采集时保存了图片地址，但旧版没有保存大多数普通尺寸图片的实际字节；来源 CDN 链接过期后就会返回 403。',
    action: { id: 'recapture_media', label: '打开原文并重新采集图片', why: '新版采集器会保留已授权原图；重新采集后系统可继续页面编排。' },
    technicalDetail: compactDetails(message),
  };
  if (type === 'compose_frontend_page' && /400|invalid argument/i.test(message)) return {
    category: 'page', headline: '页面编排提交的数据不符合模型接口要求',
    reason: '页面编排输入过大或结构与 Vertex 接口不兼容，因此正文虽然还在，页面没有成功生成。',
    action: { id: 'compose_frontend_page', label: '仅重新编排页面', why: '不重写正文，只重建页面数据，完成后会自动质检。' },
    technicalDetail: compactDetails(message),
  };
  if (/token limit|MODEL_OUTPUT_LIMIT|structured output reached/i.test(message)) return {
    category: 'content', headline: type === 'plan_content' ? '内容规划输入过大' : '自动修订输出超过上限',
    reason: '旧流程把过多事实编号和重复错误明细一次性交给模型，超出了结构化输出限制。',
    action: { id: type === 'plan_content' ? 'plan_content' : 'revise_draft', label: type === 'plan_content' ? '用精简证据重新规划' : '仅修订失败内容', why: '新版会压缩事实范围和错误明细，并限制修订次数。' },
    technicalDetail: compactDetails(message),
  };
  return {
    category: 'operation', headline: '生产任务执行失败', reason: '这是流程或外部服务错误，不等于文章事实一定有错。',
    action: { id: type || null, label: '重试失败阶段', why: '先查看折叠的技术明细；若输入和服务配置已经修正，再只重试这个阶段。' },
    technicalDetail: compactDetails(message),
  };
}

export function groupQualityIssues(issues = []) {
  const explained = issues.map(explainQualityIssue);
  const blockers = explained.filter((item) => item.severity !== 'warning');
  const warnings = explained.filter((item) => item.severity === 'warning');
  return { blockers, warnings, blockerCount: blockers.length, warningCount: warnings.length };
}

export function separateQualityResults(review, issues = review.issues || []) {
  const contentIssues = issues.filter(issue=>!DELIVERY_ISSUE_CODES.has(issue.code));
  const deliveryIssues = issues.filter(issue=>DELIVERY_ISSUE_CODES.has(issue.code));
  const contentBlockers = contentIssues.filter(issue=>issue.severity==='blocker');
  return {content_quality:{passed:review.passed && !contentBlockers.length,
    score:Math.max(0,Number(review.score || 0)-contentBlockers.length*10),issues:contentIssues},
    delivery_quality:{passed:!deliveryIssues.some(issue=>issue.severity==='blocker'),issues:deliveryIssues}};
}

export function qualityRepairStage(issues = []) {
  const blockers = issues.filter((issue) => issue.severity !== 'warning');
  if (!blockers.length) return null;
  const media = new Set(['required_visual_missing', 'visual_renderer_incomplete']);
  const page = new Set(['final_page_invalid', 'final_page_content_missing', 'final_page_evidence_invalid']);
  if (blockers.some((issue) => !media.has(issue.code) && !page.has(issue.code))) return 'revise_draft';
  if (blockers.some((issue) => media.has(issue.code))) return null;
  return 'compose_frontend_page';
}

export function recoveryDiagnosis({ review, failedJob, automaticRepair } = {}) {
  const grouped = groupQualityIssues(review?.issues || []);
  const operational = explainOperationalFailure(failedJob);
  const first = grouped.blockers[0];
  const fallbackAction = automaticRepair?.stage ? {
    id: automaticRepair.stage,
    label: automaticRepair.stage === 'compose_frontend_page' ? '仅重新编排页面' : '仅修订失败内容',
    why: '系统已根据失败类型选择最小修复阶段。',
  } : null;
  return {
    category: operational?.category || (first ? (DELIVERY_ISSUE_CODES.has(first.code) ? 'delivery' : 'content') : 'ready'),
    headline: operational?.headline || first?.title || '当前没有检测到阻塞问题',
    reason: operational?.reason || first?.reason || '当前版本未发现需要人工处理的阻塞项。',
    recommendedAction: operational?.action || fallbackAction || (first ? { id: null, label: first.action, why: first.reason } : null),
    automatic: operational ? { ...(automaticRepair || {}), eligible:false, queued:false, reason:'operation_must_be_resolved_first' }
      : automaticRepair || { eligible: false, queued: false, attempts: 0, maxAttempts: 2 },
    technicalDetail: operational?.technicalDetail || first?.technicalDetail || '',
    issues: grouped,
  };
}
