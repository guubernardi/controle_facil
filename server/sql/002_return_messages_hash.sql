-- server/sql/002_return_messages_hash.sql
ALTER TABLE public.return_messages
  ADD COLUMN IF NOT EXISTS message_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_return_messages_hash
  ON public.return_messages (message_hash);
