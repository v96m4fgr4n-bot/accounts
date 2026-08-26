-- Phase 7: Console back-office — cross-client views, approvals
-- (Blueprint §16 Approval Matrix; CLAUDE.md's console scope: "GL/journal
-- review, stock count sign-off... approval-threshold config per client").
--
-- §16 is explicit that a solo owner's own review IS the control at
-- small-team size ("owner reviews the daily cash sheet"), and that
-- thresholds/approver-count are "a living document" revisited as a
-- client grows staff. That rules out a blocking pre-approval gate on
-- every transaction — non-negotiable #1 already requires every action
-- to post its real journal immediately, no exceptions, and a small-team
-- client has no one to wait on anyway. What's built here instead: a
-- per-tenant, per-decision-type dollar threshold a consultant can set
-- (or leave unset — no configured threshold means no flag, by design,
-- so an unconfigured tenant sees zero friction); crossing it flags the
-- transaction for retrospective review, exactly matching "owner reviews
-- the daily cash sheet" — review-after-posting, not approval-before.
--
-- Scoped to the three approval-matrix rows with a real threshold shape
-- today: credit purchases, supplier payments, casual labour. Cash
-- purchases already get their control from the daily cash sheet itself
-- (§16's own row says so); tax filing/registration already has its own
-- status workflow via compliance_items (Phase 5); stock adjustment's
-- control is the counting process, not a dollar amount (§6.4/§16: "two
-- independent counters, owner approves") — handled below as
-- unconditional sign-off, not threshold-gated.

create table approval_thresholds (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete restrict,
  decision_type    text not null check (decision_type in ('credit_purchase', 'supplier_payment', 'casual_labour')),
  currency         currency_code not null,
  threshold_amount numeric(14, 2) not null check (threshold_amount > 0),
  updated_by       uuid not null references auth.users(id),
  updated_at       timestamptz not null default now(),

  unique (tenant_id, decision_type, currency)
);

-- Mutable by design, unlike tax_settings/period_closes — a threshold is
-- current-state config the consultant revises as the client grows
-- staff (§16: "revisit thresholds... as the business formalizes"), not
-- an audit-trail figure that needs to show what applied historically.
create or replace function public.approval_thresholds_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

create trigger approval_thresholds_touch_updated_at
  before update on approval_thresholds
  for each row execute function public.approval_thresholds_touch_updated_at();

alter table approval_thresholds enable row level security;
alter table approval_thresholds force row level security;

create policy approval_thresholds_select_members on approval_thresholds for select
  to authenticated using (public.is_tenant_member(tenant_id));

create policy approval_thresholds_insert_consultants on approval_thresholds for insert
  to authenticated with check (
    updated_by = auth.uid()
    and exists (select 1 from tenant_memberships where tenant_id = approval_thresholds.tenant_id and user_id = auth.uid() and role = 'consultant')
  );

create policy approval_thresholds_update_consultants on approval_thresholds for update
  to authenticated
  using (exists (select 1 from tenant_memberships where tenant_id = approval_thresholds.tenant_id and user_id = auth.uid() and role = 'consultant'))
  with check (exists (select 1 from tenant_memberships where tenant_id = approval_thresholds.tenant_id and user_id = auth.uid() and role = 'consultant'));

-- Flagging + sign-off columns. needs_approval is set once at insert time
-- (a fact about what applied then) and never changed afterward;
-- approved_by/approved_at record the separate, later act of a
-- consultant reviewing it — keeping both means the record shows both
-- "this crossed the threshold" and "here's who cleared it," rather than
-- collapsing to a single flag that loses the first fact once cleared.

alter table purchases add column needs_approval boolean not null default false;
alter table purchases add column approved_by uuid references auth.users(id);
alter table purchases add column approved_at timestamptz;
alter table purchases add constraint purchases_approval_pair check ((approved_by is null) = (approved_at is null));

alter table supplier_payments add column needs_approval boolean not null default false;
alter table supplier_payments add column approved_by uuid references auth.users(id);
alter table supplier_payments add column approved_at timestamptz;
alter table supplier_payments add constraint supplier_payments_approval_pair check ((approved_by is null) = (approved_at is null));

alter table casual_labour_payments add column needs_approval boolean not null default false;
alter table casual_labour_payments add column approved_by uuid references auth.users(id);
alter table casual_labour_payments add column approved_at timestamptz;
alter table casual_labour_payments add constraint casual_labour_payments_approval_pair check ((approved_by is null) = (approved_at is null));

create or replace function public.purchases_flag_approval()
returns trigger
language plpgsql
as $$
declare
  v_threshold numeric;
begin
  if new.payment_method = 'credit' then
    select threshold_amount into v_threshold
      from approval_thresholds
     where tenant_id = new.tenant_id and decision_type = 'credit_purchase' and currency = new.currency;
    if v_threshold is not null and new.amount > v_threshold then
      new.needs_approval := true;
    end if;
  end if;
  return new;
end;
$$;

create trigger purchases_flag_approval
  before insert on purchases
  for each row execute function public.purchases_flag_approval();

create or replace function public.supplier_payments_flag_approval()
returns trigger
language plpgsql
as $$
declare
  v_threshold numeric;
begin
  select threshold_amount into v_threshold
    from approval_thresholds
   where tenant_id = new.tenant_id and decision_type = 'supplier_payment' and currency = new.currency;
  if v_threshold is not null and new.amount > v_threshold then
    new.needs_approval := true;
  end if;
  return new;
end;
$$;

create trigger supplier_payments_flag_approval
  before insert on supplier_payments
  for each row execute function public.supplier_payments_flag_approval();

create or replace function public.casual_labour_payments_flag_approval()
returns trigger
language plpgsql
as $$
declare
  v_threshold numeric;
begin
  select threshold_amount into v_threshold
    from approval_thresholds
   where tenant_id = new.tenant_id and decision_type = 'casual_labour' and currency = new.currency;
  if v_threshold is not null and new.amount > v_threshold then
    new.needs_approval := true;
  end if;
  return new;
end;
$$;

create trigger casual_labour_payments_flag_approval
  before insert on casual_labour_payments
  for each row execute function public.casual_labour_payments_flag_approval();

-- Sign-off is a narrow UPDATE, the same column-level-grant shape used
-- for tenants.vat_registered/formalization_stage in Phase 5: 0010's
-- blanket authenticated UPDATE grant is revoked for these three tables
-- and re-granted on exactly (approved_by, approved_at) — a consultant
-- can clear a flagged transaction but still can't edit its amount,
-- description, or anything else after the fact (that's what the
-- raw-log immutability everywhere else already protects).

revoke update on purchases from authenticated;
grant update (approved_by, approved_at) on purchases to authenticated;

create policy purchases_approve_consultants on purchases for update
  to authenticated
  using (public.is_tenant_member(tenant_id))
  with check (
    approved_by = auth.uid()
    and exists (select 1 from tenant_memberships where tenant_id = purchases.tenant_id and user_id = auth.uid() and role = 'consultant')
  );

revoke update on supplier_payments from authenticated;
grant update (approved_by, approved_at) on supplier_payments to authenticated;

create policy supplier_payments_approve_consultants on supplier_payments for update
  to authenticated
  using (public.is_tenant_member(tenant_id))
  with check (
    approved_by = auth.uid()
    and exists (select 1 from tenant_memberships where tenant_id = supplier_payments.tenant_id and user_id = auth.uid() and role = 'consultant')
  );

revoke update on casual_labour_payments from authenticated;
grant update (approved_by, approved_at) on casual_labour_payments to authenticated;

create policy casual_labour_payments_approve_consultants on casual_labour_payments for update
  to authenticated
  using (public.is_tenant_member(tenant_id))
  with check (
    approved_by = auth.uid()
    and exists (select 1 from tenant_memberships where tenant_id = casual_labour_payments.tenant_id and user_id = auth.uid() and role = 'consultant')
  );

-- §6.4/§16 stock count sign-off: unconditional (every count is
-- sign-off-able, not threshold-gated — the control here is the review
-- itself, not a dollar amount). Same column-level-grant shape.
alter table stock_counts add column signed_off_by uuid references auth.users(id);
alter table stock_counts add column signed_off_at timestamptz;
alter table stock_counts add constraint stock_counts_signoff_pair check ((signed_off_by is null) = (signed_off_at is null));

revoke update on stock_counts from authenticated;
grant update (signed_off_by, signed_off_at) on stock_counts to authenticated;

create policy stock_counts_signoff_consultants on stock_counts for update
  to authenticated
  using (public.is_tenant_member(tenant_id))
  with check (
    signed_off_by = auth.uid()
    and exists (select 1 from tenant_memberships where tenant_id = stock_counts.tenant_id and user_id = auth.uid() and role = 'consultant')
  );
