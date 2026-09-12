import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const revision='2395fe4ed68f7414d777d0156770af76e858eb1b';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stc-baseline-test-'));
try{
  const checkout=path.join(directory,'source');
  execFileSync('git',['worktree','add','--detach',checkout,revision],{cwd:root,stdio:'pipe'});
  fs.symlinkSync(path.join(root,'node_modules'),path.join(checkout,'node_modules'),process.platform==='win32'?'junction':'dir');
  const reportRoot=path.join(root,'output','reliability-2026-09-12');fs.mkdirSync(reportRoot,{recursive:true});
  const outputFile=path.join(reportRoot,'baseline-current-test-scope.log');const output=fs.createWriteStream(outputFile);
  const started=Date.now();
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--test','test/**/*.test.mjs'],{cwd:checkout,windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',data=>output.write(data));child.stderr.on('data',data=>output.write(data));
    child.on('error',reject);child.on('close',resolve);
  });
  await new Promise(resolve=>output.end(resolve));
  const text=fs.readFileSync(outputFile,'utf8');
  const result={revision,node:process.version,scope:'test/**/*.test.mjs',exitCode:code,durationMs:Date.now()-started,
    summary:text.split('\n').filter(line=>/^.[ ]?(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s/.test(line)),log:path.relative(root,outputFile).replaceAll('\\','/')};
  fs.writeFileSync(path.join(root,'docs','audit','CMS_BASELINE_TESTS_2026-09-12.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
  if(code)process.exitCode=code;
}finally{
  if(path.dirname(directory)!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('stc-baseline-test-'))throw new Error('Unsafe cleanup target');
  // Remove the dependency junction itself before recursively clearing only our
  // isolated checkout. Never traverse the shared dependency directory.
  const junction=path.join(directory,'source','node_modules');if(fs.existsSync(junction))fs.unlinkSync(junction);
  const checkout=path.join(directory,'source');
  if(fs.existsSync(path.join(checkout,'.git')))execFileSync('git',['worktree','remove','--force',checkout],{cwd:root,stdio:'pipe'});
  fs.rmSync(directory,{recursive:true,force:true});
}
