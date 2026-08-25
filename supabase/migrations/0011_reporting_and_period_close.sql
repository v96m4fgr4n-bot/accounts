-- Phase 4: Reporting (Blueprint §14, §15) + period closing (§14's
-- "closed periods can't be posted to without owner authorization").
--
-- Reporting is read-only SQL functions over the existing GL — no new
-- capture flow, so no SECURITY DEFINER needed here: these run
-- SECURITY INVOKER (the default), meaning they're subject to the
-- caller's own RLS on accounts/journal_entries/journal_lines exactly
-- like a plain SELECT would be. A consultant asking for a tenant they
-- aren't a member of gets zero rows back, not an error — RLS does the
-- work, the function doesn't need to re-check tenant membership itself.

create table period_closes (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete restrict,
  -- Every journal dated on or before this is locked. A single "closed
  -- through" watermark per tenant, not a list of individually-closed
  -- periods with potential gaps — simpler, and matches how the monthly
  -- close actually works (§13: close the month, move on).
  closed_through date not null,
  closed_by      uuid not null references auth.users(id),
  note           text,
  created_at     timestamptz not null default now()
);

create index period_closes_tenant_idx on period_closes (tenant_id, closed_through desc);

-- Can only close further forward, never move the watermark back — that
-- would silently reopen a period rather than closing a new one, and
-- isn't what "close the month" means. Re-closing to an earlier or equal
-- date is rejected outright; extend the close by inserting a later one.
create or replace function public.period_closes_guard_monotonic()
returns trigger
language plpgsql
as $$
declare
  v_current_max date;
begin
  select max(closed_through) into v_current_max
    from period_closes where tenant_id = new.tenant_id;
  if v_current_max is not null and new.closed_through <= v_current_max then
    raise exception 'period_closes: closed_through (%) must be after tenant %''s current closed-through date (%)',
      new.closed_through, new.tenant_id, v_current_max;
  end if;
  return new;
end;
$$;

create trigger period_closes_guard_monotonic
  before insert on period_closes
  for each row execute function public.period_closes_guard_monotonic();

-- Immutable for the same reason journals are (non-negotiable #6):
-- closing a period is itself an authoritative record. journal_immutable
-- (0006) is table-generic (uses tg_table_name/old.id), so it's reused
-- as-is rather than duplicated.
create trigger period_closes_immutable
  before update or delete on period_closes
  for each row execute function public.journal_immutable();

alter table period_closes enable row level security;
alter table period_closes force row level security;

create policy period_closes_select_members
  on period_closes for select
  to authenticated
  using (public.is_tenant_member(tenant_id));

-- Only a consultant can close a period — this is the "owner
-- authorization" gate from the client side: the day-to-day app
-- (client_user) can never lock its own books.
create policy period_closes_insert_consultants
  on period_closes for insert
  to authenticated
  with check (
    closed_by = auth.uid()
    and exists (
      select 1 from tenant_memberships
       where tenant_id = period_closes.tenant_id
         and user_id = auth.uid()
         and role = 'consultant'
    )
  );

-- post_journal (0006) gains the period-lock check. CREATE OR REPLACE on
-- the same name/signature keeps its OID, so every existing trigger that
-- calls it (sales/purchases/expenses/customer_payments/supplier_payments)
-- picks this up with no changes there. A consultant can still post into
-- a closed period (an authorized correction); a client_user's ordinary
-- day-to-day logging cannot. reverse_journal is unaffected — it always
-- posts as of current_date, never backdated into a closed period.
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
  v_closed_through date;
begin
  select max(closed_through) into v_closed_through
    from period_closes where tenant_id = p_tenant_id;

  if v_closed_through is not null and p_entry_date <= v_closed_through
     and not exists (
       select 1 from tenant_memberships
        where tenant_id = p_tenant_id and user_id = auth.uid() and role = 'consultant'
     ) then
    raise exception 'post_journal: % falls in a closed period for tenant % (closed through %) — a consultant must authorize this',
      p_entry_date, p_tenant_id, v_closed_through;
  end if;

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

-- All three reports below are grouped by (account, currency), not just
-- account — journal amounts are stored in their original transaction
-- currency with no conversion (non-negotiable #4), and only the two Cash
-- accounts are themselves currency-split in the chart of accounts
-- (Cash - USD / Cash - ZWG). An account like Revenue or an expense
-- account can carry both USD and ZWG activity, so summing its debits/
-- credits without splitting by currency would silently combine a USD
-- figure and a ZWG figure into one meaningless number — the same bug
-- already caught and fixed for customer_balances/supplier_balances in
-- Phase 3. Combined-currency reporting stays a Phase 4+ concern, same
-- as noted for journals themselves back in Phase 2.

-- §14: trial balance. Netted per account+currency (debit_balance XOR
-- credit_balance, never both) rather than raw lifetime debit/credit
-- totals — the sum of the debit_balance column across every row always
-- equals the sum of credit_balance *within the same currency*, which is
-- the report-level demonstration of non-negotiable #3, not just an
-- internal DB trigger.
create or replace function public.trial_balance(p_tenant_id uuid, p_as_of date)
returns table (
  account_code text,
  account_name text,
  account_type text,
  currency currency_code,
  debit_balance numeric,
  credit_balance numeric
)
language sql
stable
as $$
  select
    a.code,
    a.name,
    a.account_type,
    totals.currency,
    greatest(totals.net, 0)  as debit_balance,
    greatest(-totals.net, 0) as credit_balance
  from accounts a
  join (
    select jl.account_id, je.currency,
           sum(case when jl.side = 'debit' then jl.amount else -jl.amount end) as net
      from journal_lines jl
      join journal_entries je on je.id = jl.journal_entry_id
     where je.tenant_id = p_tenant_id and je.entry_date <= p_as_of
     group by jl.account_id, je.currency
  ) totals on totals.account_id = a.id
  where a.tenant_id = p_tenant_id
  order by a.code, totals.currency;
$$;

revoke all on function public.trial_balance(uuid, date) from public;
grant execute on function public.trial_balance(uuid, date) to authenticated, service_role;

-- §15: income statement (P&L) for a date range. Revenue and expense
-- accounts only, each shown in its own normal-balance direction so both
-- read as positive numbers a non-accountant owner can make sense of;
-- net income is Revenue minus Expense per currency, left for the caller
-- to sum rather than encoded as a synthetic row here.
create or replace function public.income_statement(p_tenant_id uuid, p_from date, p_to date)
returns table (
  account_code text,
  account_name text,
  account_type text,
  currency currency_code,
  amount numeric
)
language sql
stable
as $$
  select
    a.code,
    a.name,
    a.account_type,
    totals.currency,
    case a.account_type
      when 'revenue' then totals.net_credit
      else totals.net_debit
    end as amount
  from accounts a
  join (
    select jl.account_id, je.currency,
           sum(case when jl.side = 'credit' then jl.amount else -jl.amount end) as net_credit,
           sum(case when jl.side = 'debit'  then jl.amount else -jl.amount end) as net_debit
      from journal_lines jl
      join journal_entries je on je.id = jl.journal_entry_id
     where je.tenant_id = p_tenant_id and je.entry_date between p_from and p_to
     group by jl.account_id, je.currency
  ) totals on totals.account_id = a.id
  where a.tenant_id = p_tenant_id and a.account_type in ('revenue', 'expense')
  order by a.account_type, a.code, totals.currency;
$$;

revoke all on function public.income_statement(uuid, date, date) from public;
grant execute on function public.income_statement(uuid, date, date) to authenticated, service_role;

-- §15: balance sheet (Statement of Financial Position) as of a date.
-- Asset/liability accounts show their as-of balance directly, per
-- currency. There is no owner's-equity/capital account yet (deferred
-- until the §1.1 opening-balance snapshot is built — not this phase), so
-- "Retained Earnings" — cumulative net income (revenue minus expense)
-- from inception through the as-of date — is the only equity line,
-- computed rather than stored, one row per currency that has revenue or
-- expense activity. This isn't a shortcut: because every journal is
-- individually balanced within its own currency (non-negotiable #3 +
-- #4), Assets always equals Liabilities plus this derived figure exactly
-- *within each currency*, with no explicit period-end closing entries
-- required and no cross-currency conversion attempted.
create or replace function public.balance_sheet(p_tenant_id uuid, p_as_of date)
returns table (
  account_code text,
  account_name text,
  account_type text,
  currency currency_code,
  amount numeric
)
language sql
stable
as $$
  select a.code, a.name, a.account_type, totals.currency,
         case a.account_type
           when 'asset' then totals.net_debit
           else totals.net_credit
         end as amount
    from accounts a
    join (
      select jl.account_id, je.currency,
             sum(case when jl.side = 'debit'  then jl.amount else -jl.amount end) as net_debit,
             sum(case when jl.side = 'credit' then jl.amount else -jl.amount end) as net_credit
        from journal_lines jl
        join journal_entries je on je.id = jl.journal_entry_id
       where je.tenant_id = p_tenant_id and je.entry_date <= p_as_of
       group by jl.account_id, je.currency
    ) totals on totals.account_id = a.id
   where a.tenant_id = p_tenant_id and a.account_type in ('asset', 'liability')

  union all

  select
    'retained_earnings',
    'Retained Earnings (cumulative net income)',
    'equity',
    re.currency,
    coalesce(re.revenue_total, 0) - coalesce(re.expense_total, 0)
  from (
    select currency,
           sum(revenue_amount) as revenue_total,
           sum(expense_amount) as expense_total
      from (
        select je.currency,
               case when a2.account_type = 'revenue'
                    then case when jl.side = 'credit' then jl.amount else -jl.amount end end as revenue_amount,
               case when a2.account_type = 'expense'
                    then case when jl.side = 'debit' then jl.amount else -jl.amount end end as expense_amount
          from journal_lines jl
          join journal_entries je on je.id = jl.journal_entry_id
          join accounts a2 on a2.id = jl.account_id
         where je.tenant_id = p_tenant_id and je.entry_date <= p_as_of
           and a2.account_type in ('revenue', 'expense')
      ) movements
     group by currency
  ) re;
$$;

revoke all on function public.balance_sheet(uuid, date) from public;
grant execute on function public.balance_sheet(uuid, date) to authenticated, service_role;
