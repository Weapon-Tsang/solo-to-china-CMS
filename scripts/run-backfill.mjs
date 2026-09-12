import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/db.mjs";
import { Repository } from "../src/repository.mjs";

const type = String(process.argv[2] || "");
const execute = process.argv.includes("--execute");
const approvalIndex = process.argv.indexOf("--approved-from");
const approvedFromRunId = approvalIndex >= 0 ? process.argv[approvalIndex + 1] : null;
const supported = new Set(["media","experience","recommendations","failed-production-cleanup","processing-gaps","media-storage"]);

if (!supported.has(type)) {
  process.stderr.write("Usage: node scripts/run-backfill.mjs <media|experience|recommendations|failed-production-cleanup|processing-gaps|media-storage> [--execute] [--approved-from <dry-run-id>]\n");
  process.exitCode = 2;
} else {
  const config = loadConfig();
  const database = openDatabase(config.databasePath);
  try {
    const repository = new Repository(database,{...config.content,sourceUploadsDir:config.manualSources.uploadDir});
    const options = {dryRun:!execute,approvedFromRunId};
    const result = type === "media" ? repository.enqueueMediaDurabilityBackfill(options)
      : type === "experience" ? repository.runExperienceBackfill(options)
        : type === "recommendations" ? repository.runRecommendationReconciliationBackfill(options)
          : type === "failed-production-cleanup" ? repository.runFailedProductionCleanupBackfill(options)
            : type === "processing-gaps" ? repository.runSourceProcessingGapRecovery(options)
              : repository.runMediaStorageMigrationEstimate(options);
    process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
  } finally { database.close(); }
}
