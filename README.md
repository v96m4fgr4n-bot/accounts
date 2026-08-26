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
`supabase db push`, or paste the files into the SQL editor in order).

```bash
npm run dev
```

### Running against a real Supabase project

Every test suite in `tests/` reports as **skipped**, not passing, unless
`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` are set —
a skip should never be read as confirmation. This project has been verified
end-to-end against a real local Postgres via the Supabase CLI (see below);
do the same before trusting any phase, especially after a schema change.

```bash
npx supabase init          # once, if supabase/config.toml doesn't exist yet
npx supabase start -x studio,imgproxy,logflare,vector,realtime,storage-api,edge-runtime,mailpit,supavisor,postgres-meta
```

The `-x` exclusions skip services this project's tests don't need
(dashboard, image proxy, log aggregation, realtime, file storage, edge
functions, local email capture, connection pooler, `postgres-meta`),
which keeps first-run image pulls to just `postgres`, `gotrue`, `postgrest`,
and `kong` — meaningfully faster and lighter than the full stack. `start`
prints `API_URL`, `ANON_KEY`, and `SERVICE_ROLE_KEY` — export those as
`SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` and run:

```bash
npm test
```

**Test data is never cleaned up, by design, and that's expected.** Every
tenant gets its chart of accounts the moment it's created
(`seed_default_accounts`, 0005), and `accounts.tenant_id` is `ON DELETE
RESTRICT` — a tenant's history can't be silently deleted, test tenants
included, and journal rows are separately immutable regardless of role
(non-negotiable #6). The suites generate a random per-run suffix for
emails/tenant names specifically so repeat runs against the same project
never collide — but data still accumulates. Treat the project you're
testing against as disposable: reset a local stack between real test
passes (`npx supabase stop --no-backup && npx supabase start -x ...`), or
use a throwaway hosted project, never a project carrying real client data.

**What actually got caught by running this for real** (fixed, not just
noted): `cash_day_summary`'s `CREATE OR REPLACE VIEW` failed outright —
Postgres only allows `REPLACE` to append new output columns at the end,
not insert one ahead of existing ones, which is exactly what adding
`customer_payments_total` did; fixed by `DROP VIEW` + `CREATE VIEW`
instead (0008). Every table from Phase 0 onward was missing the base SQL
`GRANT`s that make RLS policies reachable at all — `anon`/`authenticated`/
`service_role` had zero privileges on any table because no migration ever
granted them and this local stack doesn't set that up implicitly the way
some hosted-project assumptions expect; fixed with explicit `GRANT`s plus
`ALTER DEFAULT PRIVILEGES` for future tables (0010) — this also positively
confirmed the Phase 2 GL engine's RLS-bypass-as-table-owner design
actually works once the base grants exist (`service_role` has
`BYPASSRLS` directly, confirmed via `pg_roles`). Also caught: a handful of
test-assertion bugs (expected debit/credit row order didn't match the
tests' own `.order('side')` query — 'credit' sorts before 'debit'
alphabetically; and `tests/gl-engine.test.ts`'s account-sale test predated
Phase 3's `customer_id` requirement).

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
    directly via RPC either — only triggers can invoke them. **Confirmed
    against a real local Supabase stack** (see "Running against a real
    Supabase project" below) — `service_role` actually has the
    `BYPASSRLS` role attribute directly (`pg_roles`), so this works
    regardless of forced/not-forced once the base table `GRANT`s exist
    (0010 — those were missing everywhere until verified for real).
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

## Phase 4 — Reporting (trial balance, P&L, balance sheet) + period close

What's here:

- `supabase/migrations/0011_reporting_and_period_close.sql`:
  - `trial_balance(tenant, as_of)`, `income_statement(tenant, from, to)`,
    `balance_sheet(tenant, as_of)` — `SECURITY INVOKER` SQL functions
    (not `SECURITY DEFINER` — nothing here needs elevated privilege, so
    they're subject to the caller's own RLS on `accounts`/
    `journal_entries`/`journal_lines` exactly like a plain `SELECT`
    would be; asking for a tenant you're not a member of just comes back
    empty). All three are grouped by currency, not combined — see the
    §15 note added to `docs/erp-blueprint.md`. The trial balance's
    `debit_balance`/`credit_balance` columns are netted per account so
    their column totals are equal *within each currency*, the
    report-level demonstration of non-negotiable #3. The balance sheet's
    equity side is a single derived "Retained Earnings" row per
    currency (cumulative revenue minus expense to date) rather than a
    stored account — there's no owner's-equity/capital account yet.
  - `period_closes` (§14's "closed periods can't be posted to without
    owner authorization") — insert-only, one row per close, `closed_by`
    must be a consultant on the tenant (RLS), and a trigger rejects
    closing to an earlier-or-equal date than the tenant's current
    watermark (extend forward only, never "unclose"). Immutable once
    created, reusing `journal_immutable()` from Phase 2.
  - `post_journal` (Phase 2) gains a period-lock check: posting into a
    closed period is rejected unless the acting user (`auth.uid()`,
    resolved from the JWT regardless of `post_journal`'s own
    `SECURITY DEFINER` context) is a consultant on that tenant. Applies
    uniformly to every journal pattern through the one shared primitive.
    `reverse_journal` is unaffected — it always posts as of today.
- `app/console/reports` — tenant picker, the three reports with
  date/range controls, and a close-period form. This is console-only
  (not `/app/client`), per CLAUDE.md's own surface split — reviewing
  financial statements is consulting-team work, not part of the client's
  daily routine.
- `tests/reporting-and-period-close.test.ts` — the trial balance's
  columns summing equal per currency, the income statement and balance
  sheet staying currency-scoped (posts both a USD and a ZWG sale and
  checks neither report combines them), the balance sheet actually
  balancing per currency via the derived Retained Earnings line, the
  period-close monotonic/immutable/consultant-only guards, and a closed
  period blocking a client_user's posting while allowing a consultant's.
  Needs `SUPABASE_ANON_KEY` too, same reason as `reverse_journal`'s test
  in Phase 2 — the authorization check reads `auth.uid()`, which is null
  under the service-role key.

**Bugs this phase's real-Supabase verification pass caught before they
shipped:** the three reporting functions initially had `EXECUTE` granted
only to `authenticated`, not `service_role` — a separate SQL-level grant
from RLS bypass, easy to assume `service_role` gets "everything" when it
doesn't; fixed by granting both. And the first draft of these functions
aggregated accounts across currencies exactly like `customer_balances`
originally did in Phase 3, caught this time before it ever got as far as
a test run.

## Phase 5 — Compliance calendar + formalization stage

What's here:

- `supabase/migrations/0012_compliance.sql`:
  - `tenants.vat_registered` — a real flag now, separate from
    `formalization_stage` (a "registered" tenant may still be below the
    VAT threshold), with a check constraint keeping that ordering honest.
    `tenants` had no `UPDATE` policy at all before this (tenant lifecycle
    was deliberately left to Phase 7) — rather than opening the whole
    row, 0010's blanket `authenticated` grant is revoked for just this
    table and re-granted on exactly the two columns a compliance
    workflow touches (`formalization_stage`, `vat_registered`), via
    Postgres column-level `GRANT`. `name`/`id`/etc. stay unreachable
    until Phase 7 defines that workflow properly.
  - `tax_settings` — non-negotiable #5's configurable, effective-dated
    figures (e.g. the VAT threshold). Global, not tenant-scoped (a
    national rule, not a per-client setting); insert-only and
    consultant-gated, immutable once recorded (reuses
    `journal_immutable()`) — a wrong figure gets corrected by recording
    the right one with its own effective-date, not by editing history.
    `current_tax_setting(key, as_of)` resolves the value in effect for a
    date.
  - `compliance_items` — the §12.4 calendar (council licence renewals
    share this table too — same shape, different `obligation_type`).
    Unlike the immutable financial tables, status is a real mutable
    workflow (`not_started → prepared → filed → confirmed`) any tenant
    member can progress, matching §16's "owner or consulting team,
    jointly" — not gated to consultants the way `period_closes`/
    `reverse_journal` are.
  - `compliance_penalties` — §12.5's "logged on its own, separate from
    ordinary expenses." Same raw-log shape as Phase 1 (tied to a
    `cash_day`, insert+select only), posts `DR Penalties Expense / CR
    Cash`, and — the same till-reconciliation fix pattern as Phase 3 —
    `cash_day_summary` now includes it in the day's cash-out total.
- `app/console/compliance` — tenant picker, formalization/VAT toggle,
  the compliance calendar (add + update status, overdue items flagged),
  tax settings (view + record a new effective-dated figure), and a
  log-a-penalty form. Console-only, same reasoning as reports in Phase 4.
- `tests/compliance.test.ts` — `tax_settings` consultant-only and
  immutable, `current_tax_setting` resolving the right effective value,
  any tenant member progressing a compliance item, the `tenants` column-
  level grant actually restricting to just the two intended columns (a
  same-request attempt to also rename the tenant is rejected outright),
  the VAT-requires-formalized check constraint, and a penalty's journal
  plus its appearance in `cash_day_summary`.

**Deliberately not built this phase, flagged in `docs/erp-blueprint.md`
rather than silently skipped:** VAT Output still isn't posted on sales
(needs a VAT-inclusive/exclusive decision and changes existing Phase 2
posting behavior — its own focused pass, not a side effect of this one);
rolling 12-month turnover tracking (§12.2) follows once VAT posting
exists; and compliance items are entered manually, not auto-generated on
a recurring schedule — matches the Blueprint's own cash-first framing.

**Another real bug caught by actually running this against Postgres:**
`cash_day_summary`'s `CREATE OR REPLACE VIEW` failed with "relation
already exists" — this is the same DROP-vs-REPLACE lesson from Phase 3
(0008), just missed again in this migration's first draft. Fixed the
same way: `DROP VIEW` before `CREATE VIEW`.

## Phase 6 — Assets, casual labour, bank reconciliation

What's here:

- `supabase/migrations/0013_casual_labour.sql` — `casual_workers` +
  `casual_labour_payments` (§9.1), a proper named-worker log replacing
  Phase 1's generic `casual_labour` expense-category placeholder — same
  GL treatment (`expense_casual_labour`), just better-structured
  capture. `cash_day_summary` extended again for the till impact.
- `supabase/migrations/0014_bank_accounts.sql` — `bank_accounts` (§10.1),
  each auto-seeding its own dedicated GL account (not a shared "Bank"
  account per currency the way Cash is — supports reconciling more than
  one account independently); `bank_deposits` (§2.3's "bank cash above
  the next day's float," a till-to-bank transfer, currency-checked
  against the receiving account); `bank_account_balance(account, as_of)`
  reporting function; `bank_reconciliations` (§10.2) — an attestation
  record, not a posting, with `ledger_balance` always computed
  server-side from the GL rather than trusted from client input.
- `supabase/migrations/0015_assets.sql` — `assets` register (§11.1, pure
  master data, no acquisition journal — matches the opening-snapshot
  framing already used for bank opening balances); `run_asset_depreciation`
  (manually-triggered straight-line, capped at remaining book value,
  one `asset_depreciation_runs` row per run so each gets its own
  journal `source_id`); `dispose_asset` (§11.2, a 2–4 line entry
  covering cost removal, accumulated depreciation removal, proceeds,
  and any gain/loss, built directly rather than forced into
  `post_journal`'s fixed pair). The period-lock check from Phase 4 was
  pulled out of `post_journal` into its own `check_period_open()`
  function so `dispose_asset` (which doesn't go through `post_journal`)
  enforces it too, rather than silently skipping it.
- `app/client/labour` — log a casual labour payment (worker created
  implicitly by name, same pattern as customers/suppliers).
  `app/console/banking` and `app/console/assets` — bank accounts,
  deposits, reconciliation history; the asset register with per-row
  depreciate/dispose actions. Console-only, same reasoning as reports
  and compliance.
- `tests/assets-labour-banking.test.ts` — casual labour's journal and
  till impact; a bank account's auto-seeded GL account and the
  currency-mismatch guard; `bank_reconciliations` ignoring a
  client-supplied `ledger_balance` in favor of the real one, and its
  immutability; depreciation's straight-line math, double-posting guard,
  and full-depreciation cap; and disposal balancing correctly across a
  gain, a loss, and a break-even case — including the exact edge case
  (disposing before any depreciation has run) that exposed a real bug
  during development.

**Deliberately not built, flagged in `docs/erp-blueprint.md` rather than
silently skipped:** §9.2 formal payroll (needs configurable statutory-
deduction rates, an employee master, and payslip generation — a build of
comparable size to Phase 5 in its own right).

**Bugs this phase's real-Supabase verification pass caught before they
shipped, on top of the design-time fix already described above** (a
zero-amount journal line when disposing an asset with no depreciation
posted yet — found by manually working through the accounting identity
before ever running the code):
- `run_asset_depreciation`/`dispose_asset` initially granted `EXECUTE`
  only to `authenticated`, not `service_role` — the same mistake as
  Phase 4's reporting functions, now on new functions.
- `bank_accounts`' GL-account-seeding trigger was originally `AFTER
  INSERT` + a separate `UPDATE` — which meant `INSERT ... RETURNING`
  (and therefore `.insert(...).select(...)` in the app) came back with
  `gl_account_id` still `null`, even though a follow-up `SELECT` would
  have shown it set. `RETURNING` reflects `BEFORE` trigger changes to
  `NEW`, not a later `AFTER` trigger's separate statement on the same
  row. Fixed by moving the trigger to `BEFORE INSERT` and setting
  `NEW.gl_account_id` directly instead.
- Several test assertions again expected debit-before-credit row order,
  which doesn't match the tests' own `.order('side')` query — the same
  recurring mistake as Phases 3 and 4.

## Phase 7 — Console back-office: cross-client dashboard, journal review, approvals

What's here:

- `supabase/migrations/0016_approvals.sql` — `approval_thresholds`
  (per-tenant, per-decision-type, per-currency dollar figure a
  consultant sets; mutable, unlike `tax_settings`/`period_closes`, via a
  `BEFORE UPDATE` trigger that overwrites `updated_by`/`updated_at`
  regardless of client input — a threshold is current-state config, not
  an audit-trail figure). `needs_approval`/`approved_by`/`approved_at`
  added to `purchases`, `supplier_payments`, `casual_labour_payments`,
  set once at insert time by a `BEFORE INSERT` trigger per table that
  compares the new row's amount against the matching threshold (credit
  purchases only — a cash purchase never flags). `signed_off_by`/
  `signed_off_at` added to `stock_counts`, unconditional (no threshold —
  see the §16 note in `docs/erp-blueprint.md` for why). All four
  approve/sign-off columns use the same column-level-GRANT pattern as
  Phase 5's `tenants.formalization_stage`: the table's blanket
  `authenticated` UPDATE grant is revoked and re-granted on exactly the
  two columns, paired with an RLS policy that requires both a consultant
  membership and `approved_by = auth.uid()` (or `signed_off_by =
  auth.uid()`) — a consultant can clear a flag but can't record someone
  else as the approver, and can't touch any other column in the same
  request.
- `app/console/page.tsx` — rebuilt from a bare tenant list into an actual
  cross-client dashboard: per-client today's cash-day status, a count of
  pending approvals, unsigned stock counts, and overdue compliance
  items, each linking straight into the relevant console page.
- `app/console/journal/page.tsx` — browse `journal_entries`/
  `journal_lines` for a tenant over a date range, each entry showing its
  full debit/credit breakdown; a consultant can reverse any
  non-reversal, not-yet-reversed entry inline (`reverse_journal`, built
  in Phase 2, had no UI caller until now).
- `app/console/approvals/page.tsx` — per-tenant threshold configuration
  form (one row per decision type × currency) plus the flagged-item
  review queue across all three approval-matrix tables and the
  stock-count sign-off queue, each with an approve/sign-off action.
- `tests/approvals.test.ts` — threshold-based flagging (over flags,
  at-threshold and cash purchases never flag, an unconfigured currency
  never flags); the approval_thresholds insert/update RLS split (insert
  requires the caller's own id, update's trigger overwrites regardless
  of input); and the approve/sign-off column-grant shape on all four
  columns — a client_user is refused outright, a consultant can't name
  another consultant as approver/signer, and can't smuggle an unrelated
  column through the same update.

**Deliberately not built:** the UI-design-prompt / visual-mockup request
raised mid-Phase-7 was explicitly deferred by the user in favor of
finishing this phase first — still open, not abandoned.

**Bugs this phase's real-Supabase verification pass caught:** none in
the migration itself — `0016_approvals.sql` applied cleanly and every
RLS/trigger check behaved as designed on the first run. The bug was in
the *test*: `approval_thresholds_touch_updated_at` only fires `BEFORE
UPDATE`, not `BEFORE INSERT`, so an insert's `updated_by` is enforced by
the RLS policy's `with check` alone (the caller must submit their own
id) rather than being normalized by a trigger the way an update's is.
The first test draft assumed insert-time normalization too, sent a
lying `updated_by` to check it got overwritten, and instead got a
genuine RLS rejection — which aborted the rest of that test before it
could seed the `supplier_payment`/`casual_labour` thresholds the next
two tests depended on, so all three failed together. Fixed by sending
the caller's real id on insert and adding a separate assertion — on an
`UPDATE` — that the trigger does overwrite a lying `updated_by` there.

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
