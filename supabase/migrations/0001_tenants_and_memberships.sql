-- Phase 0: tenant + membership schema (Blueprint §1, §16).
--
-- One row in `tenants` per client business. Every tenant-scoped table
-- added in later phases MUST carry `tenant_id` and reference this table,
-- because RLS (0002) is the actual security boundary — see CLAUDE.md
-- non-negotiable #2.

create extension if not exists "pgcrypto";

create type tenant_role as enum ('client_user', 'consultant');

create table tenants (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  -- Blueprint §1.2 formalization ladder. Kept as a check-constrained
  -- text (not an enum) so the consulting team can extend labels via
  -- migration without a type rewrite on live data.
  formalization_stage  text not null default 'unregistered'
    check (formalization_stage in ('unregistered', 'presumptive', 'registered')),
  created_at           timestamptz not null default now()
);

create table tenant_memberships (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        tenant_role not null,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index tenant_memberships_user_id_idx on tenant_memberships (user_id);

-- Membership check used by other tables' RLS policies. SECURITY DEFINER
-- so it can read `tenant_memberships` without needing a permissive
-- self-select policy to be visible from every checking context, and to
-- keep policies on tables that reference it from recursing back through
-- membership-table RLS.
create or replace function public.is_tenant_member(t uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from tenant_memberships
     where tenant_id = t
       and user_id   = auth.uid()
  );
$$;

revoke all on function public.is_tenant_member(uuid) from public;
grant execute on function public.is_tenant_member(uuid) to authenticated;
