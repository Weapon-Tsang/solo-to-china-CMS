import {writeFile,mkdir} from 'node:fs/promises';
const token=process.env.STC_DIAGNOSTIC_TOKEN;
if(!token) throw new Error('STC_DIAGNOSTIC_TOKEN required');
const response=await fetch('https://engine.solotochina.com/api/recommendations?limit=500',{headers:{Authorization:`Bearer ${token}`}});
if(!response.ok) throw new Error(`HTTP ${response.status}`);
const data=await response.json();
const count=(rows,key)=>Object.fromEntries([...Map.groupBy(rows,r=>String(r[key]))].map(([k,v])=>[k,v.length]));
await mkdir('output',{recursive:true});
await writeFile('output/intake-gates-snapshot.json',JSON.stringify(data,null,2));
console.log(JSON.stringify({recommendations:data.items.length,distinctSources:new Set(data.items.map(r=>r.source_id)).size,
 classifications:count(data.items,'classification'),decisions:count(data.items,'decision'),
 opportunities:data.opportunities.length,statuses:count(data.opportunities,'status'),
 ready:data.opportunities.filter(o=>o.readiness?.ready).length,
 perSource:count(data.opportunities,'source_id')},null,2));
