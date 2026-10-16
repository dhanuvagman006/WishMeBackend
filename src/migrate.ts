/**
 * Applies migrations/*.sql in filename order. Each file runs in its own transaction; an advisory lock makes concurrent
 * runs (two replicas starting at once) wait instead of racing. Files starting with `-- mode: standalone` are skipped in
 * shared mode. Applied files are recorded with a checksum; editing an applied file is refused.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './config/env.js';
import { createDb } from './lib/db.js';
import { sha256Hex } from './lib/crypto.js';
import { rootLogger } from './lib/logger.js';

const LOCK_KEY = 728_311_001;

export async function migrate(opts: { dir?: string } = {}): Promise<string[]> {
  const env = loadEnv();
  const log = rootLogger().child({ component: 'migrate' });
  const db = createDb(env, log, { max: 1, direct: true });
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = opts.dir ?? resolve(here, '..', 'migrations');
  const applied: string[] = [];
  try {
    await db`select pg_advisory_lock(${LOCK_KEY})`;
    await db`create schema if not exists wishme`;
    await db`
      create table if not exists wishme.schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`;
    const done = new Map((await db<{ name: string; checksum: string }[]>`select name, checksum from wishme.schema_migrations`).map((r) => [r.name, r.checksum]));
    const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      const text = await readFile(join(dir, file), 'utf8');
      const checksum = sha256Hex(text);
      const prior = done.get(file);
      if (prior) {
        if (prior !== checksum) throw new Error(`Migration ${file} was edited after it was applied. Add a new migration instead.`);
        continue;
      }
      if (/^--\s*mode:\s*standalone/m.test(text.split('\n')[0] ?? '') && env.DB_MODE !== 'standalone') {
        log.info({ file }, 'skipping standalone-only migration in shared mode');
        continue;
      }
      log.info({ file }, 'applying migration');
      await db.begin(async (tx) => {
        await tx.unsafe(text);
        await tx`insert into wishme.schema_migrations (name, checksum) values (${file}, ${checksum})`;
      });
      applied.push(file);
    }
    log.info({ applied: applied.length }, 'migrations complete');
    return applied;
  } finally {
    await db`select pg_advisory_unlock(${LOCK_KEY})`.catch(() => {});
    await db.end({ timeout: 5 });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  migrate().then(
    () => process.exit(0),
    (e: unknown) => {
      rootLogger().fatal({ err: e }, 'migration failed');
      process.exit(1);
    },
  );
}
