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

## Build order

| Phase | Scope | Blueprint sections |
|---|---|---|
| 0 | Tenant/auth scaffolding, RLS | — |
| 1 | Daily Cash Control + manual sales/purchase/expense capture | §2, §3.1, §4.1, §8 |
| 2 | GL engine — auto-posting journals | §3.3, §4.2, §9, §11 |
| 3 | Debtors/creditors, basic inventory | §5, §6 |
| 4 | Reporting — trial balance, P&L, balance sheet | §14, §15 |
| 5 | Compliance calendar + formalization stage | §1.2, §12 |
| 6 | Assets, casual labour, bank reconciliation | §9.1, §10, §11 |
| 7 | Console back-office — cross-client views, approvals | §16 |

Work phase by phase (see `CLAUDE.md` → Build order for the ledger-engine
plan-mode note on Phase 2/3). Reference Blueprint section numbers in
commits, PRs, and code comments.
