-- Phase 1: Daily Cash Control + manual sales/purchase/expense capture
-- (Blueprint §2, §3.1, §4.1, §8 — see the build-order note added to
-- §8 in docs/erp-blueprint.md for why expenses are in this phase).
--
-- These are raw client-logged transactions, not journal entries — the
-- GL engine (Phase 2) reads this table and posts the actual
-- double-entry journals per CLAUDE.md non-negotiable #1. Nothing here
-- should be read as "the books"; it's the source log the books get
-- built from.

create type currency_code as enum ('USD', 'ZWG');

-- One row per tenant, per trading day, per currency (Blueprint §10.3:
-- USD cash and ZWG cash are counted and reconciled separately).
create table cash_days (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete restrict,
  trade_date            date not null,
  currency              currency_code not null,

  opening_float         numeric(14, 2) not null check (opening_float >= 0),
  opened_by             uuid not null references auth.users(id),
  opened_at             timestamptz not null default now(),

  -- Filled in at end-of-day (§2.3). NULL until the day is closed.
  closing_count         numeric(14, 2) check (closing_count >= 0),
  variance_note         text,
  closed_by             uuid references auth.users(id),
  closed_at             timestamptz,

  status                text not null default 'open'
    check (status in ('open', 'closed')),

  created_at            timestamptz not null default now(),

  unique (tenant_id, trade_date, currency),
  check (
    (status = 'open'  and closing_count is null and closed_by is null and closed_at is null) or
    (status = 'closed' and closing_count is not null and closed_by is not null and closed_at is not null)
  )
);

create index cash_days_tenant_date_idx on cash_days (tenant_id, trade_date desc);

-- Once a day is closed it's a finalized count, same spirit as journal
-- immutability (CLAUDE.md non-negotiable #6): don't let it drift after
-- the fact. Reopening/correcting a closed day is a consultant-console
-- action added with the GL engine's reversal pattern in Phase 2, not a
-- plain UPDATE from the client app.
create or replace function public.cash_days_guard_closed()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'closed' then
    raise exception 'cash_days: day % is closed and cannot be modified', old.id;
  end if;
  if new.tenant_id <> old.tenant_id
     or new.trade_date <> old.trade_date
     or new.currency <> old.currency
     or new.opening_float <> old.opening_float then
    raise exception 'cash_days: tenant_id, trade_date, currency, and opening_float are immutable once set';
  end if;
  return new;
end;
$$;

create trigger cash_days_guard_closed
  before update on cash_days
  for each row
  execute function public.cash_days_guard_closed();

-- Shared currency/rate shape for sales, purchases, expenses (CLAUDE.md
-- non-negotiable #4): rate is captured per transaction, only required
-- when the transaction isn't already in USD, and never defaulted.
create table sales (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete restrict,
  cash_day_id           uuid not null references cash_days(id) on delete restrict,

  sold_at               timestamptz not null default now(),
  description            text not null,
  amount                numeric(14, 2) not null check (amount > 0),
  currency              currency_code not null,
  exchange_rate_to_usd  numeric(14, 6) check (exchange_rate_to_usd > 0),

  -- §4.1/§5.1: cash sales affect the till count directly; "account"
  -- sales are informal book credit, tracked properly once Debtors
  -- (Phase 3) lands — captured here so nothing is lost in the meantime.
  payment_method        text not null check (payment_method in ('cash', 'account')),
  customer_name         text,

  recorded_by           uuid not null references auth.users(id),
  created_at            timestamptz not null default now(),

  check (currency = 'USD' or exchange_rate_to_usd is not null),
  check (payment_method = 'cash' or customer_name is not null)
);

create index sales_cash_day_idx on sales (cash_day_id);
create index sales_tenant_sold_at_idx on sales (tenant_id, sold_at desc);

create table purchases (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete restrict,
  cash_day_id           uuid not null references cash_days(id) on delete restrict,

  purchased_at          timestamptz not null default now(),
  supplier              text,
  description           text not null,
  amount                numeric(14, 2) not null check (amount > 0),
  currency              currency_code not null,
  exchange_rate_to_usd  numeric(14, 6) check (exchange_rate_to_usd > 0),
  has_receipt           boolean not null default false,

  recorded_by           uuid not null references auth.users(id),
  created_at            timestamptz not null default now(),

  check (currency = 'USD' or exchange_rate_to_usd is not null)
);

create index purchases_cash_day_idx on purchases (cash_day_id);
create index purchases_tenant_purchased_at_idx on purchases (tenant_id, purchased_at desc);

create table expenses (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete restrict,
  cash_day_id           uuid not null references cash_days(id) on delete restrict,

  paid_at               timestamptz not null default now(),
  -- Blueprint §8 category list, plus 'other'. Text + check (not an
  -- enum) so the consulting team can extend it via migration without a
  -- type rewrite, same reasoning as tenants.formalization_stage.
  category              text not null check (category in (
                          'rent', 'utilities', 'transport', 'airtime_data',
                          'repairs_maintenance', 'packaging', 'casual_labour',
                          'bank_charges', 'other'
                        )),
  description           text not null,
  amount                numeric(14, 2) not null check (amount > 0),
  currency              currency_code not null,
  exchange_rate_to_usd  numeric(14, 6) check (exchange_rate_to_usd > 0),
  has_receipt           boolean not null default false,

  recorded_by           uuid not null references auth.users(id),
  created_at            timestamptz not null default now(),

  check (currency = 'USD' or exchange_rate_to_usd is not null)
);

create index expenses_cash_day_idx on expenses (cash_day_id);
create index expenses_tenant_paid_at_idx on expenses (tenant_id, paid_at desc);

-- §2.3 end-of-day reconciliation: expected cash = opening float + cash
-- sales − cash purchases − cash expenses (only cash-method sales count;
-- "account" sales never touched the till). security_invoker so the view
-- runs under the querying role's RLS, not the view owner's — otherwise
-- this view would silently bypass tenant isolation for every caller.
create view cash_day_summary
  with (security_invoker = true)
as
select
  d.id                                                   as cash_day_id,
  d.tenant_id,
  d.trade_date,
  d.currency,
  d.opening_float,
  coalesce(s.cash_sales, 0)                               as cash_sales,
  coalesce(p.purchases_total, 0)                          as purchases_total,
  coalesce(e.expenses_total, 0)                           as expenses_total,
  d.opening_float
    + coalesce(s.cash_sales, 0)
    - coalesce(p.purchases_total, 0)
    - coalesce(e.expenses_total, 0)                       as expected_cash,
  d.closing_count,
  case
    when d.closing_count is null then null
    else d.closing_count - (
      d.opening_float
        + coalesce(s.cash_sales, 0)
        - coalesce(p.purchases_total, 0)
        - coalesce(e.expenses_total, 0)
    )
  end                                                      as variance,
  d.status
from cash_days d
left join (
  select cash_day_id, sum(amount) as cash_sales
  from sales
  where payment_method = 'cash'
  group by cash_day_id
) s on s.cash_day_id = d.id
left join (
  select cash_day_id, sum(amount) as purchases_total
  from purchases
  group by cash_day_id
) p on p.cash_day_id = d.id
left join (
  select cash_day_id, sum(amount) as expenses_total
  from expenses
  group by cash_day_id
) e on e.cash_day_id = d.id;
