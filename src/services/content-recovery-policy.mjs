// Technical/resource problems are not requests to rewrite reader-facing prose.
export const DELIVERY_ISSUE_CODES = new Set(['required_visual_missing','visual_renderer_incomplete','final_page_invalid','final_page_content_missing','final_page_evidence_invalid']);

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
