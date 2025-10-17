-- 001_users.sql (Plano A: com CITEXT)
CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION public.tg_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TABLE IF NOT EXISTS public.users (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  email           CITEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('admin','gestor','operador')),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_users_updated_at ON public.users;
CREATE TRIGGER set_users_updated_at
BEFORE UPDATE ON public.users
FOR EACH ROW EXECUTE PROCEDURE public.tg_set_updated_at();

CREATE INDEX IF NOT EXISTS users_role_idx   ON public.users (role);
CREATE INDEX IF NOT EXISTS users_active_idx ON public.users (is_active);
