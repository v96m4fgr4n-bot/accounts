# Client Accounting System

Multi-tenant accounting/formalization system for cash-heavy, mostly-informal
Zimbabwean SME clients. See `CLAUDE.md` for non-negotiables and build order,
and `docs/erp-blueprint.md` / `docs/client-playbook.md` for the domain spec.

## Stack

- Next.js (App Router) — one repo, two route groups: `/app/client` and
  `/app/console`
- Postgres via Supabase — auth, Row-Level Security for tenant isolation
- Vitest for tests

## Phase 0 — tenant/auth scaffolding + RLS

What's here:

- `supabase/migrations/0001_tenants_and_memberships.sql` — `tenants`,
  `tenant_memberships` (roles: `client_user`, `consultant`), and the
  `is_tenant_member()` helper other tables' policies will call.
- `supabase/migrations/0002_rls_policies.sql` — RLS policies. `tenants` and
  `tenant_memberships` are `force row level security`, select-only for
  authenticated users, scoped to the caller's own memberships. Every
  tenant-scoped table added in later phases must follow this pattern —
  RLS is the actual security boundary (CLAUDE.md non-negotiable #2), not
  the `select('...')` filters in `app/`.
- `lib/supabase/{client,server}.ts`, `middleware.ts` — Supabase auth
  wiring (browser client, server client, session-refresh middleware).
- `app/login`, `app/auth/callback` — magic-link sign-in.
- `app/page.tsx` — routes a signed-in user to `/client` or `/console`
  based on their `tenant_memberships` role.
- `app/client`, `app/console` — placeholder pages that list the tenants
  RLS allows the current user to see.
- `tests/rls-tenant-isolation.test.ts` — the RLS proof: creates two
  tenants and two users via the service-role key, signs in as each user
  with the anon key, and asserts a user can only read their own tenant
  and membership rows (including a direct id lookup for the other
  tenant, and a blocked attempt to insert their way into it).

### Setup

```bash
npm install
cp .env.example .env.local   # fill in Supabase project URL + anon key
```

Apply the migrations to your Supabase project (either via the Supabase CLI
`supabase db push`, or paste the two files into the SQL editor in order).

```bash
npm run dev
```

### Verifying RLS is actually enforced

This is the step CLAUDE.md calls out as non-negotiable — don't skip it.

```bash
SUPABASE_URL=https://<project>.supabase.co \
SUPABASE_ANON_KEY=<anon key> \
SUPABASE_SERVICE_ROLE_KEY=<service role key> \
npm test
```

Without those three env vars the RLS test suite reports as **skipped**,
not passing — a skip here should never be read as confirmation. Run it
against a real (local `supabase start` or disposable test) project before
trusting isolation on this phase.

## Phase 1 — Daily Cash Control + manual sales/purchase/expense capture

What's here:

- `supabase/migrations/0003_daily_cash_control.sql` — `cash_days` (one row
  per tenant/day/currency, per Blueprint §10.3), `sales`, `purchases`,
  `expenses`, all with the shared currency + `exchange_rate_to_usd` shape
  (non-negotiable #4 — rate is required whenever currency isn't USD, and
  is never defaulted). A trigger makes a `cash_days` row immutable once
  `status = 'closed'`, and locks `opening_float`/`trade_date`/`currency`
  even while open — same "correct by reversal, not edit" spirit as
  journal immutability (non-negotiable #6); a proper reopen/correction
  flow arrives with the GL engine in Phase 2. `cash_day_summary` is a
  `security_invoker` view computing §2.3's expected-cash and variance.
  **Note:** §8 Expense Function was pulled into this phase — see the
  build-order note added to `docs/erp-blueprint.md` §8 for why.
- `supabase/migrations/0004_rls_daily_cash_control.sql` — RLS on all four
  tables, insert + select only (no client-side update/delete on raw
  logs, same reasoning as the immutability trigger above).
- `app/client/day` — the actual daily routine: start the day (record
  opening float), log a sale/purchase/expense as it happens, close the
  day (enter the till count, see match/over/short). Copy follows
  `docs/client-playbook.md` — no "debit," "credit," or "journal"
  anywhere in this route.
- `tests/cash-control-invariants.test.ts` — proves a ZWG transaction
  without a rate is rejected, that two ZWG transactions on the same day
  keep independently recorded rates, that `cash_day_summary` computes
  expected cash/variance correctly, and that a closed day (or its
  opening fields) can't be edited afterward. Same skip-without-env-vars
  convention as the RLS suite — run it against a real project, don't
  read a skip as a pass.

Nothing in this phase posts a journal — these are raw logs the GL engine
(Phase 2) will read and post from, per the README's original phased-build
note ("Phase 1 is deliberately the fastest path to something real clients
can use ... backfill journals in Phase 2").

## Phase 2 — GL engine (auto-posting journals)

Design was reviewed in plan mode first, per CLAUDE.md's instruction for this
specific phase. What's here:

- `supabase/migrations/0005_chart_of_accounts.sql` — `accounts` table,
  auto-seeded per tenant (a trigger on `tenants` insert, plus a backfill for
  pre-existing tenants) with exactly the 14 accounts this phase posts to:
  `Cash - USD`, `Cash - ZWG` (kept separate, no forced conversion — §10.3),
  `Inventory`, `Trade Receivables`, `Revenue`, and one `expense_<category>`
  account per Phase 1 expense category.
- `supabase/migrations/0006_gl_engine.sql` — `journal_entries` /
  `journal_lines`, and the posting engine:
  - **Balance is a real DB invariant** (non-negotiable #3): a deferred
    constraint trigger on `journal_lines` sums debits minus credits per
    entry at commit time and rejects anything nonzero.
  - **Immutability is unconditional** (non-negotiable #6): a trigger
    rejects all `UPDATE`/`DELETE` on `journal_entries`/`journal_lines`,
    including from the service role — correction is only ever a new entry
    via `reverse_journal()`, which mirrors the original's lines and guards
    against double-reversal. Restricted to a `consultant` on the entry's
    tenant.
  - **Posting is trigger-based**, not app-level: `AFTER INSERT` triggers on
    `sales`/`purchases`/`expenses` call `SECURITY DEFINER` posting
    functions in the same transaction as the client's insert, so a
    transaction can never exist without its journal (non-negotiable #1).
    A one-time backfill posts journals for any Phase-1 rows that predate
    this migration.
  - **Journals are single-currency** — both legs share the source
    transaction's currency and raw amount (non-negotiable #4: no silent
    conversion). Combined-currency reporting is a Phase 4 concern.
  - RLS here is enabled but **not forced**, unlike Phase 0/1's tenant
    tables: `authenticated` gets `SELECT` only; every write goes through
    the `SECURITY DEFINER` functions (owned by the migration role, which
    bypasses RLS as table owner *because* it isn't forced), and `EXECUTE`
    on those functions is revoked from `public` so they can't be called
    directly via RPC either — only triggers can invoke them. **This
    depends on the Supabase migration role's RLS-bypass-as-owner behavior
    — verify against a real project**, same caveat category as below.
  - Journal patterns actually posted: cash sale → `DR Cash / CR Revenue`;
    account (book credit) sale → `DR Trade Receivables / CR Revenue`;
    purchase → `DR Inventory / CR Cash`; expense → `DR expense account /
    CR Cash`. **Not yet posted** (flagged in `docs/erp-blueprint.md`, not
    silently skipped): the Cost-of-Sales/Inventory-relief leg on a sale
    (needs real per-unit costing, which no phase has shipped yet — see
    the Phase 3 note below), VAT Output (needs Phase 5's VAT-registration
    flag), cash-count variance (§2.4 has no Blueprint journal pattern to
    implement), and §9/§11's payroll/depreciation patterns (no source
    data yet — arrive with Phase 6's capture flows).
- `tests/gl-engine.test.ts` — every posted pattern above, the balance
  trigger rejecting a directly-inserted unbalanced pair, immutability
  rejecting `UPDATE`/`DELETE` even via the service role, and
  `reverse_journal` producing a correctly mirrored entry plus rejecting a
  second reversal of the same original. Requires `SUPABASE_ANON_KEY` too
  (not just service role) since `reverse_journal` checks `auth.uid()`
  internally — same skip-without-env-vars convention as the other suites.

## Phase 3 — Debtors/creditors, basic inventory

What's here:

- `supabase/migrations/0007_debtors_creditors.sql` — `customers`/
  `suppliers` masters (created implicitly by the app the first time it
  looks one up by name and doesn't find it), `customer_payments`/
  `supplier_payments`, and credit purchases (`purchases` gains
  `payment_method`/`supplier_id` — Phase 1 was cash-only). `sales` gains
  `customer_id` alongside its existing free-text `customer_name`, with a
  backfill linking existing 'account' sales. New `accounts_payable` GL
  account, seeded/backfilled the same way as 0005.
- `supabase/migrations/0008_debtors_creditors_gl.sql` — the new journal
  patterns (credit purchase → `DR Inventory / CR Accounts Payable`;
  customer payment → `DR Cash / CR Trade Receivables`; supplier payment →
  `DR Accounts Payable / CR Cash`), and two fixes that came with them:
  - `cash_day_summary` (Phase 1) only summed sales/purchases/expenses —
    customer and supplier payments are real till movements too (book
    credit collected in cash, a supplier paid in cash) and were missing
    from the day's reconciliation. Extended to include both, and to
    exclude credit purchases from `purchases_total` (a credit purchase
    doesn't touch the till until the supplier is actually paid).
  - `customer_balances`/`supplier_balances` — the §5.2 "who owes us/who
    we owe, since when" list. Grouped by currency, not just by customer/
    supplier: a USD debt and a ZWG debt are never silently combined into
    one converted figure (non-negotiable #4), matching the two separate
    Cash accounts already in the chart of accounts. Balances are a
    running total, not per-invoice allocation — proper 30/60/90/120-day
    ageing (§5.2) is a later refinement, per the Blueprint's own framing.
- `supabase/migrations/0009_basic_inventory.sql` — `inventory_items` +
  `stock_counts` (§6.1, §6.2, §6.4), deliberately scoped to an item
  master and dated count snapshots — no perpetual quantity tracking and
  no auto-posted count-adjustment journal. See the §6 note added to
  `docs/erp-blueprint.md` for why (short version: neither has a
  trustworthy source of truth yet without §4.2's line-item POS capture).
- `app/client/debtors`, `app/client/creditors`, `app/client/inventory` —
  client-app pages for recording a customer/supplier payment and logging
  a stock count, linked from `/client`. `app/client/day`'s sale/purchase
  forms gained the account/credit options.
- `tests/debtors-creditors.test.ts` — the three new journal patterns,
  `customer_balances` staying currency-scoped rather than combining a
  USD and ZWG balance, and `cash_day_summary` correctly including
  customer/supplier payments while excluding credit purchases from the
  till. Same skip-without-env-vars convention as the other suites.

## Build order

| Phase | Scope | Blueprint sections |
|---|---|---|
| 0 | Tenant/auth scaffolding, RLS | — |
| 1 | Daily Cash Control + manual sales/purchase/expense capture | §2, §3.1, §4.1, §8 |
| 2 | GL engine — auto-posting journals | §3.3, §4.1/§4.2 (partial), §8 |
| 3 | Debtors/creditors, basic inventory | §5, §6.1, §6.2, §6.4 (partial) |
| 4 | Reporting — trial balance, P&L, balance sheet | §14, §15 |
| 5 | Compliance calendar + formalization stage | §1.2, §12 |
| 6 | Assets, casual labour, bank reconciliation | §9.1, §10, §11 |
| 7 | Console back-office — cross-client views, approvals | §16 |

Work phase by phase (see `CLAUDE.md` → Build order for the ledger-engine
plan-mode note on Phase 2/3). Reference Blueprint section numbers in
commits, PRs, and code comments.
