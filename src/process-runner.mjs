import { spawn } from "node:child_process";

export function runNodeJsonProcess(scriptPath,args=[],{timeoutMs=30*60_000,maxOutputBytes=2*1024*1024,env={}}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[scriptPath,...args.map(String)],{
      env:{...process.env,...env},stdio:["ignore","pipe","pipe"],windowsHide:true,
    });
    let stdout="",stderr="",settled=false;
    const append=(current,chunk)=>`${current}${chunk}`.slice(-maxOutputBytes);
    child.stdout.on("data",(chunk)=>{stdout=append(stdout,chunk);});
    child.stderr.on("data",(chunk)=>{stderr=append(stderr,chunk);});
    const timer=setTimeout(()=>{
      if(settled)return;
      settled=true;child.kill("SIGTERM");
      reject(Object.assign(new Error(`Isolated process timed out after ${timeoutMs} ms.`),{code:"ISOLATED_TASK_TIMEOUT",stderr}));
    },timeoutMs);
    timer.unref?.();
    child.on("error",(error)=>{if(settled)return;settled=true;clearTimeout(timer);reject(error);});
    child.on("exit",(code,signal)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      if(code!==0)return reject(Object.assign(new Error(`Isolated process exited with ${code??signal}: ${stderr.trim()||"no diagnostic"}`),
        {code:"ISOLATED_TASK_FAILED",exitCode:code,signal,stderr}));
      try{
        const body=stdout.trim()||"{}";
        try{return resolve(JSON.parse(body));}catch{}
        const line=body.split(/\r?\n/u).filter(Boolean).at(-1)||"{}";
        resolve(JSON.parse(line));
      }catch(error){reject(Object.assign(new Error(`Isolated process returned invalid JSON: ${error.message}`),{code:"ISOLATED_TASK_OUTPUT",stdout,stderr}));}
    });
  });
}
