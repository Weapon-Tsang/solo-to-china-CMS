import { loadConfig } from '../src/config.mjs';
import { createApplication } from '../src/server.mjs';

const role=process.env.TEST_PROCESS_ROLE;
const app=createApplication(loadConfig({...process.env,CMS_PROCESS_ROLE:role,
  HOST:'127.0.0.1',PORT:'0',MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error'}));
if (role==='worker') app.startWorker();
else await app.start();
process.stdout.write(`READY ${role} ${app.server.address()?.port || 0}\n`);
process.stdin.once('data',async()=>{await app.stop();process.exit(0);});
