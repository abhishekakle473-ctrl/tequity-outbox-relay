# How we work on the outbox relay

This repo is a take-home for Tequity. The brief is Tequity-take-home-Outbox-relay.pdf in the repo root, and nobody ever edits it. It asks for an intake API on port 8080 that stores each event in Postgres before answering, and workers that pass every stored event on to Tequity's endpoint on port 9000, exactly once and in created_at order per user, while that endpoint fails, rate limits, slows down or goes away. The graders clone the repo onto a clean Linux machine and run `docker compose up`. They install nothing else and change nothing.

Every session starts by reading docs/problem.md, the problem statement all design work traces back to.

The full AI chat history goes to Tequity unedited, along with the git history. Write every chat reply and every commit knowing they will see it.

## Design comes first

No product code (the intake API and the workers) gets written until the design is agreed. The test rig (a fake endpoint on 9000, a checker and a load generator) is test code, and it can be built once its own behaviour is agreed.

## Every decision is written down when it is made

When we settle an assumption or a design choice, the same commit adds it to the assumptions list at the top of README.md and adds a dated entry to docs/decisions.md saying what was decided and why. One decision per commit. The commit message states the decision, for example "Hold a user's later events while an earlier one has an unknown outcome". A message like "Update README and decisions.md" is never acceptable.

## Postgres is the only state

All state lives in Postgres: no Redis, Kafka or other queue, no files on disk, and nothing in process memory that has to survive a restart.

## Working means a test run showed it

Nothing counts as working until a test run shows it. Any claim that something works, in a commit, the README or a chat reply, names the command that was run and what it printed.

## Small

Keep the code as small as the problem allows. No layers, options, config or libraries the brief does not call for.

## Writing

Everything written here follows the anti-ai writing rules: plain words, short sentences, no filler. Chat replies use bullets. Documents in the repo use prose, with one exception: the README opens with its assumptions as a list, because the brief asks for one.
