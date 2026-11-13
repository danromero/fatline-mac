import { MIGRATIONS } from "./migrations.ts";

/** Brings the database up to the latest migration in migrations.ts. */
let ready: Promise<void> | undefined;

/** Applies migrations once per isolate. */
export function ensureSchema(db: D1Database): Promise<void> {
  ready ??= migrate(db).catch((error) => {
    ready = undefined;
    throw error;
  });
  return ready;
}

async function currentVersion(db: D1Database) {
  await db.prepare("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)").run();
  const row = await db.prepare("SELECT version FROM schema_version").first<{ version: number }>();
  return row?.version ?? 0;
}

async function migrate(db: D1Database) {
  const version = await currentVersion(db);
  if (version >= MIGRATIONS.length) return;
  const statements = MIGRATIONS.slice(version).flat().map((sql) => db.prepare(sql));
  statements.push(db.prepare("DELETE FROM schema_version"), db.prepare("INSERT INTO schema_version (version) VALUES (?)").bind(MIGRATIONS.length));
  try {
    await db.batch(statements);
  } catch (error) {
    // Another isolate may have migrated at the same moment.
    if ((await currentVersion(db)) < MIGRATIONS.length) throw error;
  }
}
