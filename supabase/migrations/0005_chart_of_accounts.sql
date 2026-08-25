-- Phase 2 (part 1): Chart of Accounts (Blueprint §13).
--
-- Seeded automatically per tenant, covering exactly the accounts the GL
-- engine (0006) actually posts to — sale/purchase/expense capture from
-- Phase 1, in both currencies. No equity/capital account yet: that
-- arrives with the §1.1 opening-balance snapshot, which isn't built
-- yet either. Adding accounts nothing posts to would be exactly the
-- kind of speculative design CLAUDE.md warns against.

create table accounts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete restrict,
  -- Stable lookup key used by the posting functions in 0006 — e.g.
  -- 'expense_rent' is derived as 'expense_' || expenses.category, so
  -- adding a new expense category and its account stay a single
  -- migration each, never a code-side case statement to update too.
  code          text not null,
  name          text not null,
  -- Check-constrained text, not an enum, so the consulting team can
  -- extend it via migration without a type rewrite — same convention
  -- as tenants.formalization_stage and expenses.category.
  account_type  text not null check (account_type in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  created_at    timestamptz not null default now(),

  unique (tenant_id, code)
);

create index accounts_tenant_idx on accounts (tenant_id);

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

create trigger tenants_seed_default_accounts
  after insert on tenants
  for each row
  execute function public.seed_default_accounts();

-- Backfill: any tenant created before this migration (Phase 0/1 test
-- tenants) gets the same standard chart. Safe to rerun.
insert into accounts (tenant_id, code, name, account_type)
select t.id, a.code, a.name, a.account_type
from tenants t
cross join (values
  ('cash_usd',                    'Cash - USD',                    'asset'),
  ('cash_zwg',                    'Cash - ZWG',                    'asset'),
  ('inventory',                   'Inventory',                     'asset'),
  ('trade_receivables',           'Trade Receivables',             'asset'),
  ('revenue',                     'Revenue',                       'revenue'),
  ('expense_rent',                'Rent Expense',                  'expense'),
  ('expense_utilities',           'Utilities Expense',             'expense'),
  ('expense_transport',           'Transport Expense',             'expense'),
  ('expense_airtime_data',        'Airtime / Data Expense',        'expense'),
  ('expense_repairs_maintenance', 'Repairs & Maintenance Expense', 'expense'),
  ('expense_packaging',           'Packaging Expense',             'expense'),
  ('expense_casual_labour',       'Casual Labour Expense',         'expense'),
  ('expense_bank_charges',        'Bank / Mobile Money Charges',   'expense'),
  ('expense_other',               'Other Expense',                 'expense')
) as a(code, name, account_type)
on conflict (tenant_id, code) do nothing;

-- Not forced: the only writes come from seed_default_accounts() and the
-- GL engine's SECURITY DEFINER posting functions (0006), which rely on
-- table-owner RLS bypass to write despite `authenticated` having no
-- write policy at all. See 0006 for the full reasoning.
alter table accounts enable row level security;

create policy accounts_select_members
  on accounts for select
  to authenticated
  using (public.is_tenant_member(tenant_id));
