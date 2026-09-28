import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Repository } from '../src/repository.mjs';

const filename = path.resolve(process.argv[2] || '');
if (!/(?:work|replay|canary)\.sqlite$/i.test(path.basename(filename))) {
  throw new Error('Pass an explicit disposable production-copy work database.');
}
const db = new DatabaseSync(filename, { readOnly: true });
db.exec('PRAGMA query_only=ON');
const original = db.prepare.bind(db);
const timings = new Map();
db.prepare = (sql) => {
  const statement = original(sql);
  const signature = String(sql).replace(/\s+/g, ' ').trim().slice(0, 180);
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key);
    if (!['get', 'all', 'iterate'].includes(key)) return value;
    return (...args) => {
      const start = performance.now();
      const result = value.apply(target, args);
      const elapsed = performance.now() - start;
      const prior = timings.get(signature) || { calls: 0, milliseconds: 0 };
      prior.calls += 1;
      prior.milliseconds += elapsed;
      timings.set(signature, prior);
      return result;
    };
  } });
};
try {
  const repository = new Repository(db);
  const start = performance.now();
  const page = repository.listSystemHealthWorkspace({ limit: 50 });
  console.log(JSON.stringify({ totalMs: Math.round(performance.now() - start), resultCount: page.totalCount,
    queries: [...timings].map(([sql, value]) => ({ sql, calls: value.calls,
      milliseconds: Math.round(value.milliseconds) })).sort((a, b) => b.milliseconds - a.milliseconds).slice(0, 12) }, null, 2));
} finally { db.close(); }
