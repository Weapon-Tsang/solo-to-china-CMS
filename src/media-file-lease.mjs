import fs from "node:fs";
import path from "node:path";

export function withMediaFileLease(databasePath, action, { skipIfBusy = false } = {}) {
  const lease = path.join(path.dirname(path.resolve(databasePath)), ".cms-media-mutation.lock");
  let descriptor;
  try {
    descriptor = fs.openSync(lease, "wx");
    fs.writeSync(descriptor, `${process.pid}\n`);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
      fs.rmSync(lease, { force: true });
    }
    if (error.code === "EEXIST") {
      if (skipIfBusy) return { skipped: true, reason: "media_snapshot_in_progress" };
      throw Object.assign(new Error(`Media file mutation is already in progress: ${lease}`), { code: "MEDIA_FILE_BUSY" });
    }
    throw error;
  }
  try { return action(); }
  finally {
    fs.closeSync(descriptor);
    fs.rmSync(lease, { force: true });
  }
}
