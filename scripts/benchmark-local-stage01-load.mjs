import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const databasePath = process.argv[2];
if (!databasePath || !process.send) throw new Error("Benchmark load helper requires a database path and IPC parent.");
const db = new DatabaseSync(databasePath, { readOnly: true });
db.exec("PRAGMA query_only=ON");
const statement = db.prepare("SELECT COUNT(*) AS count FROM claims WHERE source_id=?");
let running = true;
let queries = 0;
let cycles = 0;
process.on("message", (message) => {
  if (message === "stop") {
    running = false;
    db.close();
    process.send({ type: "stopped", queries, cycles }, () => process.exit(0));
  }
});
process.send({ type: "ready" });
const tick = () => {
  if (!running) return;
  for (let i = 0; i < 50; i++) {
    statement.get(`source-${(cycles * 50 + i) % 1_000}`);
    queries++;
  }
  crypto.pbkdf2Sync(`fixture-${cycles}`, "benchmark-only", 500, 32, "sha256");
  cycles++;
  if (cycles % 100 === 0) process.send({ type: "progress", queries, cycles });
  setImmediate(tick);
};
setImmediate(tick);
