// Offline inventory only: never loads .env, opens a database, installs, or deploys.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectCoverContract} from '../src/cover-contract.mjs';

export const runtimeEntries=['src','config','dist','extension','vendor','public','docs/content-strategy',
  'package.json','package-lock.json','scripts/local-runtime-status.mjs','scripts/inspect-local-data.mjs',
  'scripts/promote-local-data.mjs'];
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function assessPreflight({prerequisites,contract,manualEvidence,routeEvidence,backupCoverage,sourceSchema,targetSchema}) {
  const blockers=[];
  if(!prerequisites)blockers.push('PREREQUISITE_EVIDENCE_MISSING');
  if(contract?.status!=='pinned_cache_verified')blockers.push('PINNED_CONTRACT_INVALID');
  if(!manualEvidence)blockers.push('BIND_MUP_EVIDENCE_MISSING');
  if(!routeEvidence)blockers.push('ROUTE_EVIDENCE_MISSING');
  if(!backupCoverage)blockers.push('MANUAL_ROUTE_RESTORE_EVIDENCE_MISSING');
  return {local_status:blockers.length?'BLOCKED':'PRECHECK_INPUTS_PRESENT',blockers,
    // This planner never authorizes execution, even if local evidence passes.
    production_status:'WAITING_AUTH',production_actions_enabled:false,
    release_class:Number.isInteger(sourceSchema)&&sourceSchema===targetSchema?'CODE_ONLY_RELEASE':
      Number.isInteger(sourceSchema)?'DATA_MIGRATION_RELEASE':'SOURCE_SCHEMA_VERIFICATION_REQUIRED',
    receiver:{status:'PENDING_ENV',cover_refresh:false,body_refresh:false,card_fields:false},
    route_external_fields:false,automatic_body_rewrite:false,paid_canary:false};
}

export function inventory(root,entries) {
  const result=[];
  function visit(relative) {
    const filename=path.resolve(root,relative),base=path.resolve(root);
    if(!filename.startsWith(`${base}${path.sep}`))throw new Error('Inventory path escapes CMS root');
    for(let parent=path.dirname(filename);parent!==base;parent=path.dirname(parent)) {
      if(fs.lstatSync(parent).isSymbolicLink())throw new Error(`Symlink ancestor rejected: ${relative}`);
    }
    const stat=fs.lstatSync(filename);
    if(stat.isSymbolicLink())throw new Error(`Symlink rejected: ${relative}`);
    if(stat.isDirectory())for(const name of fs.readdirSync(filename).sort())visit(path.join(relative,name));
    else if(stat.isFile())result.push({path:relative.replaceAll('\\','/'),bytes:stat.size,sha256:sha(fs.readFileSync(filename))});
    else throw new Error(`Non-regular file rejected: ${relative}`);
  }
  for(const entry of entries)visit(entry);
  return result.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}

export function secretFindings(root,files) {
  const findings=[];
  for(const {path:relative} of files) {
    if(!relative.endsWith('.example')&&/(^|\/)(\.env(?:\..*)?|credentials\.json|.*\.sqlite(?:-wal|-shm)?|.*\.har)$/i.test(relative)) {
      findings.push({path:relative,rule:'sensitive_filename'});continue;
    }
    if(!/\.(m?js|jsx|json|md|txt|ya?ml|ps1|sh|html|css|example)$/.test(relative))continue;
    const content=fs.readFileSync(path.join(root,relative),'utf8');
    const patterns=[['private_key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----(?:\s|\\n)*[A-Za-z0-9+/=]{32}/],
      ['google_api_key',/AIza[\w-]{35}/],['github_token',/\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
      ['openai_key',/\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/]];
    for(const [rule,pattern] of patterns)if(pattern.test(content))findings.push({path:relative,rule});
  }
  return findings; // Never include matching secret bytes in evidence.
}

function main() {
  const root=fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  if(fs.realpathSync(git('rev-parse','--show-toplevel'))!==root)throw new Error('CMS root mismatch');
  const remote=git('remote','get-url','origin');
  if(!/^(?:https:\/\/github\.com\/|git@github\.com:)Weapon-Tsang\/solo-to-china-CMS(?:\.git)?$/.test(remote))throw new Error('CMS remote mismatch');
  const evidencePaths=[
    'docs/codex-cms-upgrade/acceptance/phase-01-closeout.md',
    'docs/codex-cms-upgrade/evidence/phase-02/cd/local-acceptance.md',
    'docs/codex-cms-upgrade/evidence/phase-03/resume-04/checkpoint.md',
    'test-support/fixtures/stage03-pinned-contract.json',
  ];
  const evidence=inventory(root,evidencePaths);
  const contract=inspectCoverContract(JSON.parse(fs.readFileSync(path.join(root,evidencePaths[3]),'utf8')));
  const files=inventory(root,runtimeEntries);
  const sourceFiles=git('ls-files','--cached','--others','--exclude-standard','-z').split('\0').filter(Boolean)
    .filter(name=>fs.existsSync(path.join(root,name)));
  const workspace=inventory(root,sourceFiles);
  const scanned=[...new Map([...workspace,...files].map(file=>[file.path,file])).values()];
  const findings=secretFindings(root,scanned);
  if(findings.length) {
    console.log(JSON.stringify({status:'BLOCKED',secret_findings:findings},null,2));process.exitCode=1;return;
  }
  const schema=Number(/SCHEMA_VERSION\s*=\s*(\d+)/.exec(fs.readFileSync(path.join(root,'src/db.mjs'),'utf8'))?.[1]);
  const result={format:'cms-phase04-offline-preflight-1',at:new Date().toISOString(),root,remote,
    branch:git('branch','--show-current'),head:git('rev-parse','HEAD'),dirty:git('status','--porcelain').length>0,
    node:process.version,platform:process.platform,arch:process.arch,cpu_count:os.cpus().length,
    total_memory_bytes:os.totalmem(),target_schema:schema,source_schema:'NOT_READ',contract,evidence,
    status:'INVENTORY_ONLY_NOT_RELEASE_APPROVAL',secret_scan:{scope:'tracked and nonignored workspace plus every runtime artifact file',
      rules:'known key signatures and sensitive filenames; not an exhaustive secret detector',findings},
    artifact:{kind:'runtime payload, dependencies not installed, not a container image',
      manifest_sha256:sha(JSON.stringify(files)),files},workspace,
    external_calls:0,production_writes:0,production_operations_authorized:false};
  const output=path.join(root,'output',`phase04-${Date.now()}`);
  // Check every existing output ancestor before creating anything.
  for(let parent=output;parent!==path.dirname(parent);parent=path.dirname(parent)) {
    if(fs.existsSync(parent)&&fs.lstatSync(parent).isSymbolicLink())throw new Error('Output symlink rejected');
  }
  fs.mkdirSync(output,{recursive:true});
  for(const file of files) {
    const destination=path.join(output,'runtime',file.path);fs.mkdirSync(path.dirname(destination),{recursive:true});
    fs.copyFileSync(path.join(root,file.path),destination,fs.constants.COPYFILE_EXCL);
    if(sha(fs.readFileSync(destination))!==file.sha256)throw new Error('Artifact changed while copying');
  }
  fs.writeFileSync(path.join(output,'preflight.json'),`${JSON.stringify(result,null,2)}\n`,{flag:'wx'});
  console.log(JSON.stringify({status:result.status,output,manifest_sha256:result.artifact.manifest_sha256,
    files:files.length,contract:contract.status,schema,secret_findings:findings.length},null,2));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
