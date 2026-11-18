import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScenario } from './types.ts';
import { rng } from './rng.ts';

const base = {
  seed: 1,
  duration_s: 10,
  drain_s: 5,
  load: { rate: 10, users: 3, heavy_users: 1, heavy_share: 0.5 },
  steps: [] as unknown[],
};
const withSteps = (steps: unknown[]): unknown => ({ ...base, steps });

test('a valid scenario parses, keeping step fields', () => {
  const s = parseScenario(
    withSteps([
      { from_s: 1, to_s: 2, mode: 'limit', p: 0.5, retry_after: 'abc', users: ['u0001'] },
      { from_s: 2, to_s: 3, mode: 'down' },
    ])
  );
  assert.equal(s.steps.length, 2);
  assert.deepEqual(s.steps[0], { from_s: 1, to_s: 2, mode: 'limit', p: 0.5, retry_after: 'abc', users: ['u0001'] });
});

test('bad step values are refused, never dropped', () => {
  const bad: Array<[string, unknown]> = [
    ['unknown mode', { from_s: 0, to_s: 1, mode: 'sleepy' }],
    ['to_s not after from_s', { from_s: 2, to_s: 2, mode: 'fail' }],
    ['negative from_s', { from_s: -1, to_s: 1, mode: 'fail' }],
    ['p above 1', { from_s: 0, to_s: 1, mode: 'fail', p: 1.5 }],
    ['negative latency', { from_s: 0, to_s: 1, mode: 'slow', latency_ms: -5 }],
    ['retry_after of the wrong type', { from_s: 0, to_s: 1, mode: 'limit', retry_after: true }],
    ['retry_after with a control character', { from_s: 0, to_s: 1, mode: 'limit', retry_after: 'a\nb' }],
    ['users not all strings', { from_s: 0, to_s: 1, mode: 'fail', users: ['u0001', 2] }],
  ];
  for (const [why, step] of bad) {
    assert.throws(() => parseScenario(withSteps([step])), TypeError, why);
  }
});

test('steps that overlap in time and users are refused', () => {
  assert.throws(
    () => parseScenario(withSteps([{ from_s: 0, to_s: 5, mode: 'fail' }, { from_s: 4, to_s: 6, mode: 'down' }])),
    TypeError
  );
  assert.throws(
    () =>
      parseScenario(
        withSteps([
          { from_s: 0, to_s: 5, mode: 'slow', users: ['u0001', 'u0002'] },
          { from_s: 1, to_s: 2, mode: 'fail', users: ['u0002'] },
        ])
      ),
    TypeError
  );
  // Same time, different users, and back-to-back steps are fine.
  parseScenario(
    withSteps([
      { from_s: 0, to_s: 5, mode: 'slow', users: ['u0001'] },
      { from_s: 0, to_s: 5, mode: 'fail', users: ['u0002'] },
      { from_s: 5, to_s: 6, mode: 'down' },
    ])
  );
});

test('a scenario that is not an object, or lacks a field, is refused', () => {
  assert.throws(() => parseScenario(null), TypeError);
  assert.throws(() => parseScenario({ ...base, seed: 'x' }), TypeError);
  assert.throws(() => parseScenario({ ...base, load: undefined }), TypeError);
});

test('rng repeats for the same seed and differs for another', () => {
  const a = rng(7);
  const b = rng(7);
  const c = rng(8);
  const seqA = [a(), a(), a()];
  assert.deepEqual(seqA, [b(), b(), b()]);
  assert.notDeepEqual(seqA, [c(), c(), c()]);
  for (const x of seqA) assert.ok(x >= 0 && x < 1);
});
