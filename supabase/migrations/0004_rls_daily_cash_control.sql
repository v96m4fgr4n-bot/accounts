-- Phase 1 RLS: tenant isolation for cash_days, sales, purchases, expenses.
-- Same pattern as 0002 — force RLS, gate by is_tenant_member(tenant_id).
--
-- Raw logs are insert + select only from the client app. There is no
-- update/delete policy on sales/purchases/expenses at all: once logged,
-- a transaction is corrected the same way a posted journal is (CLAUDE.md
-- non-negotiable #6) — by a reversing entry, which arrives with the GL
-- engine in Phase 2. Missing policy = denied, same convention as 0002.

alter table cash_days  enable row level security;
alter table sales      enable row level security;
alter table purchases  enable row level security;
alter table expenses   enable row level security;

alter table cash_days  force row level security;
alter table sales      force row level security;
alter table purchases  force row level security;
alter table expenses   force row level security;

create policy cash_days_select_members
  on cash_days for select
  to authenticated
  using (public.is_tenant_member(tenant_id));

create policy cash_days_insert_members
  on cash_days for insert
  to authenticated
  with check (public.is_tenant_member(tenant_id) and opened_by = auth.uid());

-- Update is needed to record the end-of-day count on an already-open
-- day; the cash_days_guard_closed trigger (0003) is what actually stops
-- edits to a closed day or to the immutable opening fields, so this
-- policy only re-checks tenant membership, not day status.
create policy cash_days_update_members
  on cash_days for update
  to authenticated
  using (public.is_tenant_member(tenant_id))
  with check (public.is_tenant_member(tenant_id));

create policy sales_select_members
  on sales for select
  to authenticated
  using (public.is_tenant_member(tenant_id));

create policy sales_insert_members
  on sales for insert
  to authenticated
  with check (public.is_tenant_member(tenant_id) and recorded_by = auth.uid());

create policy purchases_select_members
  on purchases for select
  to authenticated
  using (public.is_tenant_member(tenant_id));

create policy purchases_insert_members
  on purchases for insert
  to authenticated
  with check (public.is_tenant_member(tenant_id) and recorded_by = auth.uid());

create policy expenses_select_members
  on expenses for select
  to authenticated
  using (public.is_tenant_member(tenant_id));

create policy expenses_insert_members
  on expenses for insert
  to authenticated
  with check (public.is_tenant_member(tenant_id) and recorded_by = auth.uid());
