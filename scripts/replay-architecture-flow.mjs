import {spawnSync} from 'node:child_process';
import path from 'node:path';
const result=spawnSync(process.execPath,['--test','test/content-pipeline.test.mjs'],{
  stdio:'inherit',windowsHide:true,env:{...process.env,
    CMS_ARCHITECTURE_REPLAY_REPORT:path.resolve('output/architecture-audit-20261004/controlled-full-chain')},
});
if(result.error)throw result.error;
process.exitCode=result.status ?? 1;
