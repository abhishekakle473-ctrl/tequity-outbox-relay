# Build plan

For agentic workers: use superpowers:subagent-driven-development or superpowers:executing-plans to carry out this plan one unit at a time.

**Goal:** build the outbox relay described in docs/decisions.md, and the test rig that proves it meets the brief's four pass conditions.

**Architecture:** docs/architecture.md: parts, the life of one event, files and contracts.

**Tech stack:** TypeScript run directly by Node.js 24 (`node:24.22.3-alpine3.24`), erasable syntax only, `pg` the only runtime dependency, `typescript` 7.0.2 and `@types/node` 24.19.2 as dev dependencies, Postgres `16.16-alpine`, Docker Compose with host networking, `node --test` and `tsc --noEmit` for unit tests.

**Spec:** docs/decisions.md, docs/problem.md, README.md.

## Global constraints

Every unit follows CLAUDE.md and docs/decisions.md. Ports are 8080 (intake), 9000 (endpoint) and 127.0.0.1:54329 (Postgres). The relay keeps all state in Postgres; the rig's NDJSON logs are test output. No shell scripts; compose and the Dockerfile hold their commands inline. Every unit passes `npx tsc --noEmit` with the strict tsconfig as well as its tests, and no `.js` file is committed. Each unit is one commit that carries its own doc edits, and its message names the test run that proved it and what that run printed.

## The checker's checks

The checker takes `loadgen.ndjson`, `endpoint.ndjson` and `modes.ndjson`. A check with nothing to judge fails, so an empty run can never pass.

`exactly_once`: every event_id the load generator got a 2xx for appears exactly once with `saved: true` in the endpoint log, and nothing is saved that was never answered 2xx. Fails if no event got a 2xx.

`order`: for each user, the `created_at` values of saved events, in the order the endpoint saved them, strictly increase. Fails if nothing was saved.

`timing`: each promised event is saved by its deadline. The deadline is `t_done` plus 30 s, unless the endpoint was in a mode other than healthy for that user within those 30 s; then it is the user's next recovery plus 300 s. An event promised while an earlier event of the same user is still unsaved waits behind it, so its deadline is the user's last recovery before its promise plus 300 s, when that is later. Both follow the README's interpretation of the brief's 5-minute rule. A recovery is the start of a healthy period, for that user, that lasts at least 30 s, so a flapping endpoint has not recovered until it stays up.

`intake_up`: outside `relay_stopped` windows, every valid post got a 2xx within 1 s and every invalid post got a 400. Fails if nothing was posted.

`bytes`: every saved body's hash equals the hash of the body that got the event's 2xx.

## Regression rule

`rig/baseline.json` lists, per scenario, the checks that have passed. After every unit, `node --test` and every scenario in `rig/scenarios/` run. A check listed in the baseline that now fails stops the unit. The baseline only grows. Handover needs three full runs in a row with every listed check passing.

The scenarios are healthy, fail, down-5min, slow, limit-user, limit-all, input, slots, flap, restart and kill. In slots, the endpoint answers 300 users after 20 s each, so all 200 slots fill, while one light user stays healthy; it passes when that user's events are saved within their 30-second deadline. In flap, after a 5-minute outage the endpoint goes down and up every 3 s for 60 s before it stays up; it passes all five checks. Each is seeded, so its posts and the endpoint's answers repeat exactly. A run is `SCENARIO=<name> docker compose -f rig/compose.yaml run --rm check`, then `docker compose -f rig/compose.yaml down`; `up --exit-code-from check` would stop the rig as soon as the load generator exits, before the checker runs. The logs go to the named volume `rig_data`, since on Docker Desktop for Windows a bind mount made the load generator's 12,000 appends take minutes.

## Scenario files

A scenario is one JSON file in `rig/scenarios/`, read by the fake endpoint, the load generator and the checker.
- `seed`: the integer behind every random choice.
- `duration_s`: how long the load generator posts.
- `drain_s`: how long the checker waits after the load generator finishes before it grades.
- `load.rate`: posts a second, at most 100.
- `load.users`: the number of users, named `u0001` upward.
- `load.heavy_users` and `load.heavy_share`: the first `heavy_users` users get `heavy_share` of the posts.
- `load.extras`: the chance, per post, of `repeat` (the same event again), `diff_body` (the same event_id with another body), `out_of_order` (sent up to 1 s before an earlier event of its user) and `invalid` (a bad body).
- `steps`: a list of `{from_s, to_s, mode, p, latency_ms, retry_after, users}`, timed from the endpoint's start; outside every step the endpoint is healthy. healthy and slow answer 200 after `latency_ms`. fail answers 500 with chance `p`, else 200. limit answers 429 with `Retry-After: retry_after` with chance `p`, else 200. down closes the listener, so connections are refused. `users`, when given, limits a step to those user_ids; down ignores it.

Every mode change, for all users or a list, is one `modes.ndjson` line `{t, mode, users}`, with `users` null for all.

## Capacity

U7 records these at full load on Docker Desktop, and U9 again on Linux, each next to the figure we expect from docs/decisions.md. A figure worse than expected goes back to the decision it rests on before the unit is done.
- Our time per event, the `delivered_at` commit plus the next-event lookup: about 5 ms, the pgbench figure in the 10 ms entry.
- Intake answer time while a 30,000-event backlog drains: well under the 1 s `intake_up` limit; one durable commit, about 3 to 4 ms in pgbench, is most of it.
- The poll query at 30,000 unsent events: under the 200 ms between polls; the 1,000-event figure, under 2 ms, suggests about 30 ms.
- Delivery rate while a 5-minute outage clears: about 200 events a second, from the 10 ms entry.
- The worker's CPU and memory with 200 sends in flight: decisions.md gives no figure; we expect well under one core and under 200 MB.

## Review focus

These inputs are implied by the spec but easy to miss. Each one has a test in the unit named.
- One user with created_at in mixed zones (`Z` and `+05:30`): sent in true time order (U5).
- The same event posted twice at the same moment on two connections: one row, two 200s (U3).
- The endpoint closes an idle keep-alive socket and the next send gets a reset before any status line: resent once, not counted as saved (U4).
- A heavy user with a large backlog getting `Retry-After: 0`: paused 1 s, never a tight loop (U6).
- SIGTERM while Postgres is down: the stop waits to the 120 s kill, and the event is resent after restart, reported in the run (U8).

## How every relay unit runs

Every unit, U1 to U10, goes through the same six steps. A subagent builder does steps 1 and 2 and reports its commands and their output; it never commits. Steps 3 to 6 are done in this session.
1. Failing tests. Write the tests named under "Done when", run them, and see each one fail for the reason it names, never for a typo or a missing import alone.
2. Code. Write the least code that makes them pass, then run the unit's tests until they pass.
3. Regression run. Run every unit test with `node --test`, `npx tsc --noEmit`, and, from U3 on, every scenario already listed in `rig/baseline.json`. A listed check that fails stops the unit.
4. Review. The unit's reviewers run in parallel, read only, each given the unit's files and its section of this plan. A confirmed finding gets a failing test first, then the fix; a finding pushed back on is named in the commit message with the reason.
5. Verify, with superpowers:verification-before-completion: a fresh run of step 3, exit codes captured, and the "Done when" list checked line by line.
6. Commit. One commit with the unit's files named one by one, its doc edits, and a message that states what was built and names each test run with what it printed. No `.js` file.

Tests run in the pinned image. Tests that need Postgres use host networking to reach 127.0.0.1:54329:
`MSYS_NO_PATHCONV=1 docker run --rm --network host -v "<repo>:/app" -w /app node:24.22.3-alpine3.24 node --test <files>`
Each test file that needs Postgres gets its own database from `freshDb` (U1), so units running at the same time never touch each other's rows.

## Waves

Units in one wave touch no file in common and can be built at the same time. Rig scenario runs hold ports 8080, 9000 and 54329, so only one unit runs scenarios at a time.

| Wave | Units | Built by |
|---|---|---|
| 1 | U1, U2, U4 | U1 and U2 by subagents, U4 in this session |
| 2 | U3, U5 | U3 by a subagent, U5 in this session |
| 3 | U6 | this session |
| 4 | U7 | this session |
| 5 | U8 | a subagent |
| 6 | U9 | this session, with the author |
| 7 | U10 | this session |

U7 and U8 both run scenarios and both add to `rig/baseline.json`, so they are separate waves.

## Units

### R1 Fake endpoint
Builds `rig/endpoint.ts` and `rig/endpoint.test.ts`: plays a scenario's steps on :9000 and writes `endpoint.ndjson` and `modes.ndjson`.
Done when `node --test rig/endpoint.test.ts` shows that:
- the same seed gives the same answer sequence
- `down` closes the listener so connects are refused
- `slow` delays by `latency_ms`
- `limit` answers 429 with `retry_after`
- a duplicate post is saved and logged twice
- each request and each mode change is exactly one log line

Parallel with R2 and R3.

### R2 Load generator
Builds `rig/loadgen.ts` and `rig/loadgen.test.ts`: posts a scenario's load to :8080 and writes `loadgen.ndjson`.
Done when `node --test rig/loadgen.test.ts` shows that:
- the same seed gives the same events
- each user's created_at strictly increases
- no second has more than `rate` posts
- the heavy users get `heavy_share` of the posts
- the input scenario mixes in repeats, different-body repeats, events up to 1 s out of order and invalid bodies, with `valid` set to match

Parallel with R1 and R3.

### R3 Checker
Builds `rig/check.ts` and `rig/check.test.ts`: the five checks above.
Done when `node --test rig/check.test.ts` shows that:
- a clean hand-made run passes all five
- one hand-made violation per check fails exactly that check, naming the event in `detail`
- empty logs fail all five with "nothing to judge"

Parallel with R1 and R2.

### R4 Rig compose and failing baseline
Builds `rig/compose.yaml`, `rig/Dockerfile`, `rig/scenarios/*.json` and an empty `rig/baseline.json`. The checker starts when the load generator completes.
Done when `SCENARIO=healthy` with no relay running prints five FAIL lines, each for the right reason:
- `intake_up` reports that :8080 refused every post
- the other four report "nothing to judge"

The commit carries that output. Needs R1 to R3.

### U1 Database and image
Builder: a general-purpose subagent on Sonnet, with ecc:docker-patterns and ecc:postgres-patterns. Reviewers: ecc:typescript-reviewer and ecc:database-reviewer. Depends on nothing; wave 1.
Files: `db/init.sql`, `compose.yaml` (Postgres only for now), `Dockerfile`, `package.json`, `package-lock.json`, `test/pg.ts`, `test/db.test.ts`, docs/decisions.md.
- `db/init.sql`: the `events` table and `events_pending` index exactly as in architecture.md.
- `compose.yaml`: Postgres from `postgres:16.16-alpine`, host networking, `postgres -p 54329 -c listen_addresses=127.0.0.1 -c timezone=UTC`, password in the file, health check `pg_isready -h 127.0.0.1 -p 54329`, named volume `pgdata`, `./db` mounted read-only on `/docker-entrypoint-initdb.d`, `restart: unless-stopped`, `init: true`.
- `Dockerfile`: `node:24.22.3-alpine3.24`, `npm ci --omit=dev`, copies `package.json`, `package-lock.json` and `src/`; each service gives its own exec-form command.
- `package.json`: `pg` as the one runtime dependency and `@types/pg` as a dev dependency, both exact. The TypeScript and pinned-builds entries in decisions.md name `@types/pg`.
- `test/pg.ts` exports `freshDb(name: string): Promise<pg.Pool>`, which drops and recreates database `name` on 127.0.0.1:54329, runs `db/init.sql` in it, and returns a pool on it.

Done when:
- `docker compose up -d postgres` turns healthy
- `\d events` in psql shows the contract's columns and `events_pending`
- `show timezone` prints UTC
- a row survives `docker compose down` and `up`
- `node --test test/db.test.ts` shows `freshDb` gives an empty `events` table, twice in a row

### U2 Intake validation
Builder: ecc:tdd-guide on Sonnet. Reviewer: ecc:typescript-reviewer. Depends on nothing; wave 1.
Files: `src/intake.ts` (`validate` only), `test/intake.test.ts`. No database.
Interface: `validate(body: Buffer): Valid | Invalid`, where `Valid` is `{ ok: true; event_id: string; user_id: string; created_at: string }` with created_at already cut to 6 decimals, and `Invalid` is `{ ok: false; status: 400 | 413; reason: string }`.

Done when `node --test test/intake.test.ts` passes a table of cases:
- broken JSON
- a JSON array
- each field missing, empty or not a string
- created_at with `Z`, with `+05:30` and with no zone
- 7 decimals cut to 6 with a log line
- 1 MB plus one byte giving 413

### U3 Intake API
Builder: ecc:tdd-guide on Opus. Reviewer: ecc:typescript-reviewer. Depends on U1, U2 and R4; wave 2.
Files: `src/db.ts`, `insert` in `src/intake.ts`, `src/api.ts`, `test/api.test.ts`, the `api` service in `compose.yaml`.
Interfaces:
- `src/db.ts`: `createPool(max: number): pg.Pool` on 127.0.0.1:54329 with an `error` handler, and `waitForDb(pool: pg.Pool): Promise<void>`, which retries until Postgres answers.
- `insert(pool: pg.Pool, body: Buffer, fields: Valid): Promise<200 | 400 | 503>` in `src/intake.ts`.
- `createApi(pool: pg.Pool): http.Server` in `src/api.ts`. Run directly, it listens on `:8080` with a pool of 30.

Done when `node --test test/api.test.ts`, on its own `freshDb` database, shows:
- the row is committed before the 200
- two concurrent posts of one event_id give one row and two 200s
- a different body keeps the first and is logged
- month 13 gives 400
- another path gives 404
- a pool on a dead port gives 503; after `pg_terminate_backend` ends the API's connections, the next post gives 200. The shared Postgres is never stopped.
- `keepAliveTimeout` is 65000
- SIGTERM stops new posts and lets an insert in progress commit and answer

Then `SCENARIO=healthy` passes `intake_up`, which goes into the baseline.

### U4 Send (this session, test-first)
Builder: this session, with superpowers:test-driven-development. Reviewers: ecc:typescript-reviewer and ecc:silent-failure-hunter. Depends on nothing; wave 1.
Files: `src/send.ts`, `test/send.test.ts`, against an in-process test server.
Interface: `post(agent: http.Agent, url: string, body: Buffer, ids: Ids): Promise<SendResult>`, where `SendResult` is `{ kind: 'saved' } | { kind: 'pause'; seconds: number } | { kind: 'retry'; why: string }` and `Ids` is `{ event_id: string; user_id: string }`, used only to tie log lines to the event.

Done when `node --test test/send.test.ts` shows:
- a 200 with a cut body is saved
- 500, 302 and 404 are retry
- 429 is a pause with `Retry-After` 7, 0, missing or `abc` giving 7, 1, 1 and 1
- a refused connect is retry
- a reset after the request is retry
- a 3-second answer on a reused keep-alive socket is waited for and saved
- every response is drained, so the socket is reused

### U5 SQL (this session, test-first)
Builder: this session, with superpowers:test-driven-development. Reviewers: ecc:typescript-reviewer and ecc:database-reviewer. Depends on U1; wave 2.
Files: `src/sql.ts`, `test/sql.test.ts`, on its own `freshDb` database.
Interfaces:
- `readyUsers(pool: pg.Pool, excluded: readonly string[], limit: number): Promise<string[]>`
- `oldestUnsent(pool: pg.Pool, userId: string, lastDelivered: string | null): Promise<Pending | null>`, where `Pending` is `{ event_id: string; body: Buffer; created_at: string; late: boolean }`, and null means none is left or the oldest is still held. `created_at` is opaque text the worker keeps per user and passes back as `lastDelivered`; `late` is true when the event was created before it, compared in SQL.
- `markDelivered(pool: pg.Pool, eventId: string): Promise<boolean>`, false when the row was already marked or is missing
- `unsentCount(pool: pg.Pool): Promise<number>`

Done when `node --test test/sql.test.ts` shows:
- a user whose oldest event is held is not returned, even with a ready second event
- excluded users are left out before the limit
- the longest-waiting user comes first
- mixed-zone created_at orders by true time
- `oldestUnsent` flags an event that arrived after a later one was delivered
- `markDelivered` sets one row
- `EXPLAIN` shows an index-only scan on `events_pending`

### U6 Worker (this session, test-first)
Builder: this session, with superpowers:test-driven-development. Reviewers: ecc:typescript-reviewer and ecc:silent-failure-hunter. Depends on U3 (`src/db.ts`), U4, U5 and R4; wave 3.
Files: `src/worker.ts`, `test/worker.test.ts`, the `worker` service in `compose.yaml`.
Interfaces:
- `nextWait(failures: number): number`, a pure function
- `startWorker(deps: WorkerDeps): { stop(): Promise<void> }`, where `WorkerDeps` holds the four U5 queries bound to a pool, `send` bound to an agent and the endpoint URL, and `log`, so tests pass fakes
- Run directly, the worker uses a pool of 20, `http://localhost:9000/events` and one `new http.Agent({ keepAlive: true })`.

Done when `node --test test/worker.test.ts`, with fake send and SQL, shows:
- a user that two polls both return still has one loop
- a poll starts only after the last one finished
- retry waits run 20, 40 and so on up to 5000 ms, and reset after a success
- a 429 ends the loop and pauses the user for max(1, Retry-After) seconds
- a failed `delivered_at` write is retried and never resends
- `markDelivered` returning false is logged and the loop moves on, never retried
- a thrown error counts as a failed attempt
- SIGTERM lets the send in flight and its write finish
- a user's next send starts only after the previous `delivered_at` commit
- a send in flight over 60 s logs a warning with its event_id, and the startup log gives the unsent count

Then healthy, fail, slow, limit-user, limit-all and input pass all five checks, and go into the baseline.

### U7 Outage, slots and flap at full load
Builder: this session; no new relay code is expected. Reviewer: ecc:typescript-reviewer, on any `.ts` the unit changes. Depends on U6; wave 4.
Done when down-5min, slots and flap, at 100 a second with a 30% heavy user, pass all five checks and go into the baseline, and the commit records every figure in the capacity section next to its expected value. A figure worse than expected goes back to its decision first.

### U8 Restarts and kills
Builder: a general-purpose subagent on Opus, with ecc:docker-patterns. Reviewer: ecc:typescript-reviewer. Depends on U6; wave 5, after U7.
Files: `rig/chaos.ts`, `rig/chaos.test.ts`, `rig/types.ts` (a scenario field `relay: [{ at_s, action: 'restart' | 'kill', service: 'api' | 'worker' | 'postgres' }]`), `rig/compose.yaml` (a `chaos` service with the Docker socket mounted, test code only), `rig/Dockerfile` (the Docker CLI), `rig/scenarios/restart.json` and `rig/scenarios/kill.json`. The chaos service writes `relay_stopped` and `relay_running` lines to `modes.ndjson`.
Done when the restart scenario passes all five checks while the worker, the API and Postgres each get SIGTERM and restart mid-run. The kill scenario (`docker kill` on the worker) is reported but does not block the unit: any duplicates must match the sends in flight at the kill, as the worker's log shows. SIGTERM while Postgres is down is reported the same way.

### U9 Linux fresh clone
Builder: this session, with the author, who decides whether the repo goes on GitHub for an Actions Ubuntu runner. Reviewer: ecc:typescript-reviewer, on any `.ts` the unit changes. Depends on U7 and U8; wave 6.
Done when, on Linux with plain Docker Engine:
- `git clone` and `docker compose up -d` run cleanly
- three full scenario runs pass every baseline check
- the 127.0.0.1-bound endpoint case passes
- the capacity figures are recorded next to their expected values

The README gets the commands and their output.

### U10 Handover
Builder: this session. Reviewer: ecc:typescript-reviewer, over the final tree. Depends on U9; wave 7.
Done when:
- every chat session is exported unedited under `docs/chat/`
- a fresh clone of the final commit shows the README opening with its assumptions
- the tags are pushed with the branch
