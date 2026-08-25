-- Fix found by actually running the migrations against a real local
-- Supabase stack (not just `next build`/`vitest run` with everything
-- skipped): every prior migration assumed anon/authenticated/
-- service_role already had base SELECT/INSERT/UPDATE privileges on the
-- tables we created, the way a hosted Supabase project is commonly
-- configured. That assumption doesn't hold here — confirmed with
-- `\dp tenants`, which showed authenticated and service_role with
-- neither, so every query failed "permission denied for table tenants"
-- before RLS ever got a chance to run.
--
-- RLS policies decide *which rows* a role can touch; Postgres still
-- requires a base GRANT before a role can attempt the operation at all.
-- Rather than keep relying on unstated platform behavior, this migration
-- makes the grants explicit, and sets ALTER DEFAULT PRIVILEGES so tables
-- created by future migrations (run by this same role) pick them up
-- automatically without needing a GRANT line repeated in every file.
--
-- `anon` deliberately gets nothing: every RLS policy in this project is
-- `to authenticated` — a signed-out request has no business reading
-- tenant data, and granting anon table access would make that a policy
-- gap instead of a hard "no rows" from GRANT.
--
-- This does not weaken anything RLS-specific already designed:
--   - journal_entries/journal_lines/accounts have no INSERT/UPDATE
--     policy for authenticated (0005/0006) — granting the base INSERT/
--     UPDATE privilege here doesn't help authenticated without a
--     matching policy, which still doesn't exist.
--   - service_role already has the BYPASSRLS role attribute (confirmed
--     via pg_roles), so it bypasses RLS regardless of these grants —
--     immutability on journal_entries/journal_lines is enforced by the
--     journal_immutable() trigger (0006), which fires for every role
--     unconditionally, not by withholding a GRANT.

grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update on all tables in schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;

alter default privileges in schema public
  grant select, insert, update on tables to authenticated;
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;

grant usage, select on all sequences in schema public to authenticated, service_role;
alter default privileges in schema public
  grant usage, select on sequences to authenticated, service_role;
