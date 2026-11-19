import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validate } from '../src/intake.ts';

const good = { event_id: 'e1', user_id: 'u1', created_at: '2026-11-17T10:42:07.318Z' };
const body = (o: unknown): Buffer => Buffer.from(JSON.stringify(o));

test('the brief example payload is valid', () => {
  const r = validate(
    body({
      event_id: '6f1c2a9e-1d7b-4c1e-9a43-2b8f0d6e7c11',
      user_id: 'usr_004211',
      created_at: '2026-11-17T10:42:07.318Z',
      type: 'user.updated',
      data: { email: 'a@example.com' },
    }),
  );
  assert.deepEqual(r, {
    ok: true,
    event_id: '6f1c2a9e-1d7b-4c1e-9a43-2b8f0d6e7c11',
    user_id: 'usr_004211',
    created_at: '2026-11-17T10:42:07.318Z',
  });
});

const bad400: [string, Buffer, string][] = [
  ['broken JSON gives 400', Buffer.from('{"event_id":'), 'JSON'],
  ['a JSON array gives 400', Buffer.from('[1,2]'), 'object'],
  ['JSON null gives 400', Buffer.from('null'), 'object'],
  ['a JSON string gives 400', Buffer.from('"x"'), 'object'],
  ['garbage created_at gives 400', body({ ...good, created_at: 'yesterday' }), 'created_at'],
  ['created_at with a trailing space gives 400', body({ ...good, created_at: '2026-11-17T10:42:07Z ' }), 'created_at'],
  ['created_at with a bare dot gives 400', body({ ...good, created_at: '2026-11-17T10:42:07.Z' }), 'created_at'],
  ['created_at with a date only gives 400', body({ ...good, created_at: '2026-11-17' }), 'created_at'],
];
for (const field of ['event_id', 'user_id', 'created_at']) {
  bad400.push([`missing ${field} gives 400`, body({ ...good, [field]: undefined }), field]);
  bad400.push([`empty ${field} gives 400`, body({ ...good, [field]: '' }), field]);
  bad400.push([`numeric ${field} gives 400`, body({ ...good, [field]: 5 }), field]);
}
for (const [name, buf, word] of bad400) {
  test(name, () => {
    const r = validate(buf);
    assert.equal(r.ok, false);
    assert.ok(!r.ok);
    assert.equal(r.status, 400);
    assert.ok(r.reason.includes(word), r.reason);
  });
}

for (const created_at of [
  '2026-11-17T10:42:07Z',
  '2026-11-17T10:42:07+05:30',
  '2026-11-17T10:42:07-08:00',
  '2026-11-17T10:42:07',
  '2026-11-17t10:42:07z',
  '2026-11-17T10:42:07.5',
  '2026-13-45T10:42:07Z', // range checks belong to Postgres
]) {
  test(`created_at ${created_at} is valid and unchanged`, () => {
    assert.deepEqual(validate(body({ ...good, created_at })), { ok: true, event_id: 'e1', user_id: 'u1', created_at });
  });
}

test('a 7-decimal created_at is cut, not rounded, with one warn line', (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const r = validate(body({ ...good, created_at: '2026-11-17T10:42:07.1234569+05:30' }));
  assert.deepEqual(r, { ok: true, event_id: 'e1', user_id: 'u1', created_at: '2026-11-17T10:42:07.123456+05:30' });
  assert.equal(log.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(String(log.mock.calls[0]?.arguments[0])), {
    level: 'warn',
    msg: 'created_at cut to 6 decimals',
    event_id: 'e1',
    user_id: 'u1',
  });
});

test('a 6-decimal created_at is unchanged and logs nothing', (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const r = validate(body({ ...good, created_at: '2026-11-17T10:42:07.123456Z' }));
  assert.ok(r.ok);
  assert.equal(r.created_at, '2026-11-17T10:42:07.123456Z');
  assert.equal(log.mock.callCount(), 0);
});

test('a body of exactly 1 MB is not refused as too large', () => {
  const pad = 'x'.repeat(1_048_576 - body({ ...good, p: '' }).length);
  const buf = body({ ...good, p: pad });
  assert.equal(buf.length, 1_048_576);
  assert.ok(validate(buf).ok);
});

test('a body one byte over 1 MB gives 413 even when it is not JSON', () => {
  assert.deepEqual(validate(Buffer.alloc(1_048_577, 'x')), { ok: false, status: 413, reason: 'body over 1 MB' });
});

// Review fixes, U2.
test('a NUL character in event_id or user_id gives 400, since Postgres text cannot hold it', () => {
  for (const field of ['event_id', 'user_id'] as const) {
    const r = validate(body({ ...good, [field]: 'a\u0000b' }));
    assert.equal(r.ok, false, field);
    assert.ok(!r.ok && r.status === 400 && r.reason.includes(field), JSON.stringify(r));
  }
});

test('event_id and user_id of 1,000 bytes are valid, and of 1,001 bytes give 400', () => {
  for (const field of ['event_id', 'user_id'] as const) {
    assert.equal(validate(body({ ...good, [field]: 'x'.repeat(1000) })).ok, true, `${field} 1000`);
    const r = validate(body({ ...good, [field]: 'x'.repeat(1001) }));
    assert.ok(!r.ok && r.status === 400 && r.reason.includes(field), JSON.stringify(r));
  }
});

test('the 1,000-byte limit counts UTF-8 bytes, not characters', () => {
  const r = validate(body({ ...good, event_id: 'é'.repeat(501) })); // 501 characters, 1,002 bytes
  assert.ok(!r.ok && r.status === 400, JSON.stringify(r));
});

test('a body that is not valid UTF-8 gives 400, never a silently replaced character', () => {
  const bytes = Buffer.concat([Buffer.from('{"event_id":"e'), Buffer.from([0xff]), Buffer.from('","user_id":"u1","created_at":"2026-11-17T10:42:07Z"}')]);
  const r = validate(bytes);
  assert.ok(!r.ok && r.status === 400, JSON.stringify(r));
});

test('a 7-decimal created_at is cut to 6 whether it ends in Z or has no zone', (t) => {
  t.mock.method(console, 'error', () => undefined);
  assert.deepEqual(validate(body({ ...good, created_at: '2026-11-17T10:42:07.1234569Z' })), { ...good, ok: true, created_at: '2026-11-17T10:42:07.123456Z' });
  assert.deepEqual(validate(body({ ...good, created_at: '2026-11-17T10:42:07.1234569' })), { ...good, ok: true, created_at: '2026-11-17T10:42:07.123456' });
});

test('an empty body gives 400', () => {
  const r = validate(Buffer.alloc(0));
  assert.ok(!r.ok && r.status === 400, JSON.stringify(r));
});
