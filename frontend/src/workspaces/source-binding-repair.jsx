import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { PdfSourceSupplement } from './pdf-source-supplement';

const byteStates={not_checked:'未检查',no_local_reference:'没有本地原件引用',missing:'本地文件缺失',invalid:'文件内容无效',
  verified:'文件指纹和格式检查通过',budget_exhausted:'超出本次检查预算',access_denied:'无法读取文件'};
const diagnosticReasons={PDF_ASSET_NOT_MATERIALIZED:'PDF 尚未拆出独立图片',BYTES_INVALID:'原件格式或文件指纹不符',
  BINDING_NEGATED:'来源明确否定该实体关系',
  BYTES_NOT_CHECKED:'原件暂时无法检查',BINDING_CONFLICT:'来源关系存在明确冲突',SLOT_TOO_SPECIFIC:'槽位要求超出图片证据范围',
  MATCH_REJECTED:'不符合当前槽位用途',RETRIEVAL_MISS:'尚未进入本次候选'};

const states = { confirmed:'来源证据支持',candidate:'候选关系',ambiguous:'存在歧义',conflict:'存在冲突',stale:'已过期',revoked:'已撤销' };
const reasons = { SOURCE_BINDING_SUPPORTED:'来源证据支持',BINDING_AMBIGUOUS:'关系有歧义',BINDING_CANDIDATE:'关系仍待核实',
  BINDING_ENTITY_UNRESOLVED:'证据中的实体尚未归一',BINDING_EVIDENCE_MISSING:'缺少明确的图文关系证据',
  BINDING_REVOKED:'已撤销的关系保持撤销',CONTEXT_PENDING:'上下文仍待补充',CONTEXT_MISSING:'自动补读后仍有遗漏，请分页查看证据',
  ORIGINAL_MISSING:'尚无已保存原件记录',ANALYSIS_MISSING:'画面分析尚未完成',CONTEXT_STALE:'分析或关联版本已过期' };

export function SourceBindingRepair({ assetId }) {
  const [report,setReport] = useState(null);
  const [diagnostics,setDiagnostics] = useState(null);
  const [showSupplement,setShowSupplement] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const controller = useRef(null);
  const endpoint = `/api/source-assets/${encodeURIComponent(assetId)}/binding-repair`;
  const inspect = async () => {
    if(controller.current) return;
    const request=new AbortController();controller.current=request;setBusy(true);setError('');
    try {
      const result=await api(`/api/source-assets/${encodeURIComponent(assetId)}/media-diagnostics`,{signal:request.signal});
      if(!request.signal.aborted) setDiagnostics(result);
    } catch(caught) { if(!request.signal.aborted) setError(caught.message); }
    finally { if(!request.signal.aborted) setBusy(false);controller.current=null; }
  };
  useEffect(() => () => controller.current?.abort(), [assetId]);
  const load = async (apply = false) => {
    if (controller.current) return;
    const request = new AbortController(); controller.current = request;
    setBusy(true); setError('');
    try {
      const next = await api(endpoint,{signal:request.signal,...(apply ? {method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({apply:true,expectedHash:report.preview_hash})} : {})});
      if (!request.signal.aborted) setReport(next);
    } catch (caught) {
      if (!request.signal.aborted) {
        setReport(null);
        setError(caught.code === 'CONTEXT_STALE' ? '关系预览已过期，请重新检查后再修复。'
          : caught.code === 'PDF_ASSET_NOT_MATERIALIZED' ? '此项是 PDF 页面证据，尚未生成独立图片原件，不能作为照片修复关系。需要先提取或补充对应图片。' : caught.message);
      }
    } finally {
      if (!request.signal.aborted) setBusy(false);
      controller.current = null;
    }
  };
  return <section aria-label="来源关系修复" aria-busy={busy} className="mt-3 min-w-0 border-t border-slate-200 pt-3 text-xs text-slate-700">
    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void load()}>检查来源关系</Button>
    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void inspect()}>检查文件与缺图原因</Button>
    {diagnostics && <div aria-label="媒体诊断" className="my-2 break-words">
      <p>检查范围：当前图片、直接引用槽位和冻结包；未扫描其他素材。文件检查：{byteStates[diagnostics.bytes.status] || diagnostics.bytes.status}。</p>
      <ul>{Object.keys(diagnostics.reason_counts).map(reason=><li key={reason}>{diagnosticReasons[reason] || reasons[reason] || reason}</li>)}</ul>
      {diagnostics.document_capability && <><p>PDF 本体仍是文档证据；当前不支持自动分离单图。</p>
        <Button type="button" disabled={busy} onClick={()=>setShowSupplement(true)}>为这份PDF补充图片</Button>
        {showSupplement && <PdfSourceSupplement assetId={assetId} />}</>}
      <p>槽位：{diagnostics.slots.length}{diagnostics.has_more ? '（还有未检查范围）' : ''}。原因可重叠，未检查不代表无图。</p>
      <p>冻结包引用：{diagnostics.frozen_references.length}{diagnostics.frozen_references_has_more ? '（还有更多）' : ''}。修复来源关系不会改写这些已保存的输入。</p>
      <ul>{diagnostics.slots.map(slot=><li key={slot.slot_id}>{slot.draft_id} / {slot.slot}：{slot.reason_codes.map(reason=>diagnosticReasons[reason] || reasons[reason] || reason).join('、') || '关系支持，尚未采用'}</li>)}</ul>
    </div>}
    {error && <p role="alert" className="my-2 break-words text-rose-700">{error}</p>}
    <p role="status" className="my-2">{busy ? '正在核对来源关系…' : report?.applied ? '来源关系已修复。文章采用和媒体修订需在文章流程中处理。' : ''}</p>
    {report && <>
      <p>已保存关系 {report.old_bindings.length} 条；本次关系 {report.new_bindings.length} 条。自动补读 {report.supplementation.read_count} 次，{report.supplementation.added_chars} 字符。</p>
      <ul className="my-2 list-inside list-disc">
        {Object.keys(report.reason_counts).map(reason => <li key={reason}>{diagnosticReasons[reason] || reasons[reason] || reason}</li>)}
      </ul>
      <details className="my-2">
        <summary className="cursor-pointer">查看旧关系</summary>
        {report.old_bindings.length ? <ul>{report.old_bindings.map(row => <li key={row.id} className="break-words">{row.entity_key} · {states[row.status] || row.status}</li>)}</ul> : <p>尚无关系记录。</p>}
      </details>
      {report.new_bindings.length ? <ul className="my-2 space-y-2" aria-label="本次关系证据">
        {report.new_bindings.map(row => <li key={row.id} className="break-words">
          <strong>{row.canonical_subject}</strong> · {states[row.status] || row.status}
          {row.evidence.map((proof,index) => <blockquote key={index} className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap border-l-2 border-slate-200 pl-2">{proof.quote}</blockquote>)}
        </li>)}
      </ul> : <p>没有足够证据建立实体关系，请核对图注和原文。</p>}
      <p className="my-2">引用该图的文章槽位：{report.affected_slots.length}{report.affected_slots_has_more ? '（另有更多）' : ''}。本次仅修复来源关系，保留原文和画面分析，不调用模型。</p>
      <Button type="button" size="sm" disabled={busy || report.applied} onClick={() => void load(true)}>按此预览修复关系</Button>
    </>}
  </section>;
}
