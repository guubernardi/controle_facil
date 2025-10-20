-- server/sql/001_return_messages.sql
CREATE TABLE IF NOT EXISTS public.return_messages (
  id           BIGSERIAL PRIMARY KEY,
  return_id    INTEGER NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('in','out')) DEFAULT 'out',
  body         TEXT NOT NULL,
  sender_name  TEXT,
  sender_role  TEXT,
  created_by   INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_return_messages_return_id
  ON public.return_messages (return_id, created_at, id);
