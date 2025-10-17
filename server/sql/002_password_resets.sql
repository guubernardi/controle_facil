-- 002_password_resets.sql
CREATE TABLE IF NOT EXISTS public.password_resets (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash  CHAR(64) NOT NULL UNIQUE,      -- sha256 do token
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pr_user_idx    ON public.password_resets (user_id);
CREATE INDEX IF NOT EXISTS pr_expires_idx ON public.password_resets (expires_at);
