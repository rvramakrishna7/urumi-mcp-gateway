import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { createApp } from '../src/app.ts';
import { hashPassword } from '../src/auth/password.ts';
import { sessionAuthConfig } from '../src/auth/session.ts';
import { MAX_FAILURES } from '../src/auth/throttle.ts';
import { loadMigrationFiles, runMigrations } from '../src/db/migrate.ts';
import { createUser } from '../src/identity/repository.ts';
import { createLogger } from '../src/logger.ts';
import { createAuthRouter } from '../src/routes/auth.ts';
import { createTestDatabase, skipWithoutDb } from './helpers/db.ts';
import type { TestDatabase } from './helpers/db.ts';

const ORIGIN = 'http://gateway.urumi.test';
const PASSWORD = 'correct horse battery staple';
const PARALLEL = 30;
const ROUNDS = 4;

// The login throttle is a check followed by an act (docs/architecture.md, decision 35). A burst of parallel requests all
// pass the first check before the first failure is written, so the throttle must be checked again after the slow hash.
describe('a burst of parallel logins for one email (needs PostgreSQL)', { skip: skipWithoutDb }, () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let server: Server;
  let base: string;
  let passwordHash: string;

  const login = async (email: string, password: string): Promise<number> => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email, password }),
    });
    await response.text();
    return response.status;
  };

  before(async () => {
    db = await createTestDatabase();
    await runMigrations(await db.connect(), await loadMigrationFiles(), createLogger(() => {}));
    pool = db.pool();
    passwordHash = await hashPassword(PASSWORD);
    const sessions = sessionAuthConfig(ORIGIN);
    const { app } = createApp({
      logger: createLogger(() => {}),
      checkDatabase: async () => {},
      auth: createAuthRouter({ db: pool, logger: createLogger(() => {}), sessions }),
    });
    server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await db.drop();
  });

  for (let round = 1; round <= ROUNDS; round++) {
    test(`round ${round}: the correct password, sent last in a burst of ${PARALLEL}, never wins and makes no session`, async (t) => {
      const email = `burst-${round}@example.com`;
      await createUser(pool, email, 'member');
      await pool.query('UPDATE users SET password_hash = $2 WHERE email = $1', [email, passwordHash]);

      const attempts = [...Array.from({ length: PARALLEL - 1 }, (_, i) => `wrong password number ${i}`), PASSWORD];
      const statuses = await Promise.all(attempts.map((password) => login(email, password)));
      const correct = statuses[PARALLEL - 1]!;
      const wrong = statuses.slice(0, PARALLEL - 1);
      const summary = JSON.stringify({ 401: wrong.filter((s) => s === 401).length, 429: wrong.filter((s) => s === 429).length, correct });

      // 1. The correct password does not pass once MAX_FAILURES wrong ones were recorded, and nothing makes a session.
      assert.notEqual(correct, 200, `the correct password won the burst: ${summary}`);
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = $1)', [email])).rows[0].c, 0);
      // 2. No oracle: the late request with the correct password gets the same answer as the late requests with wrong ones.
      assert.equal(correct, 429, `the correct password was answered differently from a lock: ${summary}`);
      assert.equal(wrong[PARALLEL - 2], 429, `the last wrong password was not answered with the lock: ${summary}`);
      // 3. The burst does not get a verdict for every guess. This is NOT an exact bound: the lock exists only when the fifth
      //    failure is committed, and the attempts that finished their hash before that still get a 401. 10 to 16 of 29 were
      //    measured here (12 rounds), not 5. An exact bound of MAX_FAILURES verdicts needs the attempt to be reserved before
      //    the hash (docs/architecture.md, known limitations). The number is printed, not asserted.
      const answeredAsWrong = wrong.filter((s) => s === 401).length;
      t.diagnostic(`round ${round}: ${answeredAsWrong} of ${PARALLEL - 1} wrong passwords were answered 401, the rest 429`);
      assert.ok(answeredAsWrong >= MAX_FAILURES && answeredAsWrong < PARALLEL - 1, `${answeredAsWrong} attempts were answered as wrong: ${summary}`);
      // 4. The email is locked, so a later correct login is refused too.
      assert.equal(await login(email, PASSWORD), 429);
    });
  }
});
