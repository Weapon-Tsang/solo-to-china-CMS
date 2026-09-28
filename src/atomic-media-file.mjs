import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Publish complete bytes with a same-directory hard link. A snapshot may omit
// the .tmp file, but it can never observe a partially written final filename.
export function publishMediaBytes(filename, bytes, { mode = 0o640 } = {}) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, bytes, { flag: "wx", mode });
  try {
    try {
      fs.linkSync(temporary, filename);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = fs.readFileSync(filename);
      if (!existing.equals(bytes)) {
        throw Object.assign(new Error(`Existing media bytes differ: ${filename}`), { code: "MEDIA_FILE_CONFLICT" });
      }
      return false;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
