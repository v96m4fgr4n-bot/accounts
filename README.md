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

## Build order

| Phase | Scope | Blueprint sections |
|---|---|---|
| 0 | Tenant/auth scaffolding, RLS | — |
| 1 | Daily Cash Control + manual sales/purchase capture | §2, §3.1, §4.1 |
| 2 | GL engine — auto-posting journals | §3.3, §4.2, §9, §11 |
| 3 | Debtors/creditors, basic inventory | §5, §6 |
| 4 | Reporting — trial balance, P&L, balance sheet | §14, §15 |
| 5 | Compliance calendar + formalization stage | §1.2, §12 |
| 6 | Assets, casual labour, bank reconciliation | §9.1, §10, §11 |
| 7 | Console back-office — cross-client views, approvals | §16 |

Work phase by phase (see `CLAUDE.md` → Build order for the ledger-engine
plan-mode note on Phase 2/3). Reference Blueprint section numbers in
commits, PRs, and code comments.
