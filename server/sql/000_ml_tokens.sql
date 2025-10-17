-- 000_ml_tokens.sql
CREATE TABLE IF NOT EXISTS public.ml_tokens (
  user_id     BIGINT PRIMARY KEY,
  nickname    TEXT,
  access_token  TEXT,
  refresh_token TEXT,
  scope       TEXT,
  token_type  TEXT,
  expires_at  TIMESTAMPTZ,
  raw         JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- reusa a mesma função tg_set_updated_at criada nas migrações anteriores
CREATE TRIGGER set_ml_tokens_updated_at
BEFORE UPDATE ON public.ml_tokens
FOR EACH ROW EXECUTE PROCEDURE public.tg_set_updated_at();
