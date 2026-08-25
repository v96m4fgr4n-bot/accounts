-- Phase 5: Compliance calendar + formalization stage (Blueprint §1.2, §12).
--
-- Deliberately NOT wired into sale posting in this migration: VAT Output
-- (§4.2/§12.2) now has a real vat_registered flag and could theoretically
-- be posted, but doing so changes existing Phase 2 sale-posting behavior
-- and needs a VAT-inclusive/exclusive amount decision + its own focused
-- review, not a side effect of the compliance-calendar build. Flagged in
-- docs/erp-blueprint.md as a deliberate follow-up, not an oversight.

-- §12.2: VAT registration is a separate fact from formalization_stage —
-- a "registered" tenant may be below the VAT threshold or not yet
-- opted in; an "unregistered" one shouldn't be able to be VAT-registered
-- at all. The check keeps that ordering honest without hardcoding the
-- actual threshold figure anywhere (non-negotiable #5).
alter table tenants add column vat_registered boolean not null default false;
alter table tenants add constraint tenants_vat_requires_formal
  check (not vat_registered or formalization_stage <> 'unregistered');

-- tenants has had no UPDATE policy at all since 0002 — tenant lifecycle
-- was deliberately left to a service-role-only path pending Phase 7's
-- console back-office. This flag needs a real UI path now, so rather
-- than opening the whole row (0010's blanket "GRANT UPDATE on all
-- tables" would otherwise let a consultant rename a tenant or rewrite
-- its formalization history freely), REVOKE that blanket grant for this
-- one table and re-grant UPDATE on exactly the two columns a compliance
-- workflow legitimately touches. name/id/created_at etc. stay
-- unreachable until Phase 7 defines that workflow properly.
revoke update on tenants from authenticated;
grant update (formalization_stage, vat_registered) on tenants to authenticated;

create policy tenants_update_consultants
  on tenants for update
  to authenticated
  using (public.is_tenant_member(id))
  with check (
    exists (
      select 1 from tenant_memberships
       where tenant_id = tenants.id and user_id = auth.uid() and role = 'consultant'
    )
  );

-- §1.2/§12.2 non-negotiable #5: tax/compliance figures are configurable
-- data with an effective-date, never hard-coded constants — "confirm
-- current figures with ZIMRA / a registered tax practitioner" per the
-- Blueprint, this table is where that confirmed figure gets recorded.
-- Global, not tenant-scoped: these are national rules the whole
-- consultancy operates under, not a per-client setting.
create table tax_settings (
  id             uuid primary key default gen_random_uuid(),
  -- e.g. 'vat_threshold_usd', 'presumptive_tax_flat_usd'. Free text, not
  -- an enum — new figures get tracked by adding rows with a new key, no
  -- schema change.
  setting_key    text not null,
  value          numeric not null,
  effective_from date not null,
  note           text,
  created_by     uuid not null references auth.users(id),
  created_at     timestamptz not null default now(),

  unique (setting_key, effective_from)
);

create index tax_settings_key_idx on tax_settings (setting_key, effective_from desc);

-- Immutable once recorded, same reasoning as journals (non-negotiable
-- #6): a figure that turns out to be wrong is corrected by adding the
-- right one with its own effective-date, not by editing history — a
-- filing already prepared under the old figure needs to still show what
-- was actually used at the time.
create trigger tax_settings_immutable
  before update or delete on tax_settings
  for each row execute function public.journal_immutable();

-- Forced (unlike accounts/journal_entries): every legitimate write here
-- goes through the direct RLS-gated INSERT policy below, not a
-- SECURITY DEFINER function that needs table-owner bypass — same
-- reasoning as Phase 0/1's tenant tables.
alter table tax_settings enable row level security;
alter table tax_settings force row level security;

create policy tax_settings_select_authenticated
  on tax_settings for select
  to authenticated
  using (true);

-- Not tenant-scoped, so "authorized" here means "a consultant somewhere
-- in the practice," not is_tenant_member — there is no single tenant to
-- check membership against.
create policy tax_settings_insert_consultants
  on tax_settings for insert
  to authenticated
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from tenant_memberships
       where user_id = auth.uid() and role = 'consultant'
    )
  );

-- Convenience accessor: the value in effect for a key as of a date
-- (defaults to today). Returns null if nothing's been recorded yet
-- rather than silently defaulting to a guessed figure.
create or replace function public.current_tax_setting(p_key text, p_as_of date default current_date)
returns numeric
language sql
stable
as $$
  select value from tax_settings
   where setting_key = p_key and effective_from <= p_as_of
   order by effective_from desc
   limit 1;
$$;

-- §12.3/§12.4: compliance calendar. Council licence renewals (§12.3)
-- share this table rather than getting their own — a licence renewal is
-- the same shape as a tax filing (a dated obligation with a status),
-- just a different obligation_type. Status is a real mutable workflow
-- (not_started -> prepared -> filed -> confirmed, §12.4's own wording),
-- unlike the append-only/immutable financial tables elsewhere — this is
-- task tracking, not a ledger entry, so ordinary UPDATE is the right
-- shape here.
create table compliance_items (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete restrict,
  obligation_type text not null check (obligation_type in (
                     'presumptive_tax', 'vat_return', 'paye_return',
                     'council_licence_renewal', 'other'
                   )),
  -- e.g. '2026-04' for a monthly filing period; free text since the
  -- period shape differs by obligation (monthly, quarterly, annual).
  period_label   text,
  due_date       date not null,
  status         text not null default 'not_started'
                   check (status in ('not_started', 'prepared', 'filed', 'confirmed')),
  note           text,
  created_by     uuid not null references auth.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index compliance_items_tenant_due_idx on compliance_items (tenant_id, due_date);

create or replace function public.compliance_items_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger compliance_items_touch_updated_at
  before update on compliance_items
  for each row execute function public.compliance_items_touch_updated_at();

alter table compliance_items enable row level security;
alter table compliance_items force row level security;

-- §16 approval matrix: "Tax filing/registration step | Owner or
-- consulting team, jointly" — unlike period_closes/reverse_journal
-- (which gate financial correction authority to a consultant), tracking
-- and progressing a compliance item is explicitly joint work, so any
-- tenant member (client_user or consultant) can create and update one.
create policy compliance_items_select_members
  on compliance_items for select
  to authenticated
  using (public.is_tenant_member(tenant_id));

create policy compliance_items_insert_members
  on compliance_items for insert
  to authenticated
  with check (public.is_tenant_member(tenant_id) and created_by = auth.uid());

create policy compliance_items_update_members
  on compliance_items for update
  to authenticated
  using (public.is_tenant_member(tenant_id))
  with check (public.is_tenant_member(tenant_id));

-- §12.5: penalties/interest, logged separately from ordinary expenses
-- "so the cause gets fixed rather than absorbed" — a raw cash-affecting
-- log like sales/purchases/expenses (Phase 1 shape: tied to a cash_day,
-- insert+select only, corrected by GL reversal once posted, not edited).
create table compliance_penalties (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete restrict,
  cash_day_id           uuid not null references cash_days(id) on delete restrict,
  -- Optional link to the obligation that caused it, so the compliance
  -- calendar and the penalty log can be cross-referenced; not required,
  -- since not every penalty traces back to a tracked item (e.g. a
  -- pre-existing one from before the calendar was in use).
  compliance_item_id    uuid references compliance_items(id),

  paid_at               timestamptz not null default now(),
  description            text not null,
  amount                numeric(14, 2) not null check (amount > 0),
  currency              currency_code not null,
  exchange_rate_to_usd  numeric(14, 6) check (exchange_rate_to_usd > 0),

  recorded_by           uuid not null references auth.users(id),
  created_at            timestamptz not null default now(),

  check (currency = 'USD' or exchange_rate_to_usd is not null)
);

create index compliance_penalties_cash_day_idx on compliance_penalties (cash_day_id);
create index compliance_penalties_tenant_paid_at_idx on compliance_penalties (tenant_id, paid_at desc);

alter table compliance_penalties enable row level security;
alter table compliance_penalties force row level security;

create policy compliance_penalties_select_members
  on compliance_penalties for select
  to authenticated
  using (public.is_tenant_member(tenant_id));

create policy compliance_penalties_insert_members
  on compliance_penalties for insert
  to authenticated
  with check (public.is_tenant_member(tenant_id) and recorded_by = auth.uid());

-- New GL account (same seed + backfill pattern as 0005/0007's
-- accounts_payable addition).
create or replace function public.seed_default_accounts()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into accounts (tenant_id, code, name, account_type) values
    (new.id, 'cash_usd',                    'Cash - USD',                     'asset'),
    (new.id, 'cash_zwg',                    'Cash - ZWG',                     'asset'),
    (new.id, 'inventory',                   'Inventory',                      'asset'),
    (new.id, 'trade_receivables',           'Trade Receivables',              'asset'),
    (new.id, 'accounts_payable',            'Accounts Payable',               'liability'),
    (new.id, 'revenue',                     'Revenue',                        'revenue'),
    (new.id, 'expense_rent',                'Rent Expense',                   'expense'),
    (new.id, 'expense_utilities',           'Utilities Expense',              'expense'),
    (new.id, 'expense_transport',           'Transport Expense',              'expense'),
    (new.id, 'expense_airtime_data',        'Airtime / Data Expense',         'expense'),
    (new.id, 'expense_repairs_maintenance', 'Repairs & Maintenance Expense',  'expense'),
    (new.id, 'expense_packaging',           'Packaging Expense',              'expense'),
    (new.id, 'expense_casual_labour',       'Casual Labour Expense',          'expense'),
    (new.id, 'expense_bank_charges',        'Bank / Mobile Money Charges',    'expense'),
    (new.id, 'expense_other',               'Other Expense',                  'expense'),
    (new.id, 'expense_penalties',           'Penalties & Interest Expense',   'expense');
  return new;
end;
$$;

insert into accounts (tenant_id, code, name, account_type)
select t.id, 'expense_penalties', 'Penalties & Interest Expense', 'expense'
from tenants t
on conflict (tenant_id, code) do nothing;

create or replace function public.post_penalty_journal(cp compliance_penalties)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.post_journal(
    cp.tenant_id, cp.paid_at::date, cp.currency, cp.description, 'penalty', cp.id,
    'expense_penalties',
    case cp.currency when 'USD' then 'cash_usd' else 'cash_zwg' end,
    cp.amount
  );
end;
$$;

revoke all on function public.post_penalty_journal(compliance_penalties) from public;

create or replace function public.compliance_penalties_post_journal_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.post_penalty_journal(new);
  return new;
end;
$$;

revoke all on function public.compliance_penalties_post_journal_trigger() from public;

create trigger compliance_penalties_post_journal
  after insert on compliance_penalties
  for each row execute function public.compliance_penalties_post_journal_trigger();

alter table journal_entries drop constraint journal_entries_source_type_check;
alter table journal_entries add constraint journal_entries_source_type_check
  check (source_type in (
    'sale', 'purchase', 'expense', 'customer_payment', 'supplier_payment',
    'penalty', 'reversal', 'manual'
  ));

-- Till-reconciliation: a penalty paid in cash is a real till outflow,
-- same reasoning as the customer/supplier-payment fix in Phase 3. DROP +
-- CREATE, not CREATE OR REPLACE — Postgres only allows REPLACE to append
-- new output columns at the end, not insert one ahead of existing ones
-- (penalties_total lands before expected_cash here); see 0008 for the
-- first time this was learned the hard way.
drop view cash_day_summary;

create view cash_day_summary
  with (security_invoker = true)
as
select
  d.id                                                    as cash_day_id,
  d.tenant_id,
  d.trade_date,
  d.currency,
  d.opening_float,
  coalesce(s.cash_sales, 0)                                as cash_sales,
  coalesce(cp.customer_payments_total, 0)                  as customer_payments_total,
  coalesce(p.purchases_total, 0)                           as purchases_total,
  coalesce(e.expenses_total, 0)                            as expenses_total,
  coalesce(sp.supplier_payments_total, 0)                  as supplier_payments_total,
  coalesce(pen.penalties_total, 0)                         as penalties_total,
  d.opening_float
    + coalesce(s.cash_sales, 0)
    + coalesce(cp.customer_payments_total, 0)
    - coalesce(p.purchases_total, 0)
    - coalesce(e.expenses_total, 0)
    - coalesce(sp.supplier_payments_total, 0)
    - coalesce(pen.penalties_total, 0)                     as expected_cash,
  d.closing_count,
  case
    when d.closing_count is null then null
    else d.closing_count - (
      d.opening_float
        + coalesce(s.cash_sales, 0)
        + coalesce(cp.customer_payments_total, 0)
        - coalesce(p.purchases_total, 0)
        - coalesce(e.expenses_total, 0)
        - coalesce(sp.supplier_payments_total, 0)
        - coalesce(pen.penalties_total, 0)
    )
  end                                                       as variance,
  d.status
from cash_days d
left join (
  select cash_day_id, sum(amount) as cash_sales
  from sales
  where payment_method = 'cash'
  group by cash_day_id
) s on s.cash_day_id = d.id
left join (
  select cash_day_id, sum(amount) as customer_payments_total
  from customer_payments
  group by cash_day_id
) cp on cp.cash_day_id = d.id
left join (
  select cash_day_id, sum(amount) as purchases_total
  from purchases
  where payment_method = 'cash'
  group by cash_day_id
) p on p.cash_day_id = d.id
left join (
  select cash_day_id, sum(amount) as expenses_total
  from expenses
  group by cash_day_id
) e on e.cash_day_id = d.id
left join (
  select cash_day_id, sum(amount) as supplier_payments_total
  from supplier_payments
  group by cash_day_id
) sp on sp.cash_day_id = d.id
left join (
  select cash_day_id, sum(amount) as penalties_total
  from compliance_penalties
  group by cash_day_id
) pen on pen.cash_day_id = d.id;
