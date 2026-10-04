import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Repository } from '../src/repository.mjs';
import { loadConfig } from '../src/config.mjs';
import { FrontendContractConsumer } from '../src/frontend-contract.mjs';
import { VertexImagen } from '../src/visuals/vertex-imagen.mjs';
import { WordPressDraftAdapter } from '../src/wordpress.mjs';

const databasePath = path.resolve(process.argv[2] || '');
if (!databasePath || !process.argv[2]) throw new Error('Pass an explicit database path.');
const db = new DatabaseSync(databasePath, { readOnly: true });
db.exec('PRAGMA query_only=ON');
try {
  const repository = new Repository(db);
  // An inspection process does not call createApplication, which normally
  // configures these capabilities. Its defaults would hide enabled stages.
  // Use this flag inside the running application's environment for UI parity.
  if (process.argv.includes('--runtime-config')) {
    const config = loadConfig();
    const selected = repository.getVisualSettings(config.visuals.defaultModel);
    repository.configureProductionCapabilities({
      frontendContract: new FrontendContractConsumer(repository, config.frontendContract).configured,
      visuals: new VertexImagen({ ...config.visuals, ...selected }).enabled,
      wordpress: new WordPressDraftAdapter(config.wordpress).enabled,
    });
  } else {
    // For an offline copy, infer recorded work rather than treating every
    // optional production subsystem as explicitly disabled.
    repository.configureProductionCapabilities({ frontendContract: undefined, visuals: undefined, wordpress: undefined });
  }
  const rows = repository.listContent({ productionOnly: true });
  console.log(JSON.stringify(rows.map((row) => ({
    opportunity_id: row.opportunity_id,
    title: row.title,
    draft_id: row.draft_id,
    draft_status: row.draft_status,
    lifecycle: row.production_state?.lifecycle,
    disposition: row.production_state?.disposition,
    stage_status: row.production_state?.stage_status,
    current_stage: row.production_state?.current_stage,
    recovery_target: row.production_state?.recovery_target,
    latest_error: row.production_state?.latest_error,
    latest_historical_error: row.production_state?.latest_historical_error,
    available_actions: row.production_state?.available_actions,
  })), null, 2));
} finally {
  db.close();
}
