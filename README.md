# Outbox relay

## Assumptions

- Tequity's endpoint runs on the grading machine itself at localhost:9000, and their load generator posts to localhost:8080 on that same machine.
- The grading machine runs plain Docker Engine as root, the normal install, not rootless Docker or Docker Desktop.
- Ports 8080 and 54329 are free on the grading machine.
- Tequity may post as soon as `docker compose up` starts. A post refused before we are ready carries no promise, and if Tequity resends it after that user's later events went out, it may arrive out of order.
- When healthy, the endpoint answers in about 10 ms or less.
- When healthy, at most a few percent of the endpoint's answers are 500s, and 429s are rare.
- During recovery, the endpoint does not rate limit us below about 200 events a second.
- The heaviest user sends about 30 of the 100 events a second. The brief says only that a few users send far more than the rest.
- The brief's 5-minute rule covers every event held up by an outage, including a heavy user's new events that queue behind its backlog after recovery. Its 30-second rule applies again once that user's backlog is clear.
- A user's events reach us out of created_at order by at most about 1 second.
- created_at has at most 6 decimal places of seconds, and one without a time zone is in UTC.
- "The same body" in the brief means the same bytes.
- A post that repeats an event_id is a resend of the same event, even if its body differs.
- A valid event is a JSON object in UTF-8 under 1 MB, with a non-empty created_at and a non-empty event_id and user_id of at most 1,000 bytes each, with no NUL character.
- Any 2xx from the endpoint means saved, and any other status means not saved.
- A slow answer always comes in the end. The endpoint never holds a connection open without answering.
- A connection lost after our request went out, before a status line came back, is the brief's "No connection: We are down. Not saved." A 200 status line means saved even if the rest of the answer is cut off.
- Retry-After is a whole number of seconds.
- A 429's limit may be per user or cover the whole endpoint; the brief does not say which.

## What this is

Tequity's take-home. An intake API on port 8080 stores each event in Postgres before it answers, and a worker passes the stored events on to Tequity's endpoint on port 9000, once each and in `created_at` order per user. The list above holds only assumptions about Tequity's side. docs/problem.md states the problem in full, and docs/decisions.md holds every design choice and its reason.

## How to run and verify

Start the relay. Postgres listens on 127.0.0.1:54329, the intake API on port 8080, and the worker sends to localhost:9000. All containers use host networking.

```
docker compose up -d
```

Run one scenario against the fake Tequity endpoint, then stop the rig:

```
SCENARIO=healthy docker compose -f rig/compose.yaml run --rm check
docker compose -f rig/compose.yaml down
```

The scenario files are in rig/scenarios: healthy, fail, flap, slow, slots, input, limit-user, limit-all, down-5min, restart and kill. The check prints one pass or fail line per check, with detail: `exactly_once`, `order`, `timing`, `intake_up` and `bytes`. Together they cover the brief's four pass conditions and that a saved body is the promised body.

The unit tests need the relay's Postgres, so start the relay first. The type check needs no database.

```
docker run --rm --network host -v "$PWD:/app" -w /app node:24.22.3-alpine3.24 sh -c "npm ci && node --test"
docker run --rm -v "$PWD:/app" -w /app node:24.22.3-alpine3.24 sh -c "npm ci && npx tsc --noEmit"
```

The GitHub Actions workflow `.github/workflows/scenarios.yml` runs every scenario on ubuntu-latest on each push and uploads the rig logs.

## Results

The figures come from the workflow run named below.

| scenario | intake_up | exactly_once | order | timing | bytes | our time per event |
|---|---|---|---|---|---|---|
| healthy | TBD | TBD | TBD | TBD | TBD | TBD |
| fail | TBD | TBD | TBD | TBD | TBD | TBD |
| flap | TBD | TBD | TBD | TBD | TBD | TBD |
| slow | TBD | TBD | TBD | TBD | TBD | TBD |
| slots | TBD | TBD | TBD | TBD | TBD | TBD |
| input | TBD | TBD | TBD | TBD | TBD | TBD |
| limit-user | TBD | TBD | TBD | TBD | TBD | TBD |
| limit-all | TBD | TBD | TBD | TBD | TBD | TBD |
| down-5min | TBD | TBD | TBD | TBD | TBD | TBD |
| restart | TBD | TBD | TBD | TBD | TBD | TBD |
| kill | TBD | TBD | TBD | TBD | TBD | TBD |

Workflow run: TBD

## Reading the history

The git history has an annotated tag at the end of each phase. Each paragraph below says what that phase decided and what changed the design along the way. docs/decisions.md holds every decision as it stands now, and docs/review-2026-11-18.md holds the first review's findings.

01-problem keeps Tequity's brief exactly as sent (12365f6), sets the working rules (ea370e3) and states the problem with its four pass conditions before any design (27b73a5).

02-first-design settles every open point in docs/problem.md, one commit each. Our containers use host networking, so they reach Tequity's endpoint on the machine's own localhost (900044d). On Docker Desktop for Windows a host-network container cannot reach Windows' localhost at all, so the test rig moved into host-network containers (c3f4ee2). A 429 at first paused sending for every user (1663034).

03-first-review applies the findings of five reviewer agents. Postgres had no named data volume, so `docker compose down` and `up` would have lost stored events (2186cd0), and a 200 whose body was cut off would have been resent and saved twice (fef6dc0). Retry waits starting at 0.5 seconds broke the 5-minute maths, so retries now start at 20 ms and the design is sized for a 10 ms endpoint (7f4ccbb). The 1-second hold had no arrival time to measure from (1693e5e), and the 429 pause moved from every user to the one user who got it (31e7e87).

04-node replaces Go with Node.js, the author's own stack, and rewrites every Go detail in the docs (589fddc). Just before it, the README was cut to assumptions about Tequity's side (d63b22b), and `delivered_at` was set to commit before each next send, never alongside it (ddc6bcd).

05-second-review cuts decisions.md to the current decisions, at most 150 words each (f680d19), then applies a second review by two agents. It found that the 2-second connect timer, cleared on a `connect` event that a reused keep-alive socket never fires, would kill slow answers and resend them, so the timer is gone (2a46f30; 94d0e7c carries the same change under a wrong message).

