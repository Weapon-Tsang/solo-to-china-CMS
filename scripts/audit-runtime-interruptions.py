"""Read all retained logs of production/rollback containers without mutation."""
import collections
import datetime
import json
import re
import subprocess


def run(args):
    result=subprocess.run(['docker',*args],capture_output=True,text=True,timeout=60)
    if result.returncode:raise RuntimeError('Docker read failed: '+args[0])
    return result


names=[n for n in run(['ps','-a','--format','{{.Names}}']).stdout.splitlines()
       if re.fullmatch(r'engine(?:-worker)?(?:-before-[a-zA-Z0-9_-]+)?',n)]
report={'version':'runtime-interruption-history-1','readOnly':True,'productionWrites':0,
        'collectedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'containers':[]}
for name in names:
    state=json.loads(run(['inspect','--format','{{json .State}}',name]).stdout)
    result=run(['logs',name]);lines=(result.stdout+'\n'+result.stderr).splitlines()
    events=[];other=collections.Counter();first=None;last=None
    for line in lines:
        try:entry=json.loads(line)
        except ValueError:
            if re.search(r'error|fatal|out of memory|killed|uncaught|unhandled',line,re.I):
                other[re.sub(r'(?i)(Bearer\s+|token[=:]\s*)\S+',r'\1[REDACTED]',line)[:1500]]+=1
            continue
        if not isinstance(entry,dict):continue
        timestamp=entry.get('timestamp')
        if timestamp:first=min(first or timestamp,timestamp);last=max(last or timestamp,timestamp)
        if entry.get('level') in ('warn','error',30,40,50):
            # Only diagnostic fields, never request headers, bodies or sessions.
            events.append({k:entry[k] for k in ['timestamp','level','event','jobId','jobType','entityId','attempt','error','reason','count'] if k in entry})
    report['containers'].append({'name':name,'state':{k:state.get(k) for k in ['Status','OOMKilled','Dead','ExitCode','Error','StartedAt','FinishedAt']},
      'lineCount':len(lines),'firstLogAt':first,'lastLogAt':last,'events':events,'unstructuredErrors':dict(other)})
print(json.dumps(report,ensure_ascii=True,separators=(',',':')))
