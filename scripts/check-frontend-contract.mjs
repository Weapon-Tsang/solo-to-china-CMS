import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/db.mjs";
import { FrontendContractConsumer } from "../src/frontend-contract.mjs";
import { Repository } from "../src/repository.mjs";

const config = loadConfig();
const database = openDatabase(config.databasePath);
try {
  const repository = new Repository(database, { ...config.content, contentStrategy: config.contentStrategy });
  const consumer = new FrontendContractConsumer(repository, config.frontendContract);
  const diagnostics = consumer.diagnostics();
  process.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
  if (process.argv.includes("--require-valid") && !diagnostics.canCompose) {
    process.stderr.write("NO_VALID_FRONTEND_CONTRACT: no compatible Last Known Good contract is available.\n");
    process.exitCode = 1;
  }
} finally {
  database.close();
}
