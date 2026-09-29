import sqlite3,json
from pathlib import Path
p=Path('/var/lib/docker/volumes/solo_to_china_data/_data/failed-database-1790625139987/database.sqlite')
d=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True);d.row_factory=sqlite3.Row
d.execute('PRAGMA query_only=ON');d.execute('BEGIN')
rows=lambda sql,args=():[dict(r) for r in d.execute(sql,args)]
audit=json.loads(Path('/opt/solo-to-china/upgrades/a11bcf1711c6b31b52725cdc925c4817629037f3/opportunity-audit.json').read_text())
ids=[r['id'] for r in audit['admissionQuality']['samples']['knowledgeAdmission']]
families={r['source_id']:r['family_id'] for r in rows('SELECT source_id,family_id FROM source_family_memberships')}
complete={r['id'] for r in rows("""SELECT s.id FROM sources s WHERE s.completeness_status='complete' AND s.status IN ('processed','needs_ai')
AND NOT EXISTS(SELECT 1 FROM current_source_assets a WHERE a.source_id=s.id AND a.durability_status<>'ORIGINAL_STORED')
AND EXISTS(SELECT 1 FROM experience_extraction_runs er WHERE er.source_id=s.id AND er.capture_version=s.capture_version AND er.status='succeeded' AND er.degraded=0)""")}
result=[]
for id in ids:
 o=rows('SELECT * FROM content_opportunities WHERE id=?',(id,))[0]
 coverage=json.loads(o['coverage_json']);readiness=json.loads(o['readiness_json'])
 selected=set(coverage['selectedFactKeys'])
 facts=rows('SELECT k.id,k.normalized_key,k.consensus_status,k.validity_state,k.visibility_status,k.evidence_json,k.preferred_value,r.status resolution_status FROM knowledge_facts k JOIN destinations dst ON dst.id=k.destination_id LEFT JOIN knowledge_resolutions r ON r.destination_slug=dst.slug AND r.normalized_key=k.normalized_key WHERE dst.slug=?',(o['destination_slug'],))
 cluster=[c for c in rows('SELECT * FROM topic_clusters WHERE destination_slug=?',(o['destination_slug'],)) if set(json.loads(c['claim_keys_json'])).issuperset(selected)]
 cluster=next((c for c in cluster if o['title']==c['title']+': a practical guide for independent travelers'),None)
 keys=set(json.loads(cluster['claim_keys_json'])) if cluster else selected
 def fam(f):return sorted({families.get(e.get('source_id')) or 'source:'+e['source_id'] for e in json.loads(f['evidence_json']) if e.get('source_id') in complete})
 topology=[{'id':f['id'],'key':f['normalized_key'],'selected':f['normalized_key'] in selected,'consensus':f['consensus_status'],'validity':f['validity_state'],'visibility':f['visibility_status'],'resolved':f['resolution_status'],'families':fam(f)} for f in facts if f['normalized_key'] in keys]
 allfam=sorted({x for f in topology if f['visibility']=='visible' for x in f['families']});selfam=sorted({x for f in topology if f['selected'] for x in f['families']})
 links={t:rows('SELECT COUNT(*) n FROM '+t+' WHERE opportunity_id=?',(id,))[0]['n'] for t in ['topic_candidates','editorial_assemblies']}
 result.append({'id':id,'status':o['status'],'lifecycle':o['lifecycle_state'],'approved_at':o['approved_at'],'candidate_id':o['candidate_id'],'productionLinks':links,'created_at':o['created_at'],'updated_at':o['updated_at'],'stored':readiness['sourceFamilyCount'],'allCount':len(allfam),'selectedCount':len(selfam),'extraFamilies':sorted(set(allfam)-set(selfam)),'topology':topology})
print(json.dumps({'path':str(p),'schema':rows('SELECT MAX(version) version FROM schema_migrations')[0]['version'],'records':result}))
d.rollback();d.close()
