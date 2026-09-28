import { loadConfig } from "../src/config.mjs";
import { promoteReviewedLocalDataRoot } from "../src/local-runtime.mjs";

const config = loadConfig();
if (config.deployment.runMode !== "migration-review") throw new Error("Set CMS_RUN_MODE=migration-review to inspect before promotion.");
if (process.argv.length !== 3 || process.argv[2] !== "--old-host-stopped") {
  throw new Error("Explicit --old-host-stopped attestation is required; this command cannot verify another host automatically.");
}
console.log(JSON.stringify(promoteReviewedLocalDataRoot(config, { oldHostStopped: true }), null, 2));
