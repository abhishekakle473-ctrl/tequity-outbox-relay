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

Parallel with R2, R3, U1, U2 and U4.

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
Builds `db/init.sql`, `compose.yaml` (Postgres first), `Dockerfile`, `package.json` and `package-lock.json`.
Done when:
- `docker compose up -d postgres` turns healthy
- `\d events` in psql shows the contract's columns and `events_pending`
- `show timezone` prints UTC
- a row survives `docker compose down` and `up`

Parallel with the rig units.

### U2 Intake validation
Builds `validate` in `src/intake.ts` and `test/intake.test.ts`, with no database.
Done when `node --test test/intake.test.ts` passes a table of cases:
- broken JSON
- a JSON array
- each field missing, empty or not a string
- created_at with `Z`, with `+05:30` and with no zone
- 7 decimals cut to 6 with a log line
- 1 MB plus one byte giving 413

Parallel with everything.

### U3 Intake API
Builds `src/db.ts`, `insert` in `src/intake.ts`, `src/api.ts`, `test/api.test.ts` and the api service.
Done when `node --test test/api.test.ts` against the compose Postgres shows:
- the row is committed before the 200
- two concurrent posts of one event_id give one row and two 200s
- a different body keeps the first and is logged
- month 13 gives 400
- another path gives 404
- stopping Postgres gives 503, and a post after restart gives 200
- `keepAliveTimeout` is 65000

Then `SCENARIO=healthy` passes `intake_up`, which goes into the baseline. Needs U1, U2 and R4.

### U4 Send
Builds `src/send.ts` and `test/send.test.ts`, against an in-process test server.
Done when `node --test test/send.test.ts` shows:
- a 200 with a cut body is saved
- 500, 302 and 404 are retry
- 429 is a pause with `Retry-After` 7, 0, missing or `abc` giving 7, 1, 1 and 1
- a refused connect is retry
- a reset after the request is retry
- a 3-second answer on a reused keep-alive socket is waited for and saved
- every response is drained, so the socket is reused

Parallel with everything.

### U5 SQL
Builds `src/sql.ts` and `test/sql.test.ts`, against the compose Postgres.
Done when `node --test test/sql.test.ts` shows:
- a user whose oldest event is held is not returned, even with a ready second event
- excluded users are left out before the limit
- the longest-waiting user comes first
- mixed-zone created_at orders by true time
- `oldestUnsent` flags an event that arrived after a later one was delivered
- `markDelivered` sets one row
- `EXPLAIN` shows an index-only scan on `events_pending`

Needs U1.

### U6 Worker
Builds `src/worker.ts`, `test/worker.test.ts` and the worker service.
Done when `node --test test/worker.test.ts`, with fake send and SQL, shows:
- a user that two polls both return still has one loop
- a poll starts only after the last one finished
- retry waits run 20, 40 and so on up to 5000 ms, and reset after a success
- a 429 ends the loop and pauses the user for max(1, Retry-After) seconds
- a failed `delivered_at` write is retried and never resends
- a thrown error counts as a failed attempt
- SIGTERM lets the send in flight and its write finish

Then healthy, fail, slow, limit-user, limit-all and input pass all five checks, and go into the baseline. Needs U3, U4, U5 and R4.

### U7 Outage, slots and flap at full load
Done when down-5min, slots and flap, at 100 a second with a 30% heavy user, pass all five checks, and the commit records every figure in the capacity section next to its expected value.

Parallel with U8. Needs U6.

### U8 Restarts and kills
Done when the restart scenario passes all five checks while the worker, the API and Postgres each get SIGTERM and restart mid-run. The kill scenario (`docker kill` on the worker) is reported but does not block the unit: any duplicates must match the sends in flight at the kill, as the worker's log shows.

Parallel with U7. Needs U6.

### U9 Linux fresh clone
Done when, on Linux with plain Docker Engine (a GitHub Actions Ubuntu runner if the author puts the repo on GitHub):
- `git clone` and `docker compose up -d` run cleanly
- three full scenario runs pass every baseline check
- the 127.0.0.1-bound endpoint case passes
- the capacity figures are recorded next to their expected values

The README gets the commands and their output. Needs U7 and U8.

### U10 Handover
Done when:
- every chat session is exported unedited under `docs/chat/`
- a fresh clone of the final commit shows the README opening with its assumptions
- the tags are pushed with the branch

Needs U9.
