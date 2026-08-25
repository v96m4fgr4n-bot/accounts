-- Phase 3 (part 1): Debtors & Creditors (Blueprint §5).
--
-- §5.1 book credit already had a place to land in Phase 1/2 (sales with
-- payment_method='account' post DR Trade Receivables), but customer_name
-- was free text with no running balance. This migration adds a proper
-- customers/suppliers master and the repayment side of both ledgers.
-- Credit purchases (§3.2) land here too, since Creditors needs a source
-- for what's actually owed to a supplier — Phase 1 purchases were
-- cash-only by design.

create table customers (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete restrict,
  name        text not null,
  phone       text,
  created_at  timestamptz not null default now(),

  unique (tenant_id, name)
);

create index customers_tenant_idx on customers (tenant_id);

create table suppliers (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete restrict,
  name        text not null,
  phone       text,
  created_at  timestamptz not null default now(),

  unique (tenant_id, name)
);

create index suppliers_tenant_idx on suppliers (tenant_id);

-- sales already has customer_name (Phase 1, free text, kept for display);
-- customer_id is the real link a running balance can be computed from.
alter table sales add column customer_id uuid references customers(id);

-- Backfill: one customer per distinct (tenant_id, customer_name) already
-- logged as an 'account' sale, then link the sales rows to it. Safe to
-- rerun (ON CONFLICT on the (tenant_id, name) unique constraint above).
insert into customers (tenant_id, name)
select distinct tenant_id, customer_name
from sales
where payment_method = 'account' and customer_name is not null
on conflict (tenant_id, name) do nothing;

update sales s
   set customer_id = c.id
  from customers c
 where s.payment_method = 'account'
   and s.customer_name = c.name
   and s.tenant_id = c.tenant_id
   and s.customer_id is null;

alter table sales add constraint sales_account_requires_customer
  check (payment_method <> 'account' or customer_id is not null);

-- purchases (Phase 1) was cash-only; add the credit-purchase shape (§3.2).
alter table purchases add column payment_method text not null default 'cash'
  check (payment_method in ('cash', 'credit'));
alter table purchases add column supplier_id uuid references suppliers(id);
alter table purchases add constraint purchases_credit_requires_supplier
  check (payment_method <> 'credit' or supplier_id is not null);

create table customer_payments (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete restrict,
  customer_id           uuid not null references customers(id) on delete restrict,
  -- Tied to the daily cash routine like sales/purchases/expenses — a
  -- customer paying down book credit is cash received on a specific
  -- trading day, and belongs in that day's till reconciliation (0008
  -- extends cash_day_summary to include it).
  cash_day_id           uuid not null references cash_days(id) on delete restrict,

  paid_at               timestamptz not null default now(),
  amount                numeric(14, 2) not null check (amount > 0),
  currency              currency_code not null,
  exchange_rate_to_usd  numeric(14, 6) check (exchange_rate_to_usd > 0),

  recorded_by           uuid not null references auth.users(id),
  created_at            timestamptz not null default now(),

  check (currency = 'USD' or exchange_rate_to_usd is not null)
);

create index customer_payments_customer_idx on customer_payments (customer_id);
create index customer_payments_cash_day_idx on customer_payments (cash_day_id);

create table supplier_payments (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete restrict,
  supplier_id           uuid not null references suppliers(id) on delete restrict,
  cash_day_id           uuid not null references cash_days(id) on delete restrict,

  paid_at               timestamptz not null default now(),
  amount                numeric(14, 2) not null check (amount > 0),
  currency              currency_code not null,
  exchange_rate_to_usd  numeric(14, 6) check (exchange_rate_to_usd > 0),

  recorded_by           uuid not null references auth.users(id),
  created_at            timestamptz not null default now(),

  check (currency = 'USD' or exchange_rate_to_usd is not null)
);

create index supplier_payments_supplier_idx on supplier_payments (supplier_id);
create index supplier_payments_cash_day_idx on supplier_payments (cash_day_id);

-- New GL account: Accounts Payable (credit purchases post here instead of
-- Cash; supplier_payments relieves it). Same seed + backfill pattern as
-- 0005's chart of accounts. CREATE OR REPLACE on the same name/signature
-- keeps the function's OID, so the existing tenants_seed_default_accounts
-- trigger (0005) picks up this new body automatically — no need to touch
-- the trigger itself.
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
    (new.id, 'expense_other',               'Other Expense',                  'expense');
  return new;
end;
$$;

revoke all on function public.seed_default_accounts() from public;

insert into accounts (tenant_id, code, name, account_type)
select t.id, 'accounts_payable', 'Accounts Payable', 'liability'
from tenants t
on conflict (tenant_id, code) do nothing;

-- RLS: same shape as Phase 1 — insert + select only from the app, no
-- update/delete (corrections go through the GL's reversal pattern once
-- posted). customers/suppliers are select + insert (created implicitly
-- when the app looks one up by name and doesn't find it), never
-- update/delete here either, to keep names stable once a payment or
-- credit sale references them.

alter table customers          enable row level security;
alter table suppliers          enable row level security;
alter table customer_payments  enable row level security;
alter table supplier_payments  enable row level security;

alter table customers          force row level security;
alter table suppliers          force row level security;
alter table customer_payments  force row level security;
alter table supplier_payments  force row level security;

create policy customers_select_members on customers for select
  to authenticated using (public.is_tenant_member(tenant_id));
create policy customers_insert_members on customers for insert
  to authenticated with check (public.is_tenant_member(tenant_id));

create policy suppliers_select_members on suppliers for select
  to authenticated using (public.is_tenant_member(tenant_id));
create policy suppliers_insert_members on suppliers for insert
  to authenticated with check (public.is_tenant_member(tenant_id));

create policy customer_payments_select_members on customer_payments for select
  to authenticated using (public.is_tenant_member(tenant_id));
create policy customer_payments_insert_members on customer_payments for insert
  to authenticated with check (public.is_tenant_member(tenant_id) and recorded_by = auth.uid());

create policy supplier_payments_select_members on supplier_payments for select
  to authenticated using (public.is_tenant_member(tenant_id));
create policy supplier_payments_insert_members on supplier_payments for insert
  to authenticated with check (public.is_tenant_member(tenant_id) and recorded_by = auth.uid());
