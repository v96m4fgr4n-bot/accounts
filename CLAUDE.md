# Project: [Consultancy Name] Client Accounting System

Multi-tenant accounting/formalization system for small, cash-heavy, mostly-informal
Zimbabwean SME clients (clothing stores, hardware shops, tuckshops, and similar).
Two surfaces on one backend: a lightweight client-facing capture app, and an
internal back-office for the consulting team across all clients.

**Read `docs/erp-blueprint.md` and `docs/client-playbook.md` before building any
feature.** They are the domain spec — reference them by section number in commits,
PRs, and code comments (e.g. "implements Blueprint §2.3"). They are living
documents: if a build decision reveals a gap or contradiction in the spec, flag it
and update the doc rather than silently diverging from it.

## Non-negotiables

1. **Every simplified client action posts a real double-entry journal.** A client
   never sees a debit or credit — they log "sold 3 shirts, $45, cash." The system
   translates that into the exact journal patterns given in `erp-blueprint.md`
   (Sections 3–4, 8, 10–11). Never take a shortcut that skips proper journal
   posting for the sake of a simpler client-side flow — the reports downstream
   depend on this being right every time, not just usually.
2. **Multi-tenant isolation is enforced at the database layer, not just in
   application code.** Every tenant-scoped table carries `tenant_id`. Use Postgres
   Row-Level Security policies as the actual boundary — a bug in a Next.js route
   must not be able to leak one client's data into another's. Application-level
   `WHERE tenant_id = ...` filtering is a performance nicety, not the security
   control.
3. **Debits must always equal credits.** Any code path that can post an unbalanced
   journal is a bug, full stop. Cover this with tests before building features on
   top of the ledger engine.
4. **Currency and rate are recorded per transaction, not assumed.** Clients
   transact in both USD and ZWG, often at a rate agreed on the spot. Never default
   silently to "the official rate" — store what was actually used.
5. **Tax/compliance figures (thresholds, rates, due dates) are configurable data,
   never hard-coded constants.** These change; see `erp-blueprint.md` §12.2 for
   why. Store them in a settings table the consulting team can update, with an
   effective-date so historical filings still show the rate that applied then.
6. **Journals are corrected by reversal, not deletion.** Once posted, a journal
   entry is immutable. Fixing a mistake means posting an offsetting entry and a
   new correct one, both linked to the original — this preserves the audit trail
   the whole system exists to provide.

## Two surfaces, one backend

- **Client app** (`/app/client/*`) — mobile-first PWA. Scope: Daily Cash Control
  (Blueprint §2), manual sales/purchase logging (§3.1, §4.1), book credit (§5.1),
  casual labour log (§9.1). Deliberately minimal — big buttons, offline-tolerant,
  no accounting jargon (mirror `client-playbook.md` language exactly in UI copy).
- **Console app** (`/app/console/*`) — internal, used by the consulting team.
  Cross-client dashboard, GL/journal review, stock count sign-off, financial
  statements, compliance calendar across every client, approval-threshold config
  per client (Blueprint §16).

## Stack

- Next.js (App Router), one repo, two route groups above
- Postgres via Supabase — auth, storage (receipt photos), Row-Level Security for
  tenant isolation
- Two roles at minimum: `client_user` (own tenant only), `consultant` (assigned
  tenants, cross-client views in the console)

## Build order (see README.md for detail)

1. Tenant/auth scaffolding + RLS policies
2. Daily Cash Control + manual sales/purchase capture
3. GL engine — auto-posting journals from logged transactions
4. Debtors/creditors, basic inventory
5. Reporting — trial balance, P&L, balance sheet
6. Compliance calendar + formalization stage tracking
7. Assets, casual labour, bank reconciliation
8. Console back-office — cross-client views, approvals

Build and review one phase at a time. Use plan mode before writing the ledger
engine (phase 3) specifically — get the journal-posting design reviewed before
code, since everything downstream depends on it being right.

## Testing priorities

- Ledger engine: debits-equal-credits invariant, every journal pattern in the
  Blueprint has a test case, reversal/correction flow
- RLS policies: a test tenant cannot read/write another tenant's rows, even via
  a crafted request
- Currency handling: transactions retain their recorded rate independent of
  later rate changes
