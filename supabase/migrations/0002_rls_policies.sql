-- Phase 0: RLS policies for tenants + memberships.
--
-- CLAUDE.md non-negotiable #2: isolation is enforced at the DB, not in
-- app code. Every tenant-scoped table added later must follow the same
-- pattern (enable RLS, add a policy that gates by `is_tenant_member`).

alter table tenants             enable row level security;
alter table tenant_memberships  enable row level security;

-- Force RLS even for the table owner, so a stray superuser-context query
-- from an app path can't bypass it. Service-role keys still bypass RLS
-- (that's how seeds/admin flows work) — see supabase.com/docs on the
-- `service_role` bypass.
alter table tenants             force row level security;
alter table tenant_memberships  force row level security;

-- tenants: a signed-in user can read a tenant iff they are a member of it.
create policy tenants_select_members
  on tenants
  for select
  to authenticated
  using (public.is_tenant_member(id));

-- No client-side insert/update/delete on tenants at this phase.
-- Tenant lifecycle is a consultant-console action wired in Phase 7 (§16);
-- until then, tenant rows are created via the service role during
-- onboarding. Missing policies = deny.

-- tenant_memberships: a user can see only their own membership rows.
-- Cross-user membership visibility for consultants comes with the
-- console back-office in Phase 7.
create policy memberships_select_self
  on tenant_memberships
  for select
  to authenticated
  using (user_id = auth.uid());
