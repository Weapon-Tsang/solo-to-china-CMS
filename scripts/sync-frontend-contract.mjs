import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/db.mjs";
import { FrontendContractConsumer } from "../src/frontend-contract.mjs";
import { Repository } from "../src/repository.mjs";

const config = loadConfig();
const database = openDatabase(config.databasePath);
try {
  const repository = new Repository(database, { ...config.content, contentStrategy: config.contentStrategy });
  const consumer = new FrontendContractConsumer(repository, config.frontendContract);
  const result = await consumer.sync();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.code || "FRONTEND_CONTRACT_SYNC_FAILED"}: ${error.message || error}\n`);
  process.exitCode = 1;
} finally {
  database.close();
}
