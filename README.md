# Client Accounting System — Starter Scaffold

This folder is a starting point for a new repo, meant to be handed to Claude Code
to bootstrap the build.

## What's in here

- `CLAUDE.md` — project context Claude Code reads automatically. Non-negotiables,
  architecture, build order.
- `docs/erp-blueprint.md` — the full functional spec (accounting logic, journal
  patterns, tax/compliance rules).
- `docs/client-playbook.md` — the plain-language client-facing process; use this
  for UI copy and tone in the client app specifically.

## Getting started with Claude Code

1. Create a new repo and copy this folder's contents into it (`CLAUDE.md` at the
   repo root, `docs/` as a subfolder).
2. Open the repo in Claude Code.
3. Start with Phase 0 — ask it to scaffold a Next.js app with Supabase auth and
   a `tenants` table with Row-Level Security, before anything else. Confirm RLS
   is actually enforced (write a quick test that tries to read across tenants)
   before moving on.
4. Work phase by phase (see `CLAUDE.md` → Build order). Reference Blueprint
   section numbers when describing what you want built, e.g.:
   > "Build the Daily Cash Control flow per erp-blueprint.md §2 — opening float,
   > sale logging, end-of-day count and variance."
5. For the ledger engine (Phase 3), use plan mode first. This is the one place
   worth slowing down — review the proposed journal-posting design against the
   patterns in the Blueprint before code gets written.
6. Keep both docs in `docs/` updated as living specs. If a build decision reveals
   a gap (a transaction type the Blueprint doesn't cover, a control that doesn't
   fit a specific client), update the doc, don't just patch around it in code.

## Phased build order

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

Phase 1 is deliberately the fastest path to something real clients can use —
it's usable on its own even before the full ledger engine exists behind it
(store raw logged transactions, backfill journals in Phase 2).
