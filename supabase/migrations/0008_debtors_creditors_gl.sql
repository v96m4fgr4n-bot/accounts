-- Phase 3 (part 2): GL postings for debtors/creditors, and the till
-- reconciliation fix that comes with them.
--
-- Same posting shape as 0006: a plain (non-trigger) function holding the
-- pattern, an AFTER INSERT trigger wrapper, and a backfill for rows that
-- predate this migration.

-- Credit purchases (§3.2): post_purchase_journal (0006) always credited
-- Cash, because Phase 1 purchases were cash-only. Extend it to branch on
-- payment_method — CREATE OR REPLACE on the same name/signature keeps
-- its OID, so the existing purchases_post_journal trigger (0006) picks
-- this up automatically.
create or replace function public.post_purchase_journal(p purchases)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p.payment_method = 'credit' then
    return public.post_journal(
      p.tenant_id, p.purchased_at::date, p.currency, p.description, 'purchase', p.id,
      'inventory',
      'accounts_payable',
      p.amount
    );
  else
    return public.post_journal(
      p.tenant_id, p.purchased_at::date, p.currency, p.description, 'purchase', p.id,
      'inventory',
      case p.currency when 'USD' then 'cash_usd' else 'cash_zwg' end,
      p.amount
    );
  end if;
end;
$$;

create or replace function public.post_customer_payment_journal(cp customer_payments)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- §5.1: a customer paying down book credit reduces what they owe and
  -- increases cash — the mirror image of the 'account' sale journal.
  return public.post_journal(
    cp.tenant_id, cp.paid_at::date, cp.currency,
    'Payment received', 'customer_payment', cp.id,
    case cp.currency when 'USD' then 'cash_usd' else 'cash_zwg' end,
    'trade_receivables',
    cp.amount
  );
end;
$$;

revoke all on function public.post_customer_payment_journal(customer_payments) from public;

create or replace function public.customer_payments_post_journal_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.post_customer_payment_journal(new);
  return new;
end;
$$;

revoke all on function public.customer_payments_post_journal_trigger() from public;

create trigger customer_payments_post_journal
  after insert on customer_payments
  for each row execute function public.customer_payments_post_journal_trigger();

create or replace function public.post_supplier_payment_journal(sp supplier_payments)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- §5.3: paying a supplier reduces what's owed to them and reduces cash.
  return public.post_journal(
    sp.tenant_id, sp.paid_at::date, sp.currency,
    'Supplier payment', 'supplier_payment', sp.id,
    'accounts_payable',
    case sp.currency when 'USD' then 'cash_usd' else 'cash_zwg' end,
    sp.amount
  );
end;
$$;

revoke all on function public.post_supplier_payment_journal(supplier_payments) from public;

create or replace function public.supplier_payments_post_journal_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.post_supplier_payment_journal(new);
  return new;
end;
$$;

revoke all on function public.supplier_payments_post_journal_trigger() from public;

create trigger supplier_payments_post_journal
  after insert on supplier_payments
  for each row execute function public.supplier_payments_post_journal_trigger();

-- journal_entries.source_type check (0006) doesn't yet allow
-- 'customer_payment'/'supplier_payment' — widen it (drop + re-add,
-- Postgres has no ALTER ... ADD VALUE for a plain check constraint).
alter table journal_entries drop constraint journal_entries_source_type_check;
alter table journal_entries add constraint journal_entries_source_type_check
  check (source_type in ('sale', 'purchase', 'expense', 'customer_payment', 'supplier_payment', 'reversal', 'manual'));

-- Backfill for rows that predate this migration.
do $$
declare r customer_payments%rowtype;
begin
  for r in
    select cp.* from customer_payments cp
    where not exists (
      select 1 from journal_entries je
       where je.source_type = 'customer_payment' and je.source_id = cp.id
    )
  loop
    perform public.post_customer_payment_journal(r);
  end loop;
end;
$$;

do $$
declare r supplier_payments%rowtype;
begin
  for r in
    select sp.* from supplier_payments sp
    where not exists (
      select 1 from journal_entries je
       where je.source_type = 'supplier_payment' and je.source_id = sp.id
    )
  loop
    perform public.post_supplier_payment_journal(r);
  end loop;
end;
$$;

-- Till-reconciliation fix: cash_day_summary (Phase 1) only summed
-- sales/purchases/expenses. Customer payments (cash in) and supplier
-- payments (cash out) are real till movements too — a business that
-- collects book credit or pays a supplier in cash today would show a
-- variance the owner did nothing wrong to cause.
--
-- DROP + CREATE, not CREATE OR REPLACE: Postgres only allows REPLACE to
-- append new output columns at the end, not insert one ahead of existing
-- columns (customer_payments_total lands between cash_sales and
-- purchases_total here) — REPLACE errors with "cannot change name of
-- view column" on that shape of change. Nothing else references this
-- view, so dropping it first is safe.
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
  d.opening_float
    + coalesce(s.cash_sales, 0)
    + coalesce(cp.customer_payments_total, 0)
    - coalesce(p.purchases_total, 0)
    - coalesce(e.expenses_total, 0)
    - coalesce(sp.supplier_payments_total, 0)              as expected_cash,
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
  -- Only cash purchases hit the till; credit purchases don't move cash
  -- until the supplier is actually paid (supplier_payments, below).
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
) sp on sp.cash_day_id = d.id;

-- §5.2 "who owes us / who we owe, since when" — a simple list, per the
-- Blueprint's own framing ("starts as a simple list... bands once volume
-- justifies automation"). security_invoker so these respect the caller's
-- RLS like every other view.
--
-- Balances are a running total (all account sales minus all payments),
-- not per-invoice allocation — a payment isn't linked to which specific
-- sale it settles. "oldest_account_sale_at" is named for what it actually
-- is: the earliest account sale ever logged for that customer, not
-- necessarily still-unpaid — proper invoice-level ageing (§5.2's 30/60/
-- 90/120 bands) needs that allocation, which is a later refinement once
-- volume justifies it, per the Blueprint's own phrasing.
--
-- Grouped by currency, not just customer/supplier: non-negotiable #4
-- means a USD debt and a ZWG debt are never silently combined into one
-- converted figure, the same reasoning as the two separate Cash accounts
-- in the chart of accounts. A payment settles the balance in its own
-- currency only — cross-currency settlement isn't modelled here.
create view customer_balances
  with (security_invoker = true)
as
select
  c.id                                      as customer_id,
  c.tenant_id,
  c.name,
  activity.currency,
  coalesce(activity.sales_amount, 0) - coalesce(payments_total.amount, 0) as balance_owed,
  activity.oldest_account_sale_at
from customers c
join (
  select customer_id, currency, sum(amount) as sales_amount, min(sold_at) as oldest_account_sale_at
  from sales
  where payment_method = 'account'
  group by customer_id, currency
) activity on activity.customer_id = c.id
left join (
  select customer_id, currency, sum(amount) as amount
  from customer_payments
  group by customer_id, currency
) payments_total on payments_total.customer_id = c.id and payments_total.currency = activity.currency;

create view supplier_balances
  with (security_invoker = true)
as
select
  sup.id                                    as supplier_id,
  sup.tenant_id,
  sup.name,
  activity.currency,
  coalesce(activity.purchases_amount, 0) - coalesce(payments_total.amount, 0) as balance_owed,
  activity.oldest_credit_purchase_at
from suppliers sup
join (
  select supplier_id, currency, sum(amount) as purchases_amount, min(purchased_at) as oldest_credit_purchase_at
  from purchases
  where payment_method = 'credit'
  group by supplier_id, currency
) activity on activity.supplier_id = sup.id
left join (
  select supplier_id, currency, sum(amount) as amount
  from supplier_payments
  group by supplier_id, currency
) payments_total on payments_total.supplier_id = sup.id and payments_total.currency = activity.currency;
