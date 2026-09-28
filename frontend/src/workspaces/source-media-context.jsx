import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api';
import { SourceBindingRepair } from './source-binding-repair';

const fields = { source_text: '来源正文', caption: '独立图注', nearby: '附近文字', alt: '图片说明' };
const pageSize = 12;

export function SourceMediaContext({ assets = [] }) {
  const images = assets.filter(asset => asset.kind === 'image');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(null);
  if (!images.length) return null;
  return <Card className="mb-3 min-w-0 p-4 shadow-none">
    <h3 className="text-xs font-semibold text-slate-900">图片与来源文字</h3>
    <p className="my-2 text-xs text-slate-600">查看每张图的图注、明确图号和原文。文字关联不代表照片能证明交通或路线顺序。</p>
    <div className="flex flex-wrap gap-2" aria-label="选择图片上下文">
      {images.slice(page * pageSize, (page + 1) * pageSize).map(asset => <Button key={asset.id}
        type="button" size="sm" variant={selected === asset.id ? 'secondary' : 'outline'}
        aria-pressed={selected === asset.id} onClick={() => setSelected(asset.id)}>
        图片 {Number(asset.position ?? images.indexOf(asset)) + 1}
      </Button>)}
    </div>
    {images.length > pageSize && <div className="mt-2 flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>上一组图片</Button>
      <span className="text-xs text-slate-600">第 {page + 1} / {Math.ceil(images.length / pageSize)} 组</span>
      <Button type="button" size="sm" variant="outline" disabled={(page + 1) * pageSize >= images.length} onClick={() => setPage(page + 1)}>下一组图片</Button>
    </div>}
    {selected && <div key={selected}><ContextReader assetId={selected} /><SourceBindingRepair assetId={selected} /></div>}
  </Card>;
}

function ContextReader({ assetId }) {
  const [packet, setPacket] = useState(null);
  const [field, setField] = useState('source_text');
  const [range, setRange] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef(null);
  const endpoint = `/api/source-assets/${encodeURIComponent(assetId)}/context`;
  const read = async (nextField = field, start = 0, refresh = false) => {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setBusy(true); setError('');
    try {
      const nextPacket = refresh || !packet ? await api(endpoint, { signal: request.signal }) : packet;
      const contextHash = nextPacket.assets[0].context_hash;
      const query = new URLSearchParams({ field: nextField, start: String(start), maxChars: '4000', contextHash });
      const nextRange = await api(`${endpoint}?${query}`, { signal: request.signal });
      if (request.signal.aborted) return;
      setPacket(nextPacket); setRange(nextRange); setField(nextField);
    } catch (caught) {
      if (request.signal.aborted) return;
      setError(caught.code === 'CONTEXT_STALE' ? '来源文字已更新，请重新读取后查看；旧片段已停止显示。' : caught.message);
      setRange(null);
    } finally { if (!request.signal.aborted) setBusy(false); }
  };
  useEffect(() => { void read('source_text', 0, true); return () => controller.current?.abort(); }, [assetId]);
  return <div className="mt-3 min-w-0 border-t border-slate-200 pt-3" aria-busy={busy}>
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-xs text-slate-700">证据类型
        <select className="ml-2 rounded-md border border-slate-300 bg-white p-2" value={field}
          disabled={busy} onChange={event => void read(event.target.value)}>
          {Object.entries(fields).map(([value, title]) => <option key={value} value={value}>{title}</option>)}
        </select>
      </label>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void read(field, 0, true)}>重新读取上下文</Button>
    </div>
    <p role="status" className="my-2 text-xs text-slate-600">{busy ? '正在读取已保存的证据…' : packet
      ? `捕获版本 ${packet.capture_version} · ${packet.truncated ? '当前上下文超出单次输入，可分页查看原文' : '当前上下文完整'} · 明确图号关联 ${packet.assets[0].explicit_block_ids.length} 处` : ''}</p>
    {error && <p role="alert" className="my-2 break-words text-xs text-rose-700">{error}</p>}
    {range && <>
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-slate-50 p-3 text-xs leading-relaxed text-slate-700">{range.text || '此字段没有保存内容。'}</pre>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={busy || range.start === 0} onClick={() => void read(field, Math.max(0, range.start - 4000))}>上一段证据</Button>
        <span className="text-xs text-slate-600">字符 {range.start}–{range.end} / {range.total_chars}</span>
        <Button type="button" size="sm" variant="outline" disabled={busy || !range.has_more} onClick={() => void read(field, range.next_offset)}>下一段证据</Button>
      </div>
    </>}
  </div>;
}
