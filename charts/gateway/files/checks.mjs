// Checks for the gateway, run by "helm test" inside the cluster. They print names, counts and PASS or FAIL.
// The database password and the content of any row are never printed.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// This script is mounted at /scripts, so Node does not look in /app/node_modules for packages. The image's pg is
// loaded from there explicitly.
const pg = createRequire('/app/package.json')('pg');

const base = process.env.GATEWAY_URL;
let failed = false;

function check(name, ok, detail = '') {
  console.log(`[checks] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed = true;
}

const EXPECTED_TABLES = ['api_keys', 'applied_seeds', 'audit_log', 'login_throttle', 'schema_migrations', 'sessions', 'upstream_servers', 'upstream_tools', 'users'];

async function http(path) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10_000) });
  return response.status;
}

const client = new pg.Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: readFileSync(process.env.DB_PASSWORD_FILE, 'utf8').trim(),
  connectionTimeoutMillis: 5000,
  statement_timeout: 10_000,
});

try {
  await client.connect();
  check('connect to PostgreSQL with the application user', true);

  const version = (await client.query('SHOW server_version')).rows[0].server_version;
  check('PostgreSQL version', /^17\./.test(version), version);

  const migrations = (await client.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((row) => row.version);
  check('migrations recorded', migrations.includes('0001_init') && migrations.includes('0002_applied_seeds'), migrations.join(', '));

  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows.map((row) => row.tablename);
  check('tables', JSON.stringify(tables) === JSON.stringify(EXPECTED_TABLES), tables.join(', '));

  // Counts only, never a row.
  for (const table of EXPECTED_TABLES.filter((name) => name !== 'schema_migrations')) {
    const count = (await client.query(`SELECT count(*)::int AS c FROM ${table}`)).rows[0].c;
    check(`table ${table} is readable`, Number.isInteger(count), `${count} rows`);
  }

  // The seed: woo-mcp is registered, it carries an encrypted credential, and the seed is recorded as applied.
  // Only the shape is printed. The credential columns are read for their length, never for their content.
  const woo = (await client.query("SELECT enabled, seed_managed, credential_kind, credential_key_id, octet_length(credential_ciphertext) AS ct, octet_length(credential_nonce) AS nonce FROM upstream_servers WHERE slug = 'woo'")).rows[0];
  check('the seeded server woo is registered', Boolean(woo));
  check('woo has an encrypted bearer credential', woo?.credential_kind === 'bearer' && woo.ct > 16 && woo.nonce === 12 && woo.credential_key_id === 'k1', woo ? `${woo.credential_kind}, ${woo.ct} bytes, nonce ${woo.nonce}, key ${woo.credential_key_id}` : '');
  check('the seed is recorded as applied', (await client.query("SELECT 1 FROM applied_seeds WHERE slug = 'woo'")).rowCount === 1);

  const isSuperuser = (await client.query("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")).rows[0].rolsuper;
  // The official image makes POSTGRES_USER a superuser. It is the application user of a database that nothing else uses.
  console.log(`[checks] INFO the application user is a superuser: ${isSuperuser}`);
} catch (error) {
  check('database checks ran without an exception', false, error instanceof Error ? error.name : 'unknown');
} finally {
  await client.end().catch(() => {});
}

try {
  check('GET /healthz', (await http('/healthz')) === 200);
  check('GET /readyz (the database answers)', (await http('/readyz')) === 200);
  check('an unknown path answers 404', (await http('/nothing')) === 404);
  check('the admin API answers 401 without a key', (await http('/api/admin/servers')) === 401);
} catch (error) {
  check('the HTTP checks ran without an exception', false, error instanceof Error ? error.name : 'unknown');
}

process.exit(failed ? 1 : 0);
