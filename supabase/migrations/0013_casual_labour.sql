-- Phase 6 (part 1): Casual/Informal Labour Log (Blueprint §9.1).
--
-- Phase 1 modelled casual labour as an ordinary 'casual_labour' expense
-- category (a placeholder, per the note added to §8 in that phase) — the
-- till reconciliation and the GL posting were already correct, but there
-- was no named-worker record. This adds that record without changing
-- the GL treatment: payments still post to the existing
-- expense_casual_labour account, same as any other expense — a worker
-- log is a better-structured capture of the same economic event, not a
-- new one.

create table casual_workers (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete restrict,
  name        text not null,
  created_at  timestamptz not null default now(),

  unique (tenant_id, name)
);

create index casual_workers_tenant_idx on casual_workers (tenant_id);

create table casual_labour_payments (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete restrict,
  worker_id             uuid not null references casual_workers(id) on delete restrict,
  cash_day_id           uuid not null references cash_days(id) on delete restrict,

  paid_at               timestamptz not null default now(),
  description           text not null,
  amount                numeric(14, 2) not null check (amount > 0),
  currency              currency_code not null,
  exchange_rate_to_usd  numeric(14, 6) check (exchange_rate_to_usd > 0),

  recorded_by           uuid not null references auth.users(id),
  created_at            timestamptz not null default now(),

  check (currency = 'USD' or exchange_rate_to_usd is not null)
);

create index casual_labour_payments_worker_idx on casual_labour_payments (worker_id);
create index casual_labour_payments_cash_day_idx on casual_labour_payments (cash_day_id);

alter table casual_workers          enable row level security;
alter table casual_workers          force row level security;
alter table casual_labour_payments  enable row level security;
alter table casual_labour_payments  force row level security;

create policy casual_workers_select_members on casual_workers for select
  to authenticated using (public.is_tenant_member(tenant_id));
create policy casual_workers_insert_members on casual_workers for insert
  to authenticated with check (public.is_tenant_member(tenant_id));

create policy casual_labour_payments_select_members on casual_labour_payments for select
  to authenticated using (public.is_tenant_member(tenant_id));
create policy casual_labour_payments_insert_members on casual_labour_payments for insert
  to authenticated with check (public.is_tenant_member(tenant_id) and recorded_by = auth.uid());

create or replace function public.post_casual_labour_journal(clp casual_labour_payments)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.post_journal(
    clp.tenant_id, clp.paid_at::date, clp.currency, clp.description, 'casual_labour', clp.id,
    'expense_casual_labour',
    case clp.currency when 'USD' then 'cash_usd' else 'cash_zwg' end,
    clp.amount
  );
end;
$$;

revoke all on function public.post_casual_labour_journal(casual_labour_payments) from public;

create or replace function public.casual_labour_payments_post_journal_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.post_casual_labour_journal(new);
  return new;
end;
$$;

revoke all on function public.casual_labour_payments_post_journal_trigger() from public;

create trigger casual_labour_payments_post_journal
  after insert on casual_labour_payments
  for each row execute function public.casual_labour_payments_post_journal_trigger();

alter table journal_entries drop constraint journal_entries_source_type_check;
alter table journal_entries add constraint journal_entries_source_type_check
  check (source_type in (
    'sale', 'purchase', 'expense', 'customer_payment', 'supplier_payment',
    'penalty', 'casual_labour', 'reversal', 'manual'
  ));

-- Till-reconciliation: same shape as expenses — a casual labour payment
-- is cash out today, so it belongs in cash_day_summary alongside them.
-- DROP + CREATE (not CREATE OR REPLACE): see 0008/0012 for why.
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
  coalesce(cl.casual_labour_total, 0)                      as casual_labour_total,
  d.opening_float
    + coalesce(s.cash_sales, 0)
    + coalesce(cp.customer_payments_total, 0)
    - coalesce(p.purchases_total, 0)
    - coalesce(e.expenses_total, 0)
    - coalesce(sp.supplier_payments_total, 0)
    - coalesce(pen.penalties_total, 0)
    - coalesce(cl.casual_labour_total, 0)                  as expected_cash,
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
        - coalesce(cl.casual_labour_total, 0)
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
) pen on pen.cash_day_id = d.id
left join (
  select cash_day_id, sum(amount) as casual_labour_total
  from casual_labour_payments
  group by cash_day_id
) cl on cl.cash_day_id = d.id;

-- Backfill: any casual_labour_payments row that predates this migration
-- (none should exist yet, but matches the established convention).
do $$
declare r casual_labour_payments%rowtype;
begin
  for r in
    select clp.* from casual_labour_payments clp
    where not exists (
      select 1 from journal_entries je
       where je.source_type = 'casual_labour' and je.source_id = clp.id
    )
  loop
    perform public.post_casual_labour_journal(r);
  end loop;
end;
$$;
