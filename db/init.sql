CREATE TABLE events (
  event_id     text PRIMARY KEY,
  user_id      text NOT NULL,
  created_at   timestamptz NOT NULL,
  body         bytea NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  seq          bigint GENERATED ALWAYS AS IDENTITY,
  delivered_at timestamptz
);

CREATE INDEX events_pending ON events (user_id, created_at, seq) INCLUDE (received_at) WHERE delivered_at IS NULL;
