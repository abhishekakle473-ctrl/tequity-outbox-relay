// Contracts shared by the rig's fake endpoint, load generator and checker (docs/plan.md, "Scenario files").

export type Mode = 'healthy' | 'fail' | 'down' | 'slow' | 'limit';
export const MODES: readonly Mode[] = ['healthy', 'fail', 'down', 'slow', 'limit'];

export interface Step {
  from_s: number;
  to_s: number;
  mode: Mode;
  p?: number;
  latency_ms?: number;
  // A string lets a scenario send a broken header on purpose.
  retry_after?: number | string;
  users?: readonly string[];
}

export interface Extras {
  repeat?: number;
  diff_body?: number;
  out_of_order?: number;
  invalid?: number;
}

export interface Load {
  rate: number;
  users: number;
  heavy_users: number;
  heavy_share: number;
  extras?: Extras;
}

// Restarts or kills one relay container at_s seconds into the run; rig/chaos.ts carries it out.
export interface RelayStep {
  at_s: number;
  action: 'restart' | 'kill';
  service: 'api' | 'worker' | 'postgres';
}

export interface Scenario {
  seed: number;
  duration_s: number;
  drain_s: number;
  load: Load;
  steps: readonly Step[];
  relay?: readonly RelayStep[];
}

// One line of loadgen.ndjson per post.
export interface LoadgenLine {
  t_send: number;
  t_done: number;
  event_id: string | null;
  user_id: string | null;
  created_at: string | null;
  body_sha256: string;
  valid: boolean;
  status: number | null;
  err?: string;
}

// One line of endpoint.ndjson per request to POST /events.
export interface EndpointLine {
  t: number;
  event_id: string | null;
  user_id: string | null;
  created_at: string | null;
  body_sha256: string;
  mode: Mode;
  status: number;
  saved: boolean;
}

// One line of modes.ndjson per mode change; users null means every user.
export interface ModeLine {
  t: number;
  mode: Mode | 'relay_stopped' | 'relay_running';
  users: readonly string[] | null;
}

export type CheckName = 'exactly_once' | 'order' | 'timing' | 'intake_up' | 'bytes';

export interface CheckResult {
  check: CheckName;
  pass: boolean;
  detail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`scenario: ${field} must be a number`);
  }
  return value;
}

function optNum(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : num(value, field);
}

function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function range(value: number | undefined, field: string, min: number, max: number): void {
  if (value !== undefined && (value < min || value > max)) {
    throw new TypeError(`scenario: ${field} must be between ${min} and ${max}`);
  }
}

function parseStep(raw: unknown, i: number): Step {
  if (!isRecord(raw)) throw new TypeError(`scenario: steps[${i}] must be an object`);
  const mode = raw['mode'];
  if (!isMode(mode)) throw new TypeError(`scenario: steps[${i}].mode must be one of ${MODES.join(', ')}`);
  const step: Step = {
    from_s: num(raw['from_s'], `steps[${i}].from_s`),
    to_s: num(raw['to_s'], `steps[${i}].to_s`),
    mode,
  };
  range(step.from_s, `steps[${i}].from_s`, 0, Infinity);
  if (step.to_s <= step.from_s) throw new TypeError(`scenario: steps[${i}].to_s must be after from_s`);
  const p = optNum(raw['p'], `steps[${i}].p`);
  range(p, `steps[${i}].p`, 0, 1);
  if (p !== undefined) step.p = p;
  const latency = optNum(raw['latency_ms'], `steps[${i}].latency_ms`);
  range(latency, `steps[${i}].latency_ms`, 0, Infinity);
  if (latency !== undefined) step.latency_ms = latency;
  const retryAfter = raw['retry_after'];
  if (retryAfter !== undefined) {
    // A broken value is allowed on purpose, but only printable text can go in an HTTP header.
    if (typeof retryAfter === 'number' || (typeof retryAfter === 'string' && /^[\x20-\x7e]*$/.test(retryAfter))) {
      step.retry_after = retryAfter;
    } else {
      throw new TypeError(`scenario: steps[${i}].retry_after must be a number or printable text`);
    }
  }
  const users = raw['users'];
  if (users !== undefined) {
    if (!Array.isArray(users) || !users.every(isString)) {
      throw new TypeError(`scenario: steps[${i}].users must be an array of strings`);
    }
    step.users = users.filter(isString);
  }
  return step;
}

function parseRelayStep(raw: unknown, i: number): RelayStep {
  if (!isRecord(raw)) throw new TypeError(`scenario: relay[${i}] must be an object`);
  const { action, service } = raw;
  if (action !== 'restart' && action !== 'kill') {
    throw new TypeError(`scenario: relay[${i}].action must be restart or kill`);
  }
  if (service !== 'api' && service !== 'worker' && service !== 'postgres') {
    throw new TypeError(`scenario: relay[${i}].service must be api, worker or postgres`);
  }
  const at_s = num(raw['at_s'], `relay[${i}].at_s`);
  range(at_s, `relay[${i}].at_s`, 0, Infinity);
  return { at_s, action, service };
}

// Validates a parsed scenario file once at the boundary, so the rest of the rig can trust its shape.
export function parseScenario(raw: unknown): Scenario {
  if (!isRecord(raw)) throw new TypeError('scenario: must be an object');
  const load = raw['load'];
  if (!isRecord(load)) throw new TypeError('scenario: load must be an object');
  const extrasRaw = load['extras'];
  const parsedLoad: Load = {
    rate: num(load['rate'], 'load.rate'),
    users: num(load['users'], 'load.users'),
    heavy_users: num(load['heavy_users'], 'load.heavy_users'),
    heavy_share: num(load['heavy_share'], 'load.heavy_share'),
  };
  if (extrasRaw !== undefined) {
    if (!isRecord(extrasRaw)) throw new TypeError('scenario: load.extras must be an object');
    const extras: Extras = {};
    for (const key of ['repeat', 'diff_body', 'out_of_order', 'invalid'] as const) {
      const v = optNum(extrasRaw[key], `load.extras.${key}`);
      if (v !== undefined) extras[key] = v;
    }
    parsedLoad.extras = extras;
  }
  const rawSteps = raw['steps'];
  if (!Array.isArray(rawSteps)) throw new TypeError('scenario: steps must be an array');
  const steps = rawSteps.map(parseStep);
  refuseOverlaps(steps);
  const scenario: Scenario = {
    seed: num(raw['seed'], 'seed'),
    duration_s: num(raw['duration_s'], 'duration_s'),
    drain_s: num(raw['drain_s'], 'drain_s'),
    load: parsedLoad,
    steps,
  };
  const rawRelay = raw['relay'];
  if (rawRelay !== undefined) {
    if (!Array.isArray(rawRelay)) throw new TypeError('scenario: relay must be an array');
    scenario.relay = rawRelay.map(parseRelayStep);
  }
  return scenario;
}

// Two steps may share a moment only for different users, so modes.ndjson always says what each user gets.
function refuseOverlaps(steps: readonly Step[]): void {
  steps.forEach((a, i) => {
    steps.slice(i + 1).forEach((b, k) => {
      const sameTime = a.from_s < b.to_s && b.from_s < a.to_s;
      const allUsers = a.mode === 'down' || b.mode === 'down' || a.users === undefined || b.users === undefined;
      const sameUsers = allUsers || (a.users ?? []).some((u) => (b.users ?? []).includes(u));
      if (sameTime && sameUsers) throw new TypeError(`scenario: steps[${i}] and steps[${i + k + 1}] overlap`);
    });
  });
}
