# Outbox relay

## Assumptions

- Tequity's endpoint runs on the grading machine itself at localhost:9000, and their load generator posts to localhost:8080 on that same machine. Our API and worker run with host networking (`network_mode: host`), so localhost inside our containers is the machine's own localhost, whatever address their endpoint listens on.
- Port 54329 on the grading machine is free. Postgres runs with host networking on that port, listening on 127.0.0.1 only, so it cannot clash with a Postgres already using the default port 5432 and cannot be reached from other machines.

## What this is

Tequity's take-home. An intake API on port 8080 stores each event in Postgres before it answers, and a worker passes the stored events on to Tequity's endpoint on port 9000, once each and in `created_at` order per user. docs/problem.md states the problem in full, and docs/decisions.md gives the reason for every choice.
