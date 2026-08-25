-- Phase 6 (part 2): Cash and Bank Function (Blueprint §10.1, §10.2).
--
-- §10.1: not assumed from day one — many clients start entirely in
-- cash, and opening a bank account is itself a formalization milestone.
-- No opening-balance journal is posted when a bank account is added
-- (same reasoning as every other opening-balance deferral since Phase 2
-- — there's still no owner's-equity/capital account to balance it
-- against); opening_balance is recorded as reference data only.

create table bank_accounts (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete restrict,
  bank_name        text not null,
  account_number   text not null,
  currency         currency_code not null,
  opening_balance  numeric(14, 2) not null default 0,
  opened_at        date not null default current_date,
  -- Set by the trigger below immediately after insert — every bank
  -- account gets its own dedicated GL account (not a shared "Bank"
  -- account per currency the way Cash is), so more than one account can
  -- each be reconciled against its own statement independently (§10.2).
  gl_account_id    uuid references accounts(id),
  created_by       uuid not null references auth.users(id),
  created_at       timestamptz not null default now(),

  unique (tenant_id, bank_name, account_number)
);

create index bank_accounts_tenant_idx on bank_accounts (tenant_id);

alter table bank_accounts enable row level security;
alter table bank_accounts force row level security;

create policy bank_accounts_select_members on bank_accounts for select
  to authenticated using (public.is_tenant_member(tenant_id));
create policy bank_accounts_insert_members on bank_accounts for insert
  to authenticated with check (public.is_tenant_member(tenant_id) and created_by = auth.uid());

-- BEFORE INSERT, not AFTER: a BEFORE trigger can set NEW.gl_account_id
-- directly and have that value show up in the INSERT's own RETURNING —
-- an AFTER trigger doing a separate UPDATE on the just-inserted row
-- does NOT retroactively change what that INSERT's RETURNING already
-- returned (learned the hard way: the first version of this used AFTER
-- + UPDATE, and `.insert(...).select('gl_account_id')` came back null
-- even though a follow-up SELECT would have shown it set). new.id is
-- already populated at this point — Postgres applies column DEFAULTs
-- before BEFORE ROW triggers run, so the generated uuid is available
-- to build the account's code from.
create or replace function public.seed_bank_account_gl()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account_id uuid;
begin
  insert into accounts (tenant_id, code, name, account_type)
  values (
    new.tenant_id,
    'bank_' || replace(new.id::text, '-', ''),
    'Bank - ' || new.bank_name || ' (' || right(new.account_number, 4) || ')',
    'asset'
  )
  returning id into v_account_id;

  new.gl_account_id := v_account_id;
  return new;
end;
$$;

revoke all on function public.seed_bank_account_gl() from public;

create trigger bank_accounts_seed_gl
  before insert on bank_accounts
  for each row execute function public.seed_bank_account_gl();

-- A bank deposit (§2.3: "bank cash above the next day's float") moves
-- cash from the till into the bank — a transfer, not a P&L event. Same
-- raw-log shape as every other cash-affecting transaction: tied to a
-- cash_day, insert+select only.
create table bank_deposits (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete restrict,
  bank_account_id       uuid not null references bank_accounts(id) on delete restrict,
  cash_day_id           uuid not null references cash_days(id) on delete restrict,

  deposited_at          timestamptz not null default now(),
  amount                numeric(14, 2) not null check (amount > 0),
  currency              currency_code not null,
  exchange_rate_to_usd  numeric(14, 6) check (exchange_rate_to_usd > 0),

  recorded_by           uuid not null references auth.users(id),
  created_at            timestamptz not null default now(),

  check (currency = 'USD' or exchange_rate_to_usd is not null)
);

create index bank_deposits_bank_account_idx on bank_deposits (bank_account_id);
create index bank_deposits_cash_day_idx on bank_deposits (cash_day_id);

-- A deposit's currency has to match the account it's going into — you
-- can't deposit USD cash straight into a ZWG account without an actual
-- exchange transaction, which isn't what this table models.
create or replace function public.bank_deposits_guard_currency()
returns trigger
language plpgsql
as $$
declare
  v_account_currency currency_code;
begin
  select currency into v_account_currency from bank_accounts where id = new.bank_account_id;
  if v_account_currency is distinct from new.currency then
    raise exception 'bank_deposits: deposit currency (%) must match the bank account''s currency (%)',
      new.currency, v_account_currency;
  end if;
  return new;
end;
$$;

create trigger bank_deposits_guard_currency
  before insert on bank_deposits
  for each row execute function public.bank_deposits_guard_currency();

alter table bank_deposits enable row level security;
alter table bank_deposits force row level security;

create policy bank_deposits_select_members on bank_deposits for select
  to authenticated using (public.is_tenant_member(tenant_id));
create policy bank_deposits_insert_members on bank_deposits for insert
  to authenticated with check (public.is_tenant_member(tenant_id) and recorded_by = auth.uid());

create or replace function public.post_bank_deposit_journal(bd bank_deposits)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bank_code text;
begin
  select code into v_bank_code
    from accounts a join bank_accounts ba on ba.gl_account_id = a.id
   where ba.id = bd.bank_account_id;

  return public.post_journal(
    bd.tenant_id, bd.deposited_at::date, bd.currency, 'Bank deposit', 'bank_deposit', bd.id,
    v_bank_code,
    case bd.currency when 'USD' then 'cash_usd' else 'cash_zwg' end,
    bd.amount
  );
end;
$$;

revoke all on function public.post_bank_deposit_journal(bank_deposits) from public;

create or replace function public.bank_deposits_post_journal_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.post_bank_deposit_journal(new);
  return new;
end;
$$;

revoke all on function public.bank_deposits_post_journal_trigger() from public;

create trigger bank_deposits_post_journal
  after insert on bank_deposits
  for each row execute function public.bank_deposits_post_journal_trigger();

alter table journal_entries drop constraint journal_entries_source_type_check;
alter table journal_entries add constraint journal_entries_source_type_check
  check (source_type in (
    'sale', 'purchase', 'expense', 'customer_payment', 'supplier_payment',
    'penalty', 'casual_labour', 'bank_deposit', 'reversal', 'manual'
  ));

-- The GL-derived balance of a bank account as of a date — the "book"
-- side of §10.2's reconciliation. SECURITY INVOKER (the default): a
-- plain read, subject to the caller's own RLS like the Phase 4
-- reporting functions.
create or replace function public.bank_account_balance(p_bank_account_id uuid, p_as_of date default current_date)
returns numeric
language sql
stable
as $$
  select coalesce(sum(case when jl.side = 'debit' then jl.amount else -jl.amount end), 0)
    from journal_lines jl
    join journal_entries je on je.id = jl.journal_entry_id
    join bank_accounts ba on ba.gl_account_id = jl.account_id
   where ba.id = p_bank_account_id and je.entry_date <= p_as_of;
$$;

revoke all on function public.bank_account_balance(uuid, date) from public;
grant execute on function public.bank_account_balance(uuid, date) to authenticated, service_role;

-- §10.2: bank reconciliations. An attestation record, not a financial
-- posting — "does the bank statement match the books, as of when." Like
-- period_closes/tax_settings, it's insert-only and immutable: a
-- reconciliation done in error is followed by a corrected one, not
-- edited. ledger_balance is computed server-side from the GL at insert
-- time (bank_account_balance as of the statement date), never trusted
-- from the client — that's the whole point of the check.
create table bank_reconciliations (
  id                          uuid primary key default gen_random_uuid(),
  tenant_id                   uuid not null references tenants(id) on delete restrict,
  bank_account_id             uuid not null references bank_accounts(id) on delete restrict,
  statement_date              date not null,
  statement_closing_balance   numeric(14, 2) not null,
  -- Set by the trigger below; any client-supplied value is overwritten.
  ledger_balance              numeric(14, 2),
  note                        text,
  reconciled_by               uuid not null references auth.users(id),
  created_at                  timestamptz not null default now()
);

create index bank_reconciliations_bank_account_idx on bank_reconciliations (bank_account_id, statement_date desc);

create or replace function public.bank_reconciliations_set_ledger_balance()
returns trigger
language plpgsql
as $$
begin
  new.ledger_balance := public.bank_account_balance(new.bank_account_id, new.statement_date);
  return new;
end;
$$;

create trigger bank_reconciliations_set_ledger_balance
  before insert on bank_reconciliations
  for each row execute function public.bank_reconciliations_set_ledger_balance();

create trigger bank_reconciliations_immutable
  before update or delete on bank_reconciliations
  for each row execute function public.journal_immutable();

alter table bank_reconciliations enable row level security;
alter table bank_reconciliations force row level security;

create policy bank_reconciliations_select_members on bank_reconciliations for select
  to authenticated using (public.is_tenant_member(tenant_id));

-- Any tenant member, not consultant-only — §10.2 reads as routine
-- bookkeeping ("match banked cash against the bank statement each
-- period"), the same "jointly" reasoning as compliance_items rather
-- than the consultant-only gate on period_closes/reverse_journal.
create policy bank_reconciliations_insert_members on bank_reconciliations for insert
  to authenticated with check (public.is_tenant_member(tenant_id) and reconciled_by = auth.uid());
