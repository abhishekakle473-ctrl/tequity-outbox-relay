// Stand-in for Tequity's load generator: posts a scenario's events to the intake API and logs every answer.
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { join } from 'node:path';
import { rng } from './rng.ts';
import { parseScenario } from './types.ts';
import type { LoadgenLine, Scenario } from './types.ts';

export interface Post {
  at_ms: number;
  body: Buffer;
  event_id: string | null;
  user_id: string | null;
  created_at: string | null;
  valid: boolean;
}

const BASE_MS = Date.parse('2026-11-19T00:00:00.000Z');
const LIMIT_MS = 10_000;

function eventBody(event_id: string, user_id: string, created_at: string, email: string): Buffer {
  return Buffer.from(JSON.stringify({ event_id, user_id, created_at, type: 'user.updated', data: { email } }));
}

// Every post in send order. Posts go out on an even grid of rate a second, so no 1-second window holds more than rate.
export function plan(scenario: Scenario): Post[] {
  const { rate, users, heavy_users, heavy_share, extras = {} } = scenario.load;
  const r = rng(scenario.seed);
  const pick = (n: number): number => Math.floor(r() * n);
  const hex = (): string => Math.floor(r() * 2 ** 32).toString(16).padStart(8, '0');
  const uuid = (): string => {
    const h = hex() + hex() + hex() + hex();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  const user = (): string => {
    const light = users - heavy_users;
    const i = light <= 0 || (heavy_users > 0 && r() < heavy_share) ? pick(heavy_users) : heavy_users + pick(light);
    return `u${String(i + 1).padStart(4, '0')}`;
  };
  const lastCreated = new Map<string, number>();
  const newEvent = (at_ms: number, user_id: string, n: number): Post => {
    const ms = Math.max(BASE_MS + at_ms, (lastCreated.get(user_id) ?? -Infinity) + 1);
    lastCreated.set(user_id, ms);
    const event_id = uuid();
    const created_at = new Date(ms).toISOString();
    const body = eventBody(event_id, user_id, created_at, `${user_id}.${n}@example.com`);
    return { at_ms, body, event_id, user_id, created_at, valid: true };
  };

  const repeat = extras.repeat ?? 0;
  const diff = repeat + (extras.diff_body ?? 0);
  const ooo = diff + (extras.out_of_order ?? 0);
  const invalid = ooo + (extras.invalid ?? 0);
  const posts: Post[] = [];
  const recent: Post[] = []; // the last few new valid events, for repeats and diff_body
  let lastNew = -1; // index of the last new event that may still swap places
  const total = Math.round(rate * scenario.duration_s);
  for (let n = 0; n < total; n++) {
    const at_ms = Math.floor((n * 1000) / rate);
    const x = r();
    const old = recent[pick(recent.length)];
    if (x < diff && old) {
      const email = x < repeat ? null : `${old.user_id}.${n}.changed@example.com`;
      const body = email === null ? old.body : eventBody(old.event_id ?? '', old.user_id ?? '', old.created_at ?? '', email);
      posts.push({ ...old, at_ms, body });
      // Its original may no longer swap to a later slot, or the copy would be sent first.
      if (lastNew >= 0 && posts[lastNew]?.event_id === old.event_id) lastNew = -1;
    } else if (x >= diff && x < ooo && lastNew >= 0 && at_ms - posts[lastNew]!.at_ms <= 1000) {
      // A newer event of the same user takes the earlier slot; the earlier-created one is sent now.
      const earlier = posts[lastNew]!;
      const later = newEvent(at_ms, earlier.user_id ?? '', n);
      posts[lastNew] = { ...later, at_ms: earlier.at_ms };
      posts.push({ ...earlier, at_ms });
      recent.push(later);
      lastNew = -1;
    } else if (x >= ooo && x < invalid) {
      posts.push(badPost(at_ms, uuid(), user(), BASE_MS + at_ms, pick(5)));
    } else {
      const p = newEvent(at_ms, user(), n);
      lastNew = posts.push(p) - 1;
      recent.push(p);
    }
    if (recent.length > 10) recent.shift();
  }
  return posts;
}

function badPost(at_ms: number, id: string, user_id: string, ms: number, kind: number): Post {
  const created_at = new Date(ms).toISOString();
  const valid = { event_id: id, user_id, created_at, type: 'user.updated', data: { email: 'bad@example.com' } };
  const none = { event_id: null, user_id: null, created_at: null };
  const [fields, text] = (
    [
      [none, `{"event_id": "${id}", "user_id": `],
      [none, JSON.stringify([valid])],
      [{ event_id: id, user_id: null, created_at }, JSON.stringify({ ...valid, user_id: undefined })],
      [{ event_id: '', user_id, created_at }, JSON.stringify({ ...valid, event_id: '' })],
      [{ event_id: id, user_id, created_at: 'yesterday' }, JSON.stringify({ ...valid, created_at: 'yesterday' })],
    ] as const
  )[kind]!;
  return { at_ms, body: Buffer.from(text), ...fields, valid: false };
}

// Sends each post at start + at_ms without waiting for earlier answers; resolves once every post is answered or given up.
export async function run(opts: { scenario: Scenario; dataDir: string; url: string }): Promise<void> {
  const file = join(opts.dataDir, 'loadgen.ndjson');
  writeFileSync(file, '');
  const agent = new Agent({ keepAlive: true });
  const start = Date.now();
  const send = (p: Post): Promise<void> =>
    new Promise((resolve) => {
      const t_send = Date.now();
      let done = false;
      let status: number | null = null; // kept once a status line arrives, even if the body is then cut off
      const finish = (status: number | null, err?: string): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const line: LoadgenLine = {
          t_send,
          t_done: Date.now(),
          event_id: p.event_id,
          user_id: p.user_id,
          created_at: p.created_at,
          body_sha256: createHash('sha256').update(p.body).digest('hex'),
          valid: p.valid,
          status,
        };
        if (err !== undefined) line.err = err;
        appendFileSync(file, JSON.stringify(line) + '\n');
        resolve();
      };
      const fail = (e: NodeJS.ErrnoException): void => finish(status, e.code ?? e.message);
      const timer = setTimeout(() => {
        finish(status, 'timeout');
        req?.destroy();
      }, LIMIT_MS);
      let req: ReturnType<typeof request> | undefined;
      try {
        req = request(opts.url, { method: 'POST', agent, headers: { 'Content-Type': 'application/json' } }, (res) => {
          status = res.statusCode ?? null;
          res.resume();
          res.on('end', () => finish(status));
          res.on('error', fail);
          res.on('close', () => finish(status, 'answer closed before its end'));
        });
      } catch (e) {
        fail(e as NodeJS.ErrnoException); // a URL request() cannot use throws at once
        return;
      }
      req.on('error', fail);
      req.end(p.body);
    });
  const sends = plan(opts.scenario).map(
    (p) => new Promise<void>((resolve) => setTimeout(() => resolve(send(p)), Math.max(0, start + p.at_ms - Date.now()))),
  );
  try {
    await Promise.all(sends);
  } finally {
    agent.destroy();
  }
}

if (import.meta.main) {
  const env = process.env;
  const file = env['SCENARIO_FILE'];
  if (!file) throw new Error('SCENARIO_FILE is not set');
  await run({
    scenario: parseScenario(JSON.parse(readFileSync(file, 'utf8'))),
    dataDir: env['DATA_DIR'] ?? '/data',
    url: env['INTAKE_URL'] ?? 'http://localhost:8080/events',
  });
}
