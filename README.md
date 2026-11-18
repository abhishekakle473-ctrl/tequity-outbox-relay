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
- A valid event is a JSON object under 1 MB with a non-empty event_id, user_id and created_at.
- Any 2xx from the endpoint means saved, and any other status means not saved.
- A slow answer always comes in the end. The endpoint never holds a connection open without answering.
- A connection lost after our request went out, before a status line came back, is the brief's "No connection: We are down. Not saved." A 200 status line means saved even if the rest of the answer is cut off.
- Retry-After is a whole number of seconds.
- A 429's limit may be per user or cover the whole endpoint; the brief does not say which.

## What this is

Tequity's take-home. An intake API on port 8080 stores each event in Postgres before it answers, and a worker passes the stored events on to Tequity's endpoint on port 9000, once each and in `created_at` order per user. The list above holds only assumptions about Tequity's side. docs/problem.md states the problem in full, and docs/decisions.md holds every design choice and its reason.
