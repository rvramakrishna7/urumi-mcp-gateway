import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Keyring } from '../src/crypto/credentials.ts';
import { CONFIRM_TTL_MS, canonicalJson, ConfirmError, issueConfirmToken, requiresConfirmation, verifyConfirmToken } from '../src/chat/confirm.ts';

const keyring = (key: Buffer = randomBytes(32)): Keyring => ({ currentId: 'k1', keys: new Map([['k1', key]]) });
const KEYS = keyring(Buffer.alloc(32, 7));
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NAME = 'woo__create_product';
const ARGS = { name: 'Chat Mug', regular_price: '12.00', categories: [{ id: 3 }], meta: { a: 1, b: [true, null] } };
const NOW = 1_800_000_000_000;
const subject = { userId: USER, name: NAME, args: ARGS };

describe('the confirmation token (no database needed)', () => {
  test('a token verifies for the same user, tool and arguments', () => {
    assert.equal(verifyConfirmToken(KEYS, issueConfirmToken(KEYS, subject, NOW), subject, NOW), true);
  });

  test('the order of the keys in the arguments does not matter, the values do', () => {
    const token = issueConfirmToken(KEYS, subject, NOW);
    const reordered = { meta: { b: [true, null], a: 1 }, categories: [{ id: 3 }], regular_price: '12.00', name: 'Chat Mug' };
    assert.equal(verifyConfirmToken(KEYS, token, { ...subject, args: reordered }, NOW), true);
    assert.equal(verifyConfirmToken(KEYS, token, { ...subject, args: { ...ARGS, regular_price: '1.00' } }, NOW), false);
    assert.equal(verifyConfirmToken(KEYS, token, { ...subject, args: { ...ARGS, meta: { a: 1, b: [true, false] } } }, NOW), false);
    assert.equal(verifyConfirmToken(KEYS, token, { ...subject, args: { ...ARGS, extra: 1 } }, NOW), false);
    assert.equal(verifyConfirmToken(KEYS, token, { ...subject, args: { name: 'Chat Mug' } }, NOW), false);
  });

  test('a different tool name is refused, also one that is a prefix or another case', () => {
    const token = issueConfirmToken(KEYS, subject, NOW);
    for (const name of ['woo__update_order_status', 'woo__create_product2', 'WOO__CREATE_PRODUCT', 'woo__create_produc', '']) {
      assert.equal(verifyConfirmToken(KEYS, token, { ...subject, name }, NOW), false, name);
    }
  });

  test('a token of another user is refused', () => {
    assert.equal(verifyConfirmToken(KEYS, issueConfirmToken(KEYS, subject, NOW), { ...subject, userId: OTHER }, NOW), false);
  });

  test('a token expires after five minutes, to the millisecond', () => {
    const token = issueConfirmToken(KEYS, subject, NOW);
    assert.equal(CONFIRM_TTL_MS, 5 * 60 * 1000);
    assert.equal(verifyConfirmToken(KEYS, token, subject, NOW + CONFIRM_TTL_MS), true);
    assert.equal(verifyConfirmToken(KEYS, token, subject, NOW + CONFIRM_TTL_MS + 1), false);
  });

  test('moving the expiry forward in the token does not extend it', () => {
    const [expiry, mac] = issueConfirmToken(KEYS, subject, NOW).split('.') as [string, string];
    assert.equal(verifyConfirmToken(KEYS, `${Number(expiry) + 3_600_000}.${mac}`, subject, NOW + CONFIRM_TTL_MS + 1), false);
  });

  test('a token made with another master key is refused', () => {
    assert.equal(verifyConfirmToken(keyring(), issueConfirmToken(KEYS, subject, NOW), subject, NOW), false);
  });

  test('one changed character of the mac is refused', () => {
    const token = issueConfirmToken(KEYS, subject, NOW);
    const last = token.slice(-1) === '0' ? '1' : '0';
    assert.equal(verifyConfirmToken(KEYS, token.slice(0, -1) + last, subject, NOW), false);
  });

  test('anything that is not a token gives false and never throws', () => {
    const valid = issueConfirmToken(KEYS, subject, NOW);
    const garbage: unknown[] = [
      undefined, null, 0, 12, {}, [], [valid], true, '', '.', 'x', 'abc.def',
      `${NOW}.`, `.${'a'.repeat(64)}`, `${NOW}.${'g'.repeat(64)}`, `${NOW}.${'a'.repeat(63)}`, `${NOW}.${'a'.repeat(65)}`,
      `-1.${'a'.repeat(64)}`, `${'9'.repeat(30)}.${'a'.repeat(64)}`, 'a'.repeat(100_000), `${valid}\n`, ` ${valid}`, valid.toUpperCase(),
    ];
    for (const token of garbage) assert.equal(verifyConfirmToken(KEYS, token, subject, NOW), false, String(token).slice(0, 30));
  });

  test('arguments that JSON cannot carry cannot be signed, and verify gives false for them', () => {
    const valid = issueConfirmToken(KEYS, subject, NOW);
    for (const args of [undefined, { a: undefined }, { a: Number.NaN }, { a: Infinity }, { a: 1n }, { a: () => 1 }, { a: Symbol('x') }]) {
      assert.throws(() => issueConfirmToken(KEYS, { ...subject, args }, NOW), ConfirmError);
      assert.equal(verifyConfirmToken(KEYS, valid, { ...subject, args }, NOW), false);
    }
    let deep: unknown = 1;
    for (let i = 0; i < 40; i += 1) deep = { a: deep };
    assert.throws(() => issueConfirmToken(KEYS, { ...subject, args: deep }, NOW), ConfirmError);
  });

  test('the parts of the message cannot be shifted into each other', () => {
    const token = issueConfirmToken(KEYS, { userId: 'ab', name: 'c', args: {} }, NOW);
    assert.equal(verifyConfirmToken(KEYS, token, { userId: 'a', name: 'bc', args: {} }, NOW), false);
  });

  test('the token holds the expiry and the mac only: no user id, name or argument text', () => {
    const marker = 'MARKER-' + randomBytes(6).toString('hex');
    const token = issueConfirmToken(KEYS, { userId: USER, name: NAME, args: { name: marker } }, NOW);
    assert.match(token, /^[0-9]{1,16}\.[0-9a-f]{64}$/);
    for (const needle of [marker, USER, NAME, 'Mug']) assert.equal(token.includes(needle), false, needle);
    // The planted control: the same scan finds a marker when it is there.
    assert.equal(`${token}${marker}`.includes(marker), true);
  });

  test('canonicalJson sorts keys at every level and keeps array order', () => {
    assert.equal(canonicalJson({ b: [2, 1], a: { d: 1, c: 'x' } }), '{"a":{"c":"x","d":1},"b":[2,1]}');
    assert.equal(canonicalJson(JSON.parse('{"__proto__":{"x":1},"a":1}')), '{"__proto__":{"x":1},"a":1}');
  });

  test('requiresConfirmation is an exact match on the list', () => {
    const list = ['woo__create_product', 'woo__update_order_status'];
    assert.equal(requiresConfirmation('woo__create_product', list), true);
    assert.equal(requiresConfirmation('woo__update_order_status', list), true);
    for (const name of ['woo__list_products', 'woo__create_product2', 'Woo__create_product', ' woo__create_product', 'create_product', '']) {
      assert.equal(requiresConfirmation(name, list), false, name);
    }
    assert.equal(requiresConfirmation('woo__create_product', []), false);
  });
});
