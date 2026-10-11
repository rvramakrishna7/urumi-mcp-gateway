import { parseArgs } from 'node:util';
import pg from 'pg';
import { ConfigError, loadDbConfig } from './config.ts';
import { clientConfig } from './db/pool.ts';
import { createApiKey, createUser, IdentityError, listApiKeys, listUsers, revokeApiKey } from './identity/repository.ts';
import type { Role } from './identity/repository.ts';

// Command-line tool for users and API keys, run inside the gateway pod until the dashboard has a login (Step 10):
//   node dist/cli.js user create --email <email> --role admin|member
//   node dist/cli.js user list
//   node dist/cli.js key create --email <email> --name <name>
//   node dist/cli.js key list --email <email>
//   node dist/cli.js key revoke --id <key id>
// A new key is the only thing written to stdout, and only once. Everything else goes to stderr, so that
// "kubectl exec ... key create > file" captures the key and nothing else.

const USAGE = 'usage: cli user create --email E --role admin|member | user list | key create --email E --name N | key list --email E | key revoke --id ID';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const say = (text: string) => process.stderr.write(`${text}\n`);

// Null for an unknown option or an option without its value (parseArgs throws a TypeError for those).
function parseCommandLine() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: { email: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' }, id: { type: 'string' }, help: { type: 'boolean' } },
    });
  } catch {
    return null;
  }
}

async function run(): Promise<void> {
  const parsed = parseCommandLine();
  if (!parsed || parsed.values.help) {
    say(USAGE);
    process.exitCode = 2;
    return;
  }
  const { positionals, values } = parsed;
  const [group, action] = positionals;
  const client = new pg.Client(clientConfig(loadDbConfig()));
  await client.connect();
  try {
    if (group === 'user' && action === 'create' && values.email && values.role) {
      const user = await createUser(client, values.email, values.role as Role);
      say(`created user ${user.email} (${user.role}) id ${user.id}`);
    } else if (group === 'user' && action === 'list') {
      for (const user of await listUsers(client)) say(`${user.id}  ${user.email}  ${user.role}  ${user.status}`);
    } else if (group === 'key' && action === 'create' && values.email && values.name) {
      const { key, view } = await createApiKey(client, values.email, values.name);
      say(`created key ${view.id} (${view.keyPrefix}...) for ${values.email}; the key is on stdout and is not stored anywhere else`);
      process.stdout.write(`${key}\n`);
    } else if (group === 'key' && action === 'list' && values.email) {
      for (const key of await listApiKeys(client, values.email)) {
        say(`${key.id}  ${key.keyPrefix}...  ${key.name}  ${key.revokedAt ? 'revoked' : 'active'}`);
      }
    } else if (group === 'key' && action === 'revoke' && values.id && UUID.test(values.id)) {
      say((await revokeApiKey(client, values.id)) ? `revoked key ${values.id}` : 'no such key');
    } else {
      say(USAGE);
      process.exitCode = 2;
    }
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  // Messages of our own errors are safe to print. Anything else is reduced to its class name.
  say(`error: ${error instanceof IdentityError || error instanceof ConfigError ? error.message : error instanceof Error ? error.name : 'unknown'}`);
  process.exitCode = 1;
});
