// Restarts and kills relay containers on the scenario's schedule, and marks each outage in modes.ndjson for the checker.
import { execFile } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseScenario } from './types.ts';
import type { ModeLine, RelayStep } from './types.ts';

export type Docker = (args: string[]) => Promise<string>;

export interface RunOptions {
  relay: readonly RelayStep[];
  dataDir: string;
  docker: Docker;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  ready: (service: RelayStep['service']) => Promise<void>;
}

const execFileAsync = promisify(execFile);
const dockerCli: Docker = async (args) => (await execFileAsync('docker', args)).stdout;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The API counts as ready when 8080 answers anything; Postgres when its healthcheck passes, then the API's pool must
// reconnect, so the API is checked too. The worker posts nothing to the API, so it needs no wait.
async function readyLive(service: RelayStep['service']): Promise<void> {
  if (service === 'worker') return;
  if (service === 'postgres') {
    for (;;) {
      const id = await findContainer(dockerCli, 'postgres');
      const health = id === null ? '' : (await dockerCli(['inspect', '-f', '{{.State.Health.Status}}', id])).trim();
      if (health === 'healthy') break;
      await pause(200);
    }
  }
  for (;;) {
    // An empty JSON object is refused with 400 before Postgres is touched, so only a 400 shows the API itself is up;
    // for postgres a valid-shaped probe would store an event, so the API's own 503s while reconnecting are left to the checker.
    const status = await fetch('http://127.0.0.1:8080/events', { method: 'POST', body: '{}' }).then((r) => r.status, () => 0);
    if (status === 400) return;
    await pause(200);
  }
}

// 130 s: the relay gives sends in flight 120 s after SIGTERM, then the stop must not cut in first.
export function actionCommands(action: RelayStep['action'], id: string): string[][] {
  return action === 'restart' ? [['restart', '-t', '130', id]] : [['kill', id], ['start', id]];
}

// By compose label, so it works under any project name; this rig's own containers (project "rig") are skipped.
export async function findContainer(docker: Docker, service: string): Promise<string | null> {
  const out = await docker([
    'ps', '-a', '-q',
    '--filter', `label=com.docker.compose.service=${service}`,
    '--format', '{{.ID}} {{.Label "com.docker.compose.project"}}',
  ]);
  for (const line of out.split('\n')) {
    const [id, project] = line.trim().split(' ');
    if (id !== undefined && id !== '' && project !== 'rig') return id;
  }
  return null;
}

// Returns false if any step could not be carried out; later steps still run.
export async function run({ relay, dataDir, docker, now, sleep, ready }: RunOptions): Promise<boolean> {
  const modes = join(dataDir, 'modes.ndjson');
  // Append only: the endpoint owns this file and wipes it when it starts.
  const mark = (mode: ModeLine['mode']): void => {
    appendFileSync(modes, JSON.stringify({ t: now(), mode, users: null } satisfies ModeLine) + '\n');
  };
  const start = now();
  let ok = true;
  for (const step of [...relay].sort((a, b) => a.at_s - b.at_s)) {
    await sleep(Math.max(0, start + step.at_s * 1000 - now()));
    try {
      const id = await findContainer(docker, step.service);
      if (id === null) throw new Error(`no container for service ${step.service}`);
      mark('relay_stopped');
      for (const args of actionCommands(step.action, id)) await docker(args);
      // docker returns once the container starts, not once it answers; posts refused before then are not the relay's fault.
      await ready(step.service);
      mark('relay_running');
    } catch (err) {
      ok = false;
      console.error(JSON.stringify({ chaos: 'step failed', step, error: String(err) }));
    }
  }
  return ok;
}

if (import.meta.main) {
  const file = process.env['SCENARIO_FILE'];
  if (file === undefined) throw new Error('chaos: SCENARIO_FILE is not set');
  const { relay } = parseScenario(JSON.parse(readFileSync(file, 'utf8')));
  const ok =
    relay === undefined ||
    (await run({
      relay,
      dataDir: process.env['DATA_DIR'] ?? '/data',
      docker: dockerCli,
      now: Date.now,
      sleep: pause,
      ready: readyLive,
    }));
  process.exitCode = ok ? 0 : 1;
}
