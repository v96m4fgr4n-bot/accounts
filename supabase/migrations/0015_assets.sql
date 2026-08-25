-- Phase 6 (part 3): Assets Function (Blueprint §11.1, §11.2).
--
-- Scoped the same way bank account opening balances were: the asset
-- register itself is master data (matches §1.1's "equipment/fixtures
-- owned" opening snapshot — durable items the business already has, not
-- necessarily a new cash purchase happening through this system), so
-- adding an asset to the register does not itself post an acquisition
-- journal. Depreciation and disposal are real postings, built below.
--
-- Depreciation is a manually-triggered straight-line run (§0's
-- cash-first framing: the consulting team decides when to run it, not a
-- cron job this app doesn't have infrastructure for), computed as
-- cost / useful_life_months, capped so an asset is never depreciated
-- below zero book value.
--
-- dispose_asset posts its journal directly (a 2-4 line entry, not
-- post_journal's fixed debit/credit pair), which means it doesn't get
-- post_journal's period-lock check (0011) for free. Rather than
-- duplicate that check's logic, it's pulled out into its own function
-- here and post_journal (0011) is redefined to call it — CREATE OR
-- REPLACE on the same name/signature keeps post_journal's OID, so every
-- existing trigger that calls it picks this up with no changes there.

create or replace function public.check_period_open(p_tenant_id uuid, p_entry_date date)
returns void
language plpgsql
as $$
declare
  v_closed_through date;
begin
  select max(closed_through) into v_closed_through
    from period_closes where tenant_id = p_tenant_id;

  if v_closed_through is not null and p_entry_date <= v_closed_through
     and not exists (
       select 1 from tenant_memberships
        where tenant_id = p_tenant_id and user_id = auth.uid() and role = 'consultant'
     ) then
    raise exception 'check_period_open: % falls in a closed period for tenant % (closed through %) — a consultant must authorize this',
      p_entry_date, p_tenant_id, v_closed_through;
  end if;
end;
$$;

create or replace function public.post_journal(
  p_tenant_id    uuid,
  p_entry_date   date,
  p_currency     currency_code,
  p_description  text,
  p_source_type  text,
  p_source_id    uuid,
  p_debit_code   text,
  p_credit_code  text,
  p_amount       numeric
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entry_id uuid;
  v_debit_account_id uuid;
  v_credit_account_id uuid;
begin
  perform public.check_period_open(p_tenant_id, p_entry_date);

  v_debit_account_id := public.get_tenant_account(p_tenant_id, p_debit_code);
  v_credit_account_id := public.get_tenant_account(p_tenant_id, p_credit_code);

  if v_debit_account_id is null or v_credit_account_id is null then
    raise exception 'post_journal: missing chart-of-accounts entry (debit=%, credit=%) for tenant %',
      p_debit_code, p_credit_code, p_tenant_id;
  end if;

  insert into journal_entries (tenant_id, entry_date, currency, description, source_type, source_id)
  values (p_tenant_id, p_entry_date, p_currency, p_description, p_source_type, p_source_id)
  returning id into v_entry_id;

  insert into journal_lines (journal_entry_id, tenant_id, account_id, side, amount) values
    (v_entry_id, p_tenant_id, v_debit_account_id,  'debit',  p_amount),
    (v_entry_id, p_tenant_id, v_credit_account_id, 'credit', p_amount);

  return v_entry_id;
end;
$$;

create table assets (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete restrict,
  name                 text not null,
  cost                 numeric(14, 2) not null check (cost > 0),
  currency             currency_code not null,
  acquired_at          date not null,
  useful_life_months   integer not null check (useful_life_months > 0),
  -- Running total of depreciation posted so far, in the asset's own
  -- currency — kept here (not re-derived from journal_lines each time)
  -- so a depreciation run can enforce "never below zero book value"
  -- with a simple check, and so disposal can read it directly.
  accumulated_depreciation  numeric(14, 2) not null default 0
                              check (accumulated_depreciation >= 0),
  disposed_at          date,
  disposal_proceeds    numeric(14, 2),
  created_by           uuid not null references auth.users(id),
  created_at           timestamptz not null default now(),

  check (accumulated_depreciation <= cost),
  check (disposed_at is null or disposed_at >= acquired_at),
  check ((disposed_at is null) = (disposal_proceeds is null))
);

create index assets_tenant_idx on assets (tenant_id);

alter table assets enable row level security;
alter table assets force row level security;

create policy assets_select_members on assets for select
  to authenticated using (public.is_tenant_member(tenant_id));
create policy assets_insert_members on assets for insert
  to authenticated with check (public.is_tenant_member(tenant_id) and created_by = auth.uid());

-- New GL accounts. accumulated_depreciation is a contra-asset (reduces
-- total assets) but there's no separate account_type for that — it's
-- seeded as 'asset' anyway and only ever receives credits, so its net
-- debit balance is negative and correctly nets down total assets when
-- summed in trial_balance/balance_sheet (Phase 4), no schema change
-- needed. disposal_gain_loss is 'expense' for the same reason: a loss
-- debits it (reads as a positive expense), a gain credits it (nets
-- negative, i.e. reads as income) — Phase 4's reports handle a negative
-- expense balance the same way they already handle a negative asset one.
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
    (new.id, 'fixed_assets',                'Fixed Assets',                   'asset'),
    (new.id, 'accumulated_depreciation',    'Accumulated Depreciation',       'asset'),
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
    (new.id, 'expense_penalties',           'Penalties & Interest Expense',   'expense'),
    (new.id, 'depreciation_expense',        'Depreciation Expense',           'expense'),
    (new.id, 'disposal_gain_loss',          'Gain / Loss on Disposal',        'expense');
  return new;
end;
$$;

insert into accounts (tenant_id, code, name, account_type)
select t.id, a.code, a.name, a.account_type
from tenants t
cross join (values
  ('fixed_assets',             'Fixed Assets',               'asset'),
  ('accumulated_depreciation', 'Accumulated Depreciation',   'asset'),
  ('depreciation_expense',     'Depreciation Expense',       'expense'),
  ('disposal_gain_loss',       'Gain / Loss on Disposal',    'expense')
) as a(code, name, account_type)
on conflict (tenant_id, code) do nothing;

-- One row per depreciation run, so each gets its own source_id — an
-- asset is depreciated many times over its life, and journal_entries'
-- (source_type, source_id) uniqueness needs a distinct id per posting,
-- not the shared asset id (see 0006's index for why that constraint
-- exists at all).
create table asset_depreciation_runs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete restrict,
  asset_id      uuid not null references assets(id) on delete restrict,
  period_through date not null,
  amount        numeric(14, 2) not null check (amount > 0),
  posted_by     uuid not null references auth.users(id),
  created_at    timestamptz not null default now()
);

create index asset_depreciation_runs_asset_idx on asset_depreciation_runs (asset_id, period_through desc);

alter table asset_depreciation_runs enable row level security;
alter table asset_depreciation_runs force row level security;

create policy asset_depreciation_runs_select_members on asset_depreciation_runs for select
  to authenticated using (public.is_tenant_member(tenant_id));

-- run_asset_depreciation is the only legitimate way a row gets created
-- here (see below) — no direct INSERT policy for authenticated at all,
-- same "no policy = denied, only a SECURITY DEFINER function writes"
-- shape as the GL tables themselves. The amount posted has to match
-- straight-line math and respect the asset's remaining book value,
-- which a client-supplied INSERT could not be trusted to get right.

-- Posts DR Depreciation Expense / CR Accumulated Depreciation for one
-- asset, for the amount elapsed (straight-line: cost / useful_life_months
-- per month) since its last run, capped at the asset's remaining book
-- value. Any tenant member may call it — matches §16's "jointly"
-- framing used for compliance_items/bank_reconciliations, not gated to
-- consultants.
create or replace function public.run_asset_depreciation(p_asset_id uuid, p_period_through date)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_asset assets%rowtype;
  v_last_through date;
  v_months_elapsed integer;
  v_monthly numeric;
  v_amount numeric;
  v_run_id uuid;
  v_entry_id uuid;
begin
  select * into v_asset from assets where id = p_asset_id;
  if not found then
    raise exception 'run_asset_depreciation: asset % not found', p_asset_id;
  end if;
  if not public.is_tenant_member(v_asset.tenant_id) then
    raise exception 'run_asset_depreciation: not a member of this asset''s tenant';
  end if;
  if v_asset.disposed_at is not null then
    raise exception 'run_asset_depreciation: asset % has been disposed', p_asset_id;
  end if;

  select max(period_through) into v_last_through
    from asset_depreciation_runs where asset_id = p_asset_id;

  v_months_elapsed := greatest(0,
    (extract(year from p_period_through) - extract(year from coalesce(v_last_through, v_asset.acquired_at))) * 12
    + (extract(month from p_period_through) - extract(month from coalesce(v_last_through, v_asset.acquired_at)))
  );
  if v_months_elapsed = 0 then
    raise exception 'run_asset_depreciation: % is not after the asset''s last depreciation run (%)',
      p_period_through, coalesce(v_last_through, v_asset.acquired_at);
  end if;

  v_monthly := round(v_asset.cost / v_asset.useful_life_months, 2);
  v_amount := least(v_monthly * v_months_elapsed, v_asset.cost - v_asset.accumulated_depreciation);
  if v_amount <= 0 then
    raise exception 'run_asset_depreciation: asset % is already fully depreciated', p_asset_id;
  end if;

  insert into asset_depreciation_runs (tenant_id, asset_id, period_through, amount, posted_by)
  values (v_asset.tenant_id, p_asset_id, p_period_through, v_amount, auth.uid())
  returning id into v_run_id;

  v_entry_id := public.post_journal(
    v_asset.tenant_id, p_period_through, v_asset.currency,
    'Depreciation: ' || v_asset.name, 'depreciation', v_run_id,
    'depreciation_expense', 'accumulated_depreciation', v_amount
  );

  update assets set accumulated_depreciation = accumulated_depreciation + v_amount where id = p_asset_id;

  return v_entry_id;
end;
$$;

revoke all on function public.run_asset_depreciation(uuid, date) from public;
grant execute on function public.run_asset_depreciation(uuid, date) to authenticated, service_role;

-- §11.2 disposal: remove from active service and record any gain/loss —
-- proceeds above remaining book value are a gain (credit), below is a
-- loss (debit). One disposal per asset, so source_id = the asset's own
-- id is fine here (unlike depreciation runs, this never repeats).
create or replace function public.dispose_asset(p_asset_id uuid, p_disposed_at date, p_proceeds numeric)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_asset assets%rowtype;
  v_book_value numeric;
  v_gain_loss numeric;
  v_entry_id uuid;
  v_fixed_assets_id uuid;
  v_accum_dep_id uuid;
  v_disposal_id uuid;
  v_cash_code text;
begin
  select * into v_asset from assets where id = p_asset_id;
  if not found then
    raise exception 'dispose_asset: asset % not found', p_asset_id;
  end if;
  if not public.is_tenant_member(v_asset.tenant_id) then
    raise exception 'dispose_asset: not a member of this asset''s tenant';
  end if;
  if v_asset.disposed_at is not null then
    raise exception 'dispose_asset: asset % has already been disposed', p_asset_id;
  end if;
  perform public.check_period_open(v_asset.tenant_id, p_disposed_at);

  v_book_value := v_asset.cost - v_asset.accumulated_depreciation;
  v_gain_loss := p_proceeds - v_book_value;

  update assets
     set disposed_at = p_disposed_at, disposal_proceeds = p_proceeds
   where id = p_asset_id;

  -- Three-way entry (remove the asset at cost, remove its accumulated
  -- depreciation, record cash received and any gain/loss) still nets to
  -- zero, so it's built directly with post_journal's primitive rather
  -- than forcing an artificial two-line shape.
  v_fixed_assets_id := public.get_tenant_account(v_asset.tenant_id, 'fixed_assets');
  v_accum_dep_id := public.get_tenant_account(v_asset.tenant_id, 'accumulated_depreciation');
  v_disposal_id := public.get_tenant_account(v_asset.tenant_id, 'disposal_gain_loss');
  v_cash_code := case v_asset.currency when 'USD' then 'cash_usd' else 'cash_zwg' end;

  insert into journal_entries (tenant_id, entry_date, currency, description, source_type, source_id)
  values (v_asset.tenant_id, p_disposed_at, v_asset.currency, 'Disposal: ' || v_asset.name, 'asset_disposal', p_asset_id)
  returning id into v_entry_id;

  -- journal_lines requires amount > 0 — an asset disposed before any
  -- depreciation has ever run has accumulated_depreciation = 0, so this
  -- leg is conditional (the balance still holds either way: see the
  -- worked cases in the accompanying README/commit notes).
  if v_asset.accumulated_depreciation > 0 then
    insert into journal_lines (journal_entry_id, tenant_id, account_id, side, amount)
    values (v_entry_id, v_asset.tenant_id, v_accum_dep_id, 'debit', v_asset.accumulated_depreciation);
  end if;

  if p_proceeds > 0 then
    insert into journal_lines (journal_entry_id, tenant_id, account_id, side, amount)
    values (v_entry_id, v_asset.tenant_id, public.get_tenant_account(v_asset.tenant_id, v_cash_code), 'debit', p_proceeds);
  end if;

  insert into journal_lines (journal_entry_id, tenant_id, account_id, side, amount)
  values (v_entry_id, v_asset.tenant_id, v_fixed_assets_id, 'credit', v_asset.cost);

  if v_gain_loss > 0 then
    insert into journal_lines (journal_entry_id, tenant_id, account_id, side, amount)
    values (v_entry_id, v_asset.tenant_id, v_disposal_id, 'credit', v_gain_loss);
  elsif v_gain_loss < 0 then
    insert into journal_lines (journal_entry_id, tenant_id, account_id, side, amount)
    values (v_entry_id, v_asset.tenant_id, v_disposal_id, 'debit', -v_gain_loss);
  end if;

  return v_entry_id;
end;
$$;

revoke all on function public.dispose_asset(uuid, date, numeric) from public;
grant execute on function public.dispose_asset(uuid, date, numeric) to authenticated, service_role;

alter table journal_entries drop constraint journal_entries_source_type_check;
alter table journal_entries add constraint journal_entries_source_type_check
  check (source_type in (
    'sale', 'purchase', 'expense', 'customer_payment', 'supplier_payment',
    'penalty', 'casual_labour', 'bank_deposit', 'depreciation', 'asset_disposal',
    'reversal', 'manual'
  ));
