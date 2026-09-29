import fs from "node:fs";

// The production disk reached 100% on 2026-09-30 because release rehearsal copies
// were never removed; nothing reported it. The data volume is now checked with
// every operational-exception projection and surfaces through the existing
// dashboard exception list and webhook notifier.
export const DISK_WARNING_RATIO = 0.8;
export const DISK_BLOCKER_RATIO = 0.9;

export function diskUsage(directory, statfs = fs.statfsSync) {
  if (!directory) return null;
  try {
    const stats = statfs(directory, { bigint: true });
    const total = Number(stats.blocks * stats.bsize);
    const free = Number(stats.bavail * stats.bsize);
    if (!(total > 0)) return null;
    return { path: directory, totalBytes: total, freeBytes: free, usedRatio: Number(((total - free) / total).toFixed(4)) };
  } catch {
    return null;
  }
}

export function diskHealthSeverity(usage, { warningRatio = DISK_WARNING_RATIO, blockerRatio = DISK_BLOCKER_RATIO } = {}) {
  if (!usage) return null;
  if (usage.usedRatio >= blockerRatio) return "blocker";
  if (usage.usedRatio >= warningRatio) return "warning";
  return null;
}

export function describeDiskUsage(usage) {
  const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)}G`;
  return `数据盘已使用 ${(usage.usedRatio * 100).toFixed(0)}%，剩余 ${gib(usage.freeBytes)}（共 ${gib(usage.totalBytes)}）。`
    + "磁盘写满会让数据库写入、备份和上传失败。请清理发布演练副本、过期重放库和旧快照。";
}
