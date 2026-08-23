import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db.mjs";
import { Repository } from "../src/repository.mjs";

export function repositoryFixture(t, contentConfig = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-to-china-test-"));
  const db = openDatabase(path.join(directory, "test.sqlite"));
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { db, repository: new Repository(db, contentConfig) };
}
