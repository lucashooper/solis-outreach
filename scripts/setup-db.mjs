/**
 * Apply supabase/migrations to a fresh database, in filename order.
 *
 *   DATABASE_URL='postgresql://127.0.0.1:5432/postgres' npm run setup:db
 *
 * Supabase projects already have anon, authenticated, service_role, and storage.
 * For an empty local Postgres, pass --with-local-roles.
 *
 * Alternative: `supabase db push`, or concatenate the SQL files in the same order.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'supabase', 'migrations');
const withLocalRoles = process.argv.includes('--with-local-roles');

const databaseUrl = (process.env.DATABASE_URL || '').trim();
if (!databaseUrl) {
  console.error('Set DATABASE_URL to the Postgres connection string, then run npm run setup:db.');
  console.error('Supabase CLI alternative: supabase db push');
  process.exit(1);
}

const files = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

if (!files.length) {
  console.error('No files in supabase/migrations.');
  process.exit(1);
}

const localRoles = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text,
  public boolean
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text,
  name text
);
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT ALL ON storage.buckets, storage.objects TO anon, authenticated, service_role;
`;

function runPsql(sql) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      'psql',
      [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-q'],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    );
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`psql exited ${code}`));
    });
    child.stdin.end(sql);
  });
}

const parts = [];
if (withLocalRoles) parts.push(localRoles);
for (const name of files) {
  parts.push(`\\echo applying ${name}`);
  parts.push(readFileSync(join(migrationsDir, name), 'utf8'));
}

try {
  await runPsql(parts.join('\n\n'));
  console.log(`Applied ${files.length} migrations.`);
} catch (err) {
  const missing = err && err.code === 'ENOENT';
  if (missing) {
    console.error('psql is not installed. Install the Postgres client, or run supabase db push.');
  } else {
    console.error(err instanceof Error ? err.message : 'Migration failed.');
  }
  process.exit(1);
}
