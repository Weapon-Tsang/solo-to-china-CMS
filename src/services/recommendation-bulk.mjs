import { transaction } from '../db.mjs';
import { proposalFingerprint } from './editorial-proposal.mjs';

const DECISIONS = new Set(['approved_article','knowledge_only','cluster','research_first','ignored']);
const APPROVED = new Set(['approved_waiting_for_evidence','approved_ready','producing','drafted','qa_failed','ready_for_wordpress','wordpress_draft']);

export function decideRecommendationCommand(repository, input, { pendingOnly = false } = {}) {
  if (!DECISIONS.has(input?.decision)) throw Object.assign(new Error('不支持的审批决定。'),{statusCode:400});
  return transaction(repository.db, () => {
    const recommendationId=String(input.recommendationId || '');
    const row=repository.db.prepare('SELECT * FROM content_recommendations WHERE id=?').get(recommendationId);
    if(!row)return null;
    if(pendingOnly && row.decision!=='pending')return {recommendationId,status:'skipped',reason:'已有人工决定，不重复处理或覆盖。'};
    if(input.updatedAt && input.updatedAt!==row.updated_at)throw Object.assign(new Error('建议已更新，请刷新并重新确认。'),{statusCode:409});
    const paths=repository.db.prepare('SELECT * FROM content_opportunities WHERE recommendation_id=?').all(recommendationId);
    const opportunityId=input.opportunityId || (pendingOnly?null:row.opportunity_id);
    if(input.decision==='approved_article') {
      const path=paths.find(p=>p.id===opportunityId);
      if(!path)throw Object.assign(new Error('必须明确选择属于这条建议的创作路径。'),{statusCode:409});
      if(input.proposalFingerprint && input.proposalFingerprint!==proposalFingerprint(path))throw Object.assign(new Error('创作范围已变化，请刷新并重新确认。'),{statusCode:409});
      if(APPROVED.has(path.status))return {recommendationId,opportunityId,status:'skipped',reason:'这条路径已经批准，不重复启动。',queued:false};
    }else if(paths.some(p=>APPROVED.has(p.status))){
      return {recommendationId,status:'skipped',reason:'已有获批创作路径；请在内容任务中处理，不能覆盖批准记录。'};
    }
    const result=repository.decideRecommendation(recommendationId,input.decision,input.note || '',{opportunityId});
    return result;
  });
}

// One HTTP request, independently atomic decisions. Never infer an approval path.
export function decideRecommendationsBulk(repository, payload) {
  if (!DECISIONS.has(payload?.decision) || !Array.isArray(payload.items) || !payload.items.length || payload.items.length > 100) {
    throw Object.assign(new Error('请选择有效处理方式和 1–100 条建议。'), { statusCode: 400 });
  }
  const seen = new Set();
  const results = payload.items.map(input => {
    const recommendationId = String(input?.recommendationId || '');
    if (!recommendationId || seen.has(recommendationId)) return { recommendationId, status:'skipped', reason:'空编号或本次请求中的重复建议。' };
    seen.add(recommendationId);
    try {
      return transaction(repository.db, () => {
        const row = repository.db.prepare('SELECT id,decision,updated_at FROM content_recommendations WHERE id=?').get(recommendationId);
        if (!row) return { recommendationId,status:'failed',reason:'建议不存在。' };
        if (row.decision !== 'pending') return { recommendationId,status:'skipped',reason:'已有人工决定，不重复处理或覆盖。' };
        if (!input.updatedAt || input.updatedAt !== row.updated_at) return { recommendationId,status:'failed',reason:'建议已更新，请刷新并重新确认。' };
        const paths = repository.db.prepare('SELECT id,status FROM content_opportunities WHERE recommendation_id=?').all(recommendationId);
        if (paths.some(path => APPROVED.has(path.status))) return { recommendationId,status:'skipped',reason:'已有获批创作路径，请在单条路径中继续处理。' };
        if (payload.decision === 'approved_article' && !paths.some(path => path.id === input.opportunityId)) {
          return { recommendationId,status:'failed',reason:'必须明确选择属于这条建议的创作路径。' };
        }
        const decision = decideRecommendationCommand(repository,{recommendationId,decision:payload.decision,note:'管理员在建议页批量确认。',
          updatedAt:input.updatedAt,proposalFingerprint:input.proposalFingerprint,opportunityId:payload.decision === 'approved_article' ? input.opportunityId : null,
        },{pendingOnly:true});
        if (!decision) throw new Error('未保存决定。');
        return { ...decision,recommendationId,status:decision.status==='skipped'?'skipped':'processed',outcome:decision.status };
      });
    } catch (error) {
      return { recommendationId,status:'failed',reason:error.message };
    }
  });
  return { results,processed:results.filter(r=>r.status==='processed').length,
    skipped:results.filter(r=>r.status==='skipped').length,failed:results.filter(r=>r.status==='failed').length,
    queued:results.filter(r=>r.queued).length };
}
