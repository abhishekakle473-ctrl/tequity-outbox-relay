// Grades one test run from the rig's three NDJSON logs against the brief's pass conditions (docs/plan.md, "The checker's checks").
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { MODES, parseScenario } from './types.ts';
import type { CheckName, CheckResult, EndpointLine, LoadgenLine, Mode, ModeLine } from './types.ts';

const HEALTHY_WINDOW_MS = 30_000;
const RECOVERY_WINDOW_MS = 300_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStrOrNull = (v: unknown): boolean => v === null || typeof v === 'string';
const isMode = (v: unknown): v is Mode => typeof v === 'string' && (MODES as readonly string[]).includes(v);

function isLoadgen(v: unknown): v is LoadgenLine {
  return isRecord(v) && isNum(v['t_send']) && isNum(v['t_done']) && isStrOrNull(v['event_id']) && isStrOrNull(v['user_id'])
    && isStrOrNull(v['created_at']) && typeof v['body_sha256'] === 'string' && typeof v['valid'] === 'boolean'
    && (v['status'] === null || isNum(v['status'])) && (v['err'] === undefined || typeof v['err'] === 'string');
}

function isEndpoint(v: unknown): v is EndpointLine {
  return isRecord(v) && isNum(v['t']) && isStrOrNull(v['event_id']) && isStrOrNull(v['user_id']) && isStrOrNull(v['created_at'])
    && typeof v['body_sha256'] === 'string' && isMode(v['mode']) && isNum(v['status']) && typeof v['saved'] === 'boolean';
}

function isModeLine(v: unknown): v is ModeLine {
  if (!isRecord(v) || !isNum(v['t'])) return false;
  const users = v['users'];
  return (isMode(v['mode']) || v['mode'] === 'relay_stopped' || v['mode'] === 'relay_running')
    && (users === null || (Array.isArray(users) && users.every((u) => typeof u === 'string')));
}

// A missing loadgen or endpoint log counts as empty (nothing was posted or saved); a missing modes log
// means the fake endpoint never ran, which is a rig fault, so it throws. A malformed line throws, naming file and line.
function readLines<T>(dir: string, name: string, guard: (v: unknown) => v is T, required = false): T[] {
  const path = join(dir, name);
  if (!existsSync(path)) {
    if (required) throw new Error(`${name}: missing; the fake endpoint writes it at start`);
    return [];
  }
  return readFileSync(path, 'utf8').split('\n').flatMap((text, i): T[] => {
    if (text.trim() === '') return [];
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Error(`${name}:${i + 1}: not JSON: ${text.slice(0, 200)}`);
    }
    if (!guard(v)) throw new Error(`${name}:${i + 1}: malformed line: ${text.slice(0, 200)}`);
    return [v];
  });
}

const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))?$/;

// created_at as microseconds since the epoch; Date keeps milliseconds only, so the fraction is added exactly.
// No zone means UTC (README assumptions). Returns null when unreadable.
function micros(stamp: string): bigint | null {
  const m = STAMP.exec(stamp);
  if (m === null) return null;
  const [, y, mo, d, h, mi, s, frac = '', zone, sign, oh, om] = m;
  const wholeMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  // Date.UTC rolls month 13 or minute 99 over into a valid time; refuse any field it had to change.
  const back = new Date(wholeMs);
  if (back.getUTCMonth() + 1 !== Number(mo) || back.getUTCDate() !== Number(d) || back.getUTCHours() !== Number(h)
    || back.getUTCMinutes() !== Number(mi) || back.getUTCSeconds() !== Number(s)) return null;
  if (zone !== undefined && zone !== 'Z' && (Number(oh) > 23 || Number(om) > 59)) return null;
  const offsetMs = zone === undefined || zone === 'Z' ? 0 : (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om)) * 60_000;
  return BigInt(wholeMs - offsetMs) * 1000n + BigInt(frac.padEnd(6, '0'));
}

const nothing = (check: CheckName, why: string): CheckResult => ({ check, pass: false, detail: `nothing to judge: ${why}` });
const is2xx = (status: number | null): boolean => status !== null && status >= 200 && status < 300;

interface Promised {
  id: string;
  user: string;
  at: number;
  sha: string;
}

// Each promised event with its first 2xx post (lowest t_done), in loadgen order.
function promisedEvents(loadgen: LoadgenLine[]): Map<string, Promised> {
  const promised = new Map<string, Promised>();
  for (const l of loadgen) {
    if (!l.valid || !is2xx(l.status) || l.event_id === null) continue;
    const prev = promised.get(l.event_id);
    if (prev === undefined || l.t_done < prev.at) {
      promised.set(l.event_id, { id: l.event_id, user: l.user_id ?? '', at: l.t_done, sha: l.body_sha256 });
    }
  }
  return promised;
}

function exactlyOnce(promised: Map<string, Promised>, saved: EndpointLine[]): CheckResult {
  if (promised.size === 0) return nothing('exactly_once', 'no event was answered 2xx');
  const counts = new Map<string, number>();
  for (const l of saved) counts.set(l.event_id ?? '(no event_id)', (counts.get(l.event_id ?? '(no event_id)') ?? 0) + 1);
  const offences: string[] = [];
  for (const id of promised.keys()) {
    const n = counts.get(id) ?? 0;
    if (n !== 1) offences.push(`event ${id} saved ${n} times`);
  }
  for (const [id, n] of counts) if (!promised.has(id)) offences.push(`event ${id} saved ${n} times but never promised`);
  if (offences.length === 0) return { check: 'exactly_once', pass: true, detail: `${promised.size} promised events each saved once` };
  return { check: 'exactly_once', pass: false, detail: `${offences.length} offending events of ${promised.size} promised; first: ${offences[0]}` };
}

function order(saved: EndpointLine[]): CheckResult {
  if (saved.length === 0) return nothing('order', 'no event was saved');
  const last = new Map<string, { at: bigint; id: string | null; created: string }>();
  const offences: string[] = [];
  for (const l of [...saved].sort((a, b) => a.t - b.t)) {
    const user = l.user_id ?? '';
    const at = l.created_at === null ? null : micros(l.created_at);
    if (at === null) {
      offences.push(`event ${l.event_id} of ${user} has unreadable created_at ${JSON.stringify(l.created_at)}`);
      continue;
    }
    const prev = last.get(user);
    if (prev !== undefined && at <= prev.at) {
      offences.push(`event ${l.event_id} of ${user} (${l.created_at}) saved after event ${prev.id} (${prev.created})`);
    }
    last.set(user, { at, id: l.event_id, created: l.created_at ?? '' });
  }
  if (offences.length === 0) return { check: 'order', pass: true, detail: `${saved.length} saves in created_at order for ${last.size} users` };
  return { check: 'order', pass: false, detail: `${offences.length} saves out of order; first: ${offences[0]}` };
}

interface Period {
  start: number;
  end: number;
  mode: Mode;
}

// The user's modes over time: healthy before the first line, then each line naming the user (or all users) overrides.
function periodsFor(user: string, modes: ModeLine[]): Period[] {
  const periods: Period[] = [{ start: -Infinity, end: Infinity, mode: 'healthy' }];
  for (const l of modes) {
    if (l.mode === 'relay_stopped' || l.mode === 'relay_running') continue;
    if (l.users !== null && !l.users.includes(user)) continue;
    const cur = periods[periods.length - 1];
    if (cur === undefined || cur.mode === l.mode) continue;
    cur.end = l.t;
    periods.push({ start: l.t, end: Infinity, mode: l.mode });
  }
  return periods;
}

function timing(promised: Map<string, Promised>, saved: EndpointLine[], modes: ModeLine[]): CheckResult {
  if (promised.size === 0) return nothing('timing', 'no event was answered 2xx');
  const savedAt = new Map<string, number>();
  for (const l of saved) if (l.event_id !== null) savedAt.set(l.event_id, Math.min(l.t, savedAt.get(l.event_id) ?? Infinity));
  const byUser = new Map<string, Promised[]>();
  for (const p of promised.values()) byUser.set(p.user, [...(byUser.get(p.user) ?? []), p]);

  let late = 0;
  let worst = { lateness: -Infinity, text: '' };
  for (const [user, events] of byUser) {
    const periods = periodsFor(user, modes);
    // A recovery starts a healthy period lasting at least 30 s, or still healthy when the logs end.
    const recoveries = periods
      .filter((p) => p.mode === 'healthy' && p.start !== -Infinity && (p.end === Infinity || p.end - p.start >= HEALTHY_WINDOW_MS))
      .map((p) => p.start);
    for (const e of events) {
      const s = savedAt.get(e.id) ?? Infinity;
      let deadline = e.at + HEALTHY_WINDOW_MS;
      if (periods.some((p) => p.mode !== 'healthy' && p.start <= e.at + HEALTHY_WINDOW_MS && p.end > e.at)) {
        const r = recoveries.find((x) => x >= e.at);
        deadline = r === undefined ? Infinity : r + RECOVERY_WINDOW_MS;
      }
      // An event promised while an earlier one of the same user is still unsaved waits behind it (README):
      // its deadline is the user's last recovery before its promise plus 300 s, when that is later.
      const behind = events.some((f) => f.at < e.at && (savedAt.get(f.id) ?? Infinity) > e.at);
      const lastRecovery = recoveries.filter((x) => x <= e.at).at(-1);
      if (behind && lastRecovery !== undefined) deadline = Math.max(deadline, lastRecovery + RECOVERY_WINDOW_MS);
      const lateness = s === Infinity ? Infinity : s - deadline;
      if (lateness <= 0) continue;
      late++;
      if (lateness > worst.lateness) {
        worst = { lateness, text: s === Infinity ? `event ${e.id} of ${user} never saved` : `event ${e.id} of ${user} saved ${lateness} ms late` };
      }
    }
  }
  if (late === 0) return { check: 'timing', pass: true, detail: `${promised.size} promised events saved by their deadlines` };
  return { check: 'timing', pass: false, detail: `${late} of ${promised.size} promised events missed their deadline; worst: ${worst.text}` };
}

function intakeUp(loadgen: LoadgenLine[], modes: ModeLine[]): CheckResult {
  if (loadgen.length === 0) return nothing('intake_up', 'no post was made');
  const stopped: [number, number][] = [];
  let open: number | null = null;
  for (const l of modes) {
    if (l.mode === 'relay_stopped' && open === null) open = l.t;
    if (l.mode === 'relay_running' && open !== null) {
      stopped.push([open, l.t]);
      open = null;
    }
  }
  if (open !== null) stopped.push([open, Infinity]);
  let judged = 0;
  const offences: string[] = [];
  for (const l of loadgen) {
    if (stopped.some(([from, to]) => l.t_send >= from && l.t_send < to)) continue;
    judged++;
    const name = l.event_id === null ? `post at t_send ${l.t_send}` : `event ${l.event_id}`;
    const answer = l.status ?? `no answer (${l.err ?? 'unknown error'})`;
    if (l.valid && !is2xx(l.status)) offences.push(`valid ${name} got ${answer}`);
    else if (l.valid && l.t_done - l.t_send > 1000) offences.push(`valid ${name} answered after ${l.t_done - l.t_send} ms`);
    else if (!l.valid && l.status !== 400) offences.push(`invalid ${name} got ${answer}`);
  }
  if (judged === 0) return nothing('intake_up', 'every post was inside a relay_stopped window');
  if (offences.length === 0) return { check: 'intake_up', pass: true, detail: `${judged} posts answered correctly outside relay_stopped windows` };
  return { check: 'intake_up', pass: false, detail: `${offences.length} of ${judged} posts answered wrongly; first: ${offences[0]}` };
}

function bytes(promised: Map<string, Promised>, saved: EndpointLine[]): CheckResult {
  if (saved.length === 0) return nothing('bytes', 'no event was saved');
  const offences: string[] = [];
  let judged = 0;
  for (const l of saved) {
    const p = l.event_id === null ? undefined : promised.get(l.event_id);
    if (p === undefined) continue;
    judged++;
    if (l.body_sha256 !== p.sha) offences.push(`event ${p.id} saved with body ${l.body_sha256}, promised ${p.sha}`);
  }
  if (judged === 0) return nothing('bytes', 'no saved event was promised');
  if (offences.length === 0) return { check: 'bytes', pass: true, detail: `${judged} saved bodies match their promised bodies` };
  return { check: 'bytes', pass: false, detail: `${offences.length} of ${judged} saved bodies differ; first: ${offences[0]}` };
}

export function check(dataDir: string): CheckResult[] {
  const loadgen = readLines(dataDir, 'loadgen.ndjson', isLoadgen);
  const endpoint = readLines(dataDir, 'endpoint.ndjson', isEndpoint);
  // Stable sort keeps file order for lines with the same t.
  const modes = readLines(dataDir, 'modes.ndjson', isModeLine, true).sort((a, b) => a.t - b.t);
  const saved = endpoint.filter((l) => l.saved);
  const promised = promisedEvents(loadgen);
  return [exactlyOnce(promised, saved), order(saved), timing(promised, saved, modes), intakeUp(loadgen, modes), bytes(promised, saved)];
}

if (import.meta.main) {
  if (process.argv.includes('--wait')) {
    const scenario = parseScenario(JSON.parse(readFileSync(process.env['SCENARIO_FILE'] ?? '', 'utf8')));
    await sleep(scenario.drain_s * 1000);
  }
  const results = check(process.env['DATA_DIR'] ?? '/data');
  for (const r of results) console.log(JSON.stringify(r));
  process.exitCode = results.every((r) => r.pass) ? 0 : 1;
}
