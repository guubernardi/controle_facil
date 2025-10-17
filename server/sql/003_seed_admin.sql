-- 003_seed_admin.sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO public.users (name, email, password_hash, role, is_active)
SELECT
  'Administrador',
  'admin@retornofacil.local',
  crypt('Trocar123!', gen_salt('bf', 12)),
  'admin',
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM public.users WHERE lower(email)=lower('admin@retornofacil.local')
);
