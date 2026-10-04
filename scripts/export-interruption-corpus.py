"""Fixed, SELECT-only regression sample, excluding credentials and binary payloads."""
import base64
import gzip
import json
import sqlite3
import sys

db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
db.row_factory=sqlite3.Row
db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
tables={}
excluded={'raw_payload_json','ai_derivative_data_url'}
def take(table,where='1',params=()):
    columns=[r[1] for r in db.execute('PRAGMA table_info("'+table+'")') if r[1] not in excluded]
    if not columns:return []
    result=[dict(r) for r in db.execute('SELECT '+','.join('"'+c+'"' for c in columns)+' FROM "'+table+'" WHERE '+where,params)]
    tables[table]=result
    return result
def inside(table,column,ids):return take(table,column+' IN ('+','.join('?' for _ in ids)+')',tuple(ids)) if ids else []
try:
    draft_ids=['draft_5a78fe03455e44ddac1b009e2301c8cb','draft_b736635093994a6f9501daf703362355']
    source_ids={'src_6dc34bb235f94932be6587cd906ce317','src_00f770704f8d4635ab3b4a5fe53f963a'}
    drafts=inside('article_drafts','id',draft_ids)
    briefs=inside('content_briefs','id',[d['brief_id'] for d in drafts])
    candidates=inside('topic_candidates','id',[b['candidate_id'] for b in briefs])
    owners=inside('content_opportunities','candidate_id',[c['id'] for c in candidates])
    for table,column,ids in [('writing_packets','brief_id',[b['id'] for b in briefs]),
      ('article_visuals','draft_id',draft_ids),('visual_candidates','draft_id',draft_ids),
      ('required_media_manifests','draft_id',draft_ids),('production_record_controls','opportunity_id',[o['id'] for o in owners])]:inside(table,column,ids)
    facts=inside('knowledge_facts','normalized_key',list({k for b in briefs for k in json.loads(b['evidence_ledger_json'])}))
    for fact in facts:
        for e in json.loads(fact.get('evidence_json') or '[]'):
            if e.get('source_id'):source_ids.add(e['source_id'])
    # Source media discovery also uses entity bindings from the same destination.
    bindings=inside('media_bindings','destination_slug',['chongqing'])
    source_ids.update(r['source_id'] for r in db.execute("SELECT DISTINCT sa.source_id FROM source_assets sa JOIN media_bindings mb ON mb.asset_id=sa.id WHERE mb.destination_slug='chongqing'"))
    for table in ['sources','structured_sources','source_assets','source_segments','extraction_runs','evidence_spans',
      'claims','experience_extraction_runs','experience_blocks','source_asset_analyses','media_occurrences']:
        inside(table,'id' if table=='sources' else 'source_id',list(source_ids))
    asset_ids=[a['id'] for a in tables['source_assets']]
    inside('source_asset_storage_refs','asset_id',asset_ids)
    inside('entity_aliases','destination_slug',['chongqing','changsha'])
    inside('destinations','slug',['chongqing','changsha'])
    entities=list(source_ids)+draft_ids+[b['id'] for b in briefs]+[c['id'] for c in candidates]
    jobs=inside('jobs','entity_id',entities)
    inside('production_failure_diagnostics','job_id',[j['id'] for j in jobs])
    inside('pipeline_step_receipts','entity_id',entities)
    visuals=[v['id'] for v in tables['article_visuals']]+['visual_1c542c3e15834cb48656ce5e537f44bd']
    inside('media_dispatches','visual_id',visuals)
    take('media_visual_lane');take('media_quota_scopes')
    report={'version':1,'productionWrites':0,'tables':tables}
    print(base64.b64encode(gzip.compress(json.dumps(report,ensure_ascii=True).encode())).decode())
finally:db.rollback();db.close()
