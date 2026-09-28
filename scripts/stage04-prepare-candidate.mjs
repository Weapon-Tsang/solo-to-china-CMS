// Reproducible local-only payload preparation; no data adoption or production promotion.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {inventory,runtimeEntries} from './stage04-local-preflight.mjs';
const root=process.cwd();
const evidence=path.join(root,'docs/codex-cms-upgrade/evidence/phase-04-fixes');
const location=JSON.parse(fs.readFileSync(path.join(evidence,'artifact-location.json'),'utf8').replace(/^\uFEFF/,''));
const preflight=JSON.parse(fs.readFileSync(path.join(location.output,'preflight.json')));
const release=path.resolve(process.argv[2] || '');
const reuse=process.argv.includes('--reuse');
if(!process.argv[2] || (fs.existsSync(release)&&!reuse))throw new Error('A new independent release directory is required (or --reuse with byte verification)');
for(let p=release;p!==path.dirname(p);p=path.dirname(p))if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw new Error('Symlink refused');
if(release===root||release.startsWith(root+path.sep)||root.startsWith(release+path.sep))throw new Error('Release must be outside checkout');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if(!reuse)fs.cpSync(path.join(location.output,'runtime'),release,{recursive:true,errorOnExist:true});
for(const f of preflight.artifact.files)if(hash(path.join(release,f.path))!==f.sha256)throw new Error('Payload mismatch');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>['path','systemroot','windir','temp','tmp','comspec','pathext'].includes(key.toLowerCase())));
const emptyConfig=path.join(evidence,'empty-npmrc');fs.writeFileSync(emptyConfig,'# No user credentials or lifecycle scripts\n');
const globalConfig=path.join(evidence,'empty-global-npmrc');fs.writeFileSync(globalConfig,'# No global credentials\n');
Object.assign(env,{NPM_CONFIG_USERCONFIG:emptyConfig,NPM_CONFIG_GLOBALCONFIG:globalConfig,NPM_CONFIG_CACHE:path.join(path.dirname(release),'npm-cache'),NPM_CONFIG_REGISTRY:'https://registry.npmjs.org'});
const npm=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
if(reuse&&!fs.existsSync(path.join(release,'node_modules/.package-lock.json')))throw new Error('Installed lock missing');
const install=reuse?{status:0}:spawnSync(process.execPath,[npm,'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:release,env,encoding:'utf8',windowsHide:true,timeout:240000});
if(!reuse)fs.writeFileSync(path.join(evidence,'candidate-install.log'),install.stdout+'\n'+install.stderr);
if(install.status!==0)throw new Error(`npm ci failed: ${install.status}; candidate retained`);
const fixed=path.join(evidence,'fixed-contract');fs.mkdirSync(fixed,{recursive:true});
const gate=JSON.parse(fs.readFileSync(path.join(release,'config/release-gate.json'))).frontend;
for(const name of ['component-registry.json','page-schema.json','cms-publish-package.schema.json']){
  let text=execFileSync('git',['-C',path.join(root,'../solo-to-china'),'show',`${gate.commitSha}:contracts/${name}`],{encoding:'utf8'});
  // Reconstruct the declared Registry transport newline, as the existing cross-repo gate does.
  if(name==='component-registry.json'){
    const publish=JSON.parse(execFileSync('git',['-C',path.join(root,'../solo-to-china'),'show',`${gate.commitSha}:contracts/cms-publish-package.schema.json`],{encoding:'utf8'}));
    const declared=publish.properties.contract.properties.contractChecksum.const;
    const digest=t=>crypto.createHash('sha256').update(t).digest('hex');
    if(digest(text)!==declared){const converted=text.replace(/\r?\n$/,'')+'\r\n';if(digest(converted)!==declared)throw new Error('Registry checksum mismatch');text=converted;}
  }
  fs.writeFileSync(path.join(fixed,name),text);
}
const smoke=spawnSync(process.execPath,[path.join(root,'scripts/stage04-candidate-smoke.mjs'),release,`${release}-synthetic-${Date.now()}`,evidence],{cwd:release,env,encoding:'utf8',windowsHide:true,timeout:60000});
fs.writeFileSync(path.join(evidence,'candidate-smoke.log'),smoke.stdout+'\n'+smoke.stderr);
if(smoke.status!==0)throw new Error(`Candidate smoke failed: ${smoke.status}; retained`);
// The file-only payload does not materialize empty directories (e.g. public).
const files=inventory(release,runtimeEntries.filter(entry=>fs.existsSync(path.join(release,entry))));
if(JSON.stringify(files)!==JSON.stringify(preflight.artifact.files))throw new Error('Installed payload changed');
const report={release,output:location.output,manifest_sha256:location.manifest_sha256,files,
  packageLockSha256:hash(path.join(release,'package-lock.json')),install:'npm ci --omit=dev --ignore-scripts --no-audit --no-fund',
  installExit:install.status,smokeExit:smoke.status,node:process.version,platform:process.platform,arch:process.arch,
  dependenciesIncludedInZip:false,containerDigest:null};
fs.writeFileSync(path.join(evidence,'candidate.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({release,installExit:install.status,smokeExit:smoke.status}));
