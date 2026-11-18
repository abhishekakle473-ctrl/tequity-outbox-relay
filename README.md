# Outbox relay

## Assumptions

- Tequity's endpoint runs on the grading machine itself at localhost:9000, and their load generator posts to localhost:8080 on that same machine. Our API and worker run with host networking (`network_mode: host`), so localhost inside our containers is the machine's own localhost, whatever address their endpoint listens on.
- Port 54329 on the grading machine is free. Postgres runs with host networking on that port, listening on 127.0.0.1 only, so it cannot clash with a Postgres already using the default port 5432 and cannot be reached from other machines.
- Our test rig (a fake endpoint on 9000, a load generator and a checker) runs as containers with host networking, never as programs on the developer's machine. On Docker Desktop for Windows, host-network containers and Windows cannot reach each other on localhost, while containers inside Docker Desktop's Linux VM can, the same way they do on a Linux machine.
- The relay and its test rig are written in Go. Postgres is version 16, with the image tag pinned.
- One worker process sends for every user, up to 200 users at a time. An event's `delivered_at` is the only record of progress: anything without it gets sent.
- When healthy, Tequity's endpoint answers in about 14 ms or less. Taking the heaviest user as 30 of the 100 events a second, that is the speed it needs to clear the backlog of a 5-minute outage within 5 minutes of recovery. If the endpoint rate limits us below 200 events a second during recovery, no design meets that.
- A user's events wait while that user's oldest unsent event, by created_at, arrived less than 1 second ago. A later event never goes out while an earlier one is still inside its hold. An earlier event that arrives after a later one was already sent still goes out, late, and is logged.
- created_at has at most 6 decimal places of seconds. It is stored as a Postgres timestamp, which keeps microseconds, and two events of one user that tie are sent in arrival order.
- "The same body" in the brief means the same bytes. Each body is stored as raw bytes and sent unchanged, with `Content-Type: application/json`.

## What this is

Tequity's take-home. An intake API on port 8080 stores each event in Postgres before it answers, and a worker passes the stored events on to Tequity's endpoint on port 9000, once each and in `created_at` order per user. docs/problem.md states the problem in full, and docs/decisions.md gives the reason for every choice.
