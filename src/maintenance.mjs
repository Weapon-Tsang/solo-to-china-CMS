import { createBackup } from "./backup.mjs";

const TASKS = {
  knowledge: "knowledge_reconciliation",
  entities: "entity_resolution",
  backup: "database_backup",
  cleanup: "job_history_cleanup",
  notifications: "exception_notifications",
  frontendContract: "frontend_contract_sync",
};

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

export class MaintenanceScheduler {
  constructor(repository, pipeline, config, wordpressConfig = {}, { notifier = null, logger = silentLogger, searchConsoleConfig = {} } = {}) {
    this.repository = repository;
    this.pipeline = pipeline;
    this.config = config;
    this.wordpressConfig = wordpressConfig;
    this.wordpressEnabled = Boolean(wordpressConfig.siteUrl && wordpressConfig.username && wordpressConfig.applicationPassword);
    this.searchConsoleConfig = searchConsoleConfig;
    this.searchConsoleEnabled = Boolean(searchConsoleConfig.siteUrl && searchConsoleConfig.clientEmail && searchConsoleConfig.privateKey);
    this.notifier = notifier;
    this.logger = logger;
    this.timer = null;
    this.working = false;
  }

  start() {
    if (!this.config.enabled || this.timer) return;
    const intervalMs = Math.max(1, this.config.intervalMinutes) * 60_000;
    this.timer = setInterval(() => this.runDue().catch((error) => this.logger.error("maintenance.tick_failed", { error })), intervalMs);
    this.timer.unref();
    void this.runDue().catch((error) => this.logger.error("maintenance.initial_run_failed", { error }));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runDue({ force = false } = {}) {
    if (!this.config.enabled) return { enabled: false, running: false, results: [] };
    if (this.working) return { enabled: true, running: true, results: [] };
    this.working = true;
    const results = [];
    try {
      if (this.wordpressEnabled) {
        const jobId = this.repository.enqueueWordPressInventorySync(
          this.wordpressConfig.siteUrl,
          this.wordpressConfig.inventorySyncHours,
          force,
        );
        results.push({ task: "wordpress_inventory", status: jobId ? "queued" : "fresh", itemCount: jobId ? 1 : 0 });
      }
      if (this.searchConsoleEnabled) {
        const jobId = this.repository.enqueueSearchConsoleSync(
          this.searchConsoleConfig.siteUrl,
          this.searchConsoleConfig.syncHours,
          force,
        );
        results.push({ task: "search_console_inventory", status: jobId ? "queued" : "fresh", itemCount: jobId ? 1 : 0 });
      }
      if (this.config.frontendContract?.registrySource && this.config.frontendContract?.pageSchemaSource) {
        await this.runTask(results, TASKS.frontendContract, this.config.frontendContract.syncHours, force, () => ({
          itemCount: this.repository.enqueue("sync_frontend_contract", "default") ? 1 : 0,
        }));
      }
      await this.runTask(results, TASKS.entities, this.config.entityResolutionHours || 24, force, () => ({
        itemCount: this.repository.enqueueEntityResolutionForAllDestinations(),
      }));
      await this.runTask(results, TASKS.knowledge, this.config.knowledgeReconcileHours, force, () => ({
        itemCount: this.repository.enqueueKnowledgeReconciliation(),
      }));
      await this.runTask(results, TASKS.backup, this.config.autoBackupHours, force, () => {
        const backup = createBackup({
          databasePath: this.config.databasePath,
          backupDir: this.config.backupDir,
          retention: this.config.backupRetention,
        });
        return { itemCount: 1, metadata: { backup: backup.backup, bytes: backup.bytes, sha256: backup.sha256, schemaVersion: backup.schemaVersion } };
      });
      await this.runTask(results, TASKS.cleanup, 24, force, () => ({
        itemCount: this.repository.pruneSucceededJobs(this.config.jobHistoryRetentionDays),
        metadata: { retentionDays: this.config.jobHistoryRetentionDays },
      }));
      if (this.notifier?.enabled) {
        await this.runTask(results, TASKS.notifications, Math.max(1, this.config.notificationIntervalMinutes || 15) / 60, force,
          () => this.notifier.deliver());
      }
      void this.pipeline.runOne();
      return { enabled: true, running: false, results };
    } finally {
      this.working = false;
    }
  }

  async runTask(results, taskKey, intervalHours, force, work) {
    if (!force && !this.repository.maintenanceDue(taskKey, intervalHours)) {
      results.push({ task: taskKey, status: "fresh", itemCount: 0 });
      return;
    }
    this.repository.startMaintenance(taskKey);
    const startedAt = Date.now();
    try {
      const result = await work();
      this.repository.completeMaintenance(taskKey, result.itemCount, result.metadata || {});
      results.push({ task: taskKey, status: "succeeded", ...result });
      this.logger.info("maintenance.task_succeeded", { task: taskKey, itemCount: result.itemCount, durationMs: Date.now() - startedAt });
    } catch (error) {
      this.repository.failMaintenance(taskKey, error);
      results.push({ task: taskKey, status: "failed", itemCount: 0, error: String(error?.message || error) });
      this.logger.error("maintenance.task_failed", { task: taskKey, durationMs: Date.now() - startedAt, error });
    }
  }
}
