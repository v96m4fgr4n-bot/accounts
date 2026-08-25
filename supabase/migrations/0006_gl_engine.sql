-- Phase 2 (part 2): GL engine — auto-posting journals from the Phase 1
-- raw logs (Blueprint §3.3, §4.1, §8). See docs/erp-blueprint.md for the
-- flagged gaps this migration deliberately does NOT resolve: §9/§11
-- journal patterns (no source data yet), the §4.2 Cost-of-Sales leg (no
-- per-unit costing until Phase 3 — sales here post only cash/
-- receivables + revenue), §2.4 cash-count variance (no Blueprint
-- treatment given), and VAT Output (needs Phase 5's VAT-registration
-- flag).
--
-- Design summary (reviewed in plan mode before this was written):
--   - Journals are single-currency: both legs of a journal share the
--     source transaction's currency and raw amount (non-negotiable #4 —
--     no silent conversion). Cash - USD and Cash - ZWG are separate
--     accounts.
--   - Posting is trigger-based (AFTER INSERT on sales/purchases/
--     expenses), atomic with the source row's insert, so a transaction
--     can never exist without its journal (non-negotiable #1).
--   - Balance is a real DB invariant via a deferred constraint trigger
--     on journal_lines (non-negotiable #3), not just posting-function
--     discipline.
--   - Immutability is a blanket trigger rejecting all UPDATE/DELETE on
--     journal_entries/journal_lines — correction is only ever a new
--     reversing entry (non-negotiable #6).
--   - RLS here is enabled but NOT forced (unlike Phase 0/1's tenant
--     tables): `authenticated` gets SELECT only, no write policy at
--     all. Writes only happen via SECURITY DEFINER functions owned by
--     the migration-running role, which bypass RLS as table owner
--     *because* it isn't forced. This depends on the Supabase
--     migration role not being subject to RLS as table owner — verify
--     against a real project, same caveat category as the RLS/
--     invariant test suites in tests/.

create table journal_entries (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete restrict,
  entry_date   date not null,
  currency     currency_code not null,
  description  text not null,
  source_type  text not null check (source_type in ('sale', 'purchase', 'expense', 'reversal', 'manual')),
  -- id of the sales/purchases/expenses row this was posted from; null
  -- for 'manual' (not used yet) and irrelevant/copied-from-original for
  -- 'reversal' (see reverse_journal below).
  source_id    uuid,
  -- Self-referential: a 'reversal' entry points back at the entry it
  -- reverses. There is no reversed_by column on the original — since
  -- journal_entries is immutable, the original can never be UPDATEd to
  -- record a backlink. "Has this been reversed" is a reverse lookup:
  -- exists(select 1 from journal_entries where reverses = id).
  reverses     uuid references journal_entries(id),
  created_at   timestamptz not null default now()
);

-- Duplicate-posting safety net: a given source row gets at most one
-- (non-reversal) journal entry. Excludes 'reversal' rows — a reversal
-- carries its original's source_id forward for traceability, so
-- reversing a reversal would otherwise collide with this constraint;
-- double-reversal of the same entry is already guarded by the
-- `reverses` check inside reverse_journal().
create unique index journal_entries_source_unique
  on journal_entries (source_type, source_id)
  where source_id is not null and source_type <> 'reversal';

create index journal_entries_tenant_date_idx on journal_entries (tenant_id, entry_date desc);
create index journal_entries_reverses_idx on journal_entries (reverses) where reverses is not null;

create table journal_lines (
  id                uuid primary key default gen_random_uuid(),
  journal_entry_id  uuid not null references journal_entries(id) on delete restrict,
  -- Denormalized alongside journal_entry_id, per CLAUDE.md's "every
  -- tenant-scoped table carries tenant_id" — keeps this table's RLS
  -- policy a direct is_tenant_member(tenant_id) check like every other
  -- table, rather than a join through journal_entries.
  tenant_id         uuid not null references tenants(id) on delete restrict,
  account_id        uuid not null references accounts(id) on delete restrict,
  side              text not null check (side in ('debit', 'credit')),
  amount            numeric(14, 2) not null check (amount > 0)
);

create index journal_lines_entry_idx on journal_lines (journal_entry_id);
create index journal_lines_account_idx on journal_lines (account_id);

-- Balance invariant (non-negotiable #3): every journal_entry's lines
-- must sum to zero (debits minus credits). This is a genuinely
-- multi-row check — a single journal is only "balanced" once both its
-- legs exist — so it has to be a DEFERRABLE constraint trigger,
-- evaluated once per affected row at COMMIT rather than immediately
-- after each individual line insert.
create or replace function public.journal_lines_check_balance()
returns trigger
language plpgsql
as $$
declare
  v_entry_id uuid;
  v_imbalance numeric;
  v_line_count integer;
begin
  v_entry_id := new.journal_entry_id;

  select
    coalesce(sum(case when side = 'debit' then amount else -amount end), 0),
    count(*)
    into v_imbalance, v_line_count
    from journal_lines
   where journal_entry_id = v_entry_id;

  if v_imbalance <> 0 then
    raise exception 'journal_entry %: unbalanced (debits minus credits = %)', v_entry_id, v_imbalance;
  end if;
  if v_line_count < 2 then
    raise exception 'journal_entry %: needs at least 2 lines, has %', v_entry_id, v_line_count;
  end if;

  return null;
end;
$$;

-- INSERT only: journal_lines is made immutable below (BEFORE UPDATE OR
-- DELETE is rejected outright), so there is no UPDATE/DELETE path for
-- this trigger to ever need to re-check.
create constraint trigger journal_lines_check_balance
  after insert on journal_lines
  deferrable initially deferred
  for each row
  execute function public.journal_lines_check_balance();

-- Immutability (non-negotiable #6): once posted, a journal entry and
-- its lines cannot be edited or removed by anyone — correction is
-- always a new reversing entry via reverse_journal() below. Applies
-- regardless of role, so this holds even against direct/service-role
-- access, not just what RLS allows the app to do.
create or replace function public.journal_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception '%.% is immutable; correct it with a reversing journal entry, not %', tg_table_name, old.id, tg_op;
end;
$$;

create trigger journal_entries_immutable
  before update or delete on journal_entries
  for each row execute function public.journal_immutable();

create trigger journal_lines_immutable
  before update or delete on journal_lines
  for each row execute function public.journal_immutable();

-- Looks up a tenant's account by its stable code (see 0005). Returns
-- null if missing, which post_journal turns into a clear error rather
-- than a confusing FK-violation.
create or replace function public.get_tenant_account(p_tenant_id uuid, p_code text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id from accounts where tenant_id = p_tenant_id and code = p_code;
$$;

revoke all on function public.get_tenant_account(uuid, text) from public;

-- Shared 2-line posting primitive. Every Phase 2 journal pattern is a
-- simple debit/credit pair (see docs/erp-blueprint.md for why COGS/
-- Inventory-relief and VAT legs aren't posted yet) so one primitive
-- covers sales, purchases, and expenses without a generalized N-line
-- posting API nothing needs yet.
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

revoke all on function public.post_journal(uuid, date, currency_code, text, text, uuid, text, text, numeric) from public;

-- Pattern-selection logic lives in plain (non-trigger) functions, each
-- taking the source row directly, so the AFTER INSERT triggers below
-- and the one-time backfill at the end of this file call exactly the
-- same implementation — no duplicated branching to drift out of sync.

create or replace function public.post_sale_journal(s sales)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- §4.1/§5.1: cash sales hit the till directly; "account" sales are
  -- informal book credit (Trade Receivables) until Debtors (Phase 3)
  -- adds proper per-customer tracking. No Cost-of-Sales/Inventory-relief
  -- leg yet — see the migration header note.
  if s.payment_method = 'cash' then
    return public.post_journal(
      s.tenant_id, s.sold_at::date, s.currency, s.description, 'sale', s.id,
      case s.currency when 'USD' then 'cash_usd' else 'cash_zwg' end,
      'revenue',
      s.amount
    );
  else
    return public.post_journal(
      s.tenant_id, s.sold_at::date, s.currency, s.description, 'sale', s.id,
      'trade_receivables',
      'revenue',
      s.amount
    );
  end if;
end;
$$;

revoke all on function public.post_sale_journal(sales) from public;

create or replace function public.post_purchase_journal(p purchases)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- §3.1/§3.3: Phase 1 purchases are cash-only (no credit-supplier
  -- capture yet), so Cash is always the credit leg.
  return public.post_journal(
    p.tenant_id, p.purchased_at::date, p.currency, p.description, 'purchase', p.id,
    'inventory',
    case p.currency when 'USD' then 'cash_usd' else 'cash_zwg' end,
    p.amount
  );
end;
$$;

revoke all on function public.post_purchase_journal(purchases) from public;

create or replace function public.post_expense_journal(e expenses)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- §8: category maps 1:1 to its expense account by construction
  -- ('expense_' || category — see 0005's seed list), so no case
  -- statement is needed here.
  return public.post_journal(
    e.tenant_id, e.paid_at::date, e.currency, e.description, 'expense', e.id,
    'expense_' || e.category,
    case e.currency when 'USD' then 'cash_usd' else 'cash_zwg' end,
    e.amount
  );
end;
$$;

revoke all on function public.post_expense_journal(expenses) from public;

create or replace function public.sales_post_journal_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.post_sale_journal(new);
  return new;
end;
$$;

revoke all on function public.sales_post_journal_trigger() from public;

create trigger sales_post_journal
  after insert on sales
  for each row execute function public.sales_post_journal_trigger();

create or replace function public.purchases_post_journal_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.post_purchase_journal(new);
  return new;
end;
$$;

revoke all on function public.purchases_post_journal_trigger() from public;

create trigger purchases_post_journal
  after insert on purchases
  for each row execute function public.purchases_post_journal_trigger();

create or replace function public.expenses_post_journal_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.post_expense_journal(new);
  return new;
end;
$$;

revoke all on function public.expenses_post_journal_trigger() from public;

create trigger expenses_post_journal
  after insert on expenses
  for each row execute function public.expenses_post_journal_trigger();

-- Backfill: any sales/purchases/expenses row that predates this
-- migration (Phase 1 shipped before the GL engine existed) gets posted
-- now, per the README's original phased-build note ("backfill journals
-- in Phase 2"). Idempotent — skips rows that already have a journal —
-- so it's safe to rerun.
do $$
declare r sales%rowtype;
begin
  for r in
    select s.* from sales s
    where not exists (
      select 1 from journal_entries je
       where je.source_type = 'sale' and je.source_id = s.id
    )
  loop
    perform public.post_sale_journal(r);
  end loop;
end;
$$;

do $$
declare r purchases%rowtype;
begin
  for r in
    select p.* from purchases p
    where not exists (
      select 1 from journal_entries je
       where je.source_type = 'purchase' and je.source_id = p.id
    )
  loop
    perform public.post_purchase_journal(r);
  end loop;
end;
$$;

do $$
declare r expenses%rowtype;
begin
  for r in
    select e.* from expenses e
    where not exists (
      select 1 from journal_entries je
       where je.source_type = 'expense' and je.source_id = e.id
    )
  loop
    perform public.post_expense_journal(r);
  end loop;
end;
$$;

-- Reversal (non-negotiable #6). No console UI calls this yet (that
-- lands with GL review in Phase 7) but the engine-level capability and
-- its test coverage belong here per CLAUDE.md's ledger-engine testing
-- priorities. Restricted to a consultant on the entry's own tenant,
-- checked inside the function since GRANT alone can't express
-- per-tenant, per-role authorization.
create or replace function public.reverse_journal(p_journal_entry_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_original journal_entries%rowtype;
  v_new_id uuid;
begin
  select * into v_original from journal_entries where id = p_journal_entry_id;
  if not found then
    raise exception 'reverse_journal: journal entry % not found', p_journal_entry_id;
  end if;

  if not exists (
    select 1 from tenant_memberships
     where tenant_id = v_original.tenant_id
       and user_id = auth.uid()
       and role = 'consultant'
  ) then
    raise exception 'reverse_journal: only a consultant for this tenant may reverse a journal entry';
  end if;

  if exists (select 1 from journal_entries where reverses = p_journal_entry_id) then
    raise exception 'reverse_journal: journal entry % has already been reversed', p_journal_entry_id;
  end if;

  insert into journal_entries (tenant_id, entry_date, currency, description, source_type, source_id, reverses)
  values (
    v_original.tenant_id,
    current_date,
    v_original.currency,
    'Reversal of ' || v_original.description || coalesce(' — ' || nullif(p_reason, ''), ''),
    'reversal',
    v_original.source_id,
    v_original.id
  )
  returning id into v_new_id;

  insert into journal_lines (journal_entry_id, tenant_id, account_id, side, amount)
  select v_new_id, tenant_id, account_id,
         case side when 'debit' then 'credit' else 'debit' end,
         amount
    from journal_lines
   where journal_entry_id = v_original.id;

  return v_new_id;
end;
$$;

revoke all on function public.reverse_journal(uuid, text) from public;
grant execute on function public.reverse_journal(uuid, text) to authenticated;

-- Not forced, unlike Phase 0/1's tenant tables — see the migration
-- header note for why: authenticated gets SELECT only, and every write
-- comes from the SECURITY DEFINER functions above via table-owner RLS
-- bypass.
alter table journal_entries enable row level security;
alter table journal_lines   enable row level security;

create policy journal_entries_select_members
  on journal_entries for select
  to authenticated
  using (public.is_tenant_member(tenant_id));

create policy journal_lines_select_members
  on journal_lines for select
  to authenticated
  using (public.is_tenant_member(tenant_id));
