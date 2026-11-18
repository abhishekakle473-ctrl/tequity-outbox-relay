# Outbox relay

## Assumptions

- Tequity's endpoint runs on the grading machine itself at localhost:9000, and their load generator posts to localhost:8080 on that same machine.
- The grading machine runs plain Docker Engine as root, the normal install. Rootless Docker and Docker Desktop keep host networking inside their own namespace or VM, where our containers would not reach the machine's localhost.
- Ports 8080 and 54329 are free on the grading machine.
- Tequity starts sending once `docker compose up` shows our services running.
- When healthy, the endpoint answers in about 10 ms or less, with 500s on at most a few percent of requests, and during recovery it does not rate limit us below about 200 events a second. The design is sized for that with the heaviest user sending 30 of the 100 events a second; the 30 is our guess, since the brief says only that a few users send far more than the rest. A user sending 50 a second would need answers in about 4 ms. The test rig measures the endpoint's answer time.
- After the endpoint recovers, a heavy user's new events queue behind its backlog, in order, and can wait close to 5 minutes. We read the brief's 5-minute rule as covering every event held up by the outage, and its 30-second rule as applying again once that user's backlog is clear.
- A user's events reach us out of created_at order by at most about 1 second. An earlier event that comes later than that, after the user's later events went out, is still sent, late and out of order.
- created_at has at most 6 decimal places of seconds, and one without a time zone is in UTC.
- "The same body" in the brief means the same bytes.
- A post that repeats an event_id is a resend of the same event, even if its body differs, and the first body stands.
- A valid event is a JSON object under 1 MB with a non-empty event_id, user_id and created_at. Anything else gets a 400.
- Our promise starts with our 2xx. A post we refused, during startup or with a 503 while Postgres restarts, carries none; if Tequity resends it after that user's later events went out, it arrives out of order.
- Any 2xx from the endpoint means saved, and any other status means not saved.
- A slow answer always comes in the end. The brief's table has no endpoint that never answers.
- A connection lost after our request went out, before a status line came back, is the brief's "No connection: We are down. Not saved." A 200 status line means saved even if the rest of the answer is cut off.
- Retry-After is a whole number of seconds. A missing or zero value, or one that is not a whole number, counts as 1 second.
- The brief does not say whether a 429's limit is per user or covers the whole endpoint, so the design has to work under both.

## What this is

Tequity's take-home. An intake API on port 8080 stores each event in Postgres before it answers, and a worker passes the stored events on to Tequity's endpoint on port 9000, once each and in `created_at` order per user. The list above holds only assumptions about Tequity's side. docs/problem.md states the problem in full, and docs/decisions.md holds every design choice and its reason.
