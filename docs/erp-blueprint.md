# ERP System Blueprint

*Functional Specification — for cash-heavy, informal-economy SMEs (Zimbabwe)*
Draft v4 — living document, update as the build progresses.

## 0. Purpose & Scope

This document specifies the accounting system for the SMEs this consultancy actually serves: clothing stores, hardware shops, tuckshops, and similar businesses in Zimbabwe's informal economy. These businesses generate meaningful revenue but have no formal system, trade mostly in cash, run with one to three people including the owner, and may not yet be registered with ZIMRA.

Two defaults run through this entire document and the system built from it:

- **Cash-first, not system-first.** Every function must work from a manual, paper-or-phone starting point before any digital tool is introduced. Automation layers on top once it earns its keep — it's never the assumed entry point.
- **Controls sized to a one-to-three-person team.** Classic segregation of duties (a different person raises vs. approves) assumes staff most of these businesses don't have. Every control states both the ideal (as the business grows) and the compensating control for a solo owner.

Traceability goal: every number on the financial statements is traceable down to its original source transaction, and vice versa — for this client base, the "source transaction" often starts as a handwritten cash log, not a system entry.

```
Financial Statement → Trial Balance → GL Account → Journal → Daily Cash/Sales Log → Original Transaction
```

## 1. Formalization & Onboarding Journey

### 1.1 Starting Position
No existing records assumed. Onboarding = a snapshot, not a migration:
- Physical stock count (quantity + estimated cost) → opening inventory
- Cash on hand + any bank balance on the day
- Equipment/fixtures owned
- What's owed to suppliers, and what customers owe (including informal "book credit")

This snapshot becomes the opening trial balance.

### 1.2 Formalization Stage
Record where each client currently sits — drives which tax/compliance features are active (Section 12):

| Stage | Typical Position |
|---|---|
| Unregistered | No ZIMRA TIN; no formal tax obligations beyond local council/vendor licensing |
| Presumptive tax | Registered informally or paying flat presumptive tax, without full books of account |
| Formally registered | Holds a TIN, may be VAT-registered, filing standard returns |

> **Note:** Zimbabwe's informal-sector rules change often (VAT threshold, presumptive tax, council-licence-tied-to-compliance push). Don't hard-code current thresholds/rates in the system as constants — store them as configurable values the consulting team can update, and confirm current figures with ZIMRA / a registered tax practitioner at onboarding and each renewal.

### 1.3 System Configuration Checklist
- Chart of accounts finalized (Section 13)
- Formalization stage recorded, relevant tax features toggled
- Approval workflow set for actual team size (Section 16)
- Daily cash control process agreed (Section 2)
- Bank account linked, if one exists

### 1.4 Staff Training & Handover
Built for an owner-operator: one short hands-on session on the daily cash routine, written sign-off, named support contact for the first month.

## 2. Daily Cash Control — the core module

The most important function in the system for this client base.

### 2.1 Opening Float
Counted, recorded float at the start of each trading day.

### 2.2 Recording Sales During the Day
Every sale logged at time of sale: item/category, amount, cash or credit.

### 2.3 End-of-Day Cash Count & Banking
1. Count all cash in the till at close.
2. Compare to: opening float + cash sales logged − cash paid out during the day.
3. Record the result: match / over / short.
4. Bank cash above the next day's float as soon as practical.

### 2.4 Variance Investigation
Any shortage/overage noted the day it happens. For a 1–2 person team, the owner's daily review of the cash sheet is the primary compensating control (no second person to independently check the till).

> **Gap flagged during Phase 2 (GL engine) implementation:** unlike §6.4's
> stock-count variance, this section gives no journal pattern for a cash
> shortage/overage. Phase 2 deliberately does **not** invent one — a cash
> variance is computed and shown (`cash_day_summary`, Phase 1) but does not
> itself post a journal entry. Needs a consulting-team decision (e.g. an
> analogous `DR/CR Cash Variance` P&L account, mirroring §6.4) before it's
> implemented.

## 3. Purchasing Function

### 3.1 Recording a Cash Purchase (default)
Most stock is bought for cash, often informally. Minimum record: date, supplier/market, what was bought, quantity, amount paid, receipt if available. No PO/approval chain required for routine low-value cash restocking.

### 3.2 Supplier Accounts & Purchase Orders (regular/credit suppliers)
For a supplier offering credit or bulk pricing: supplier record (name, tax number if registered, payment terms, currency, bank details) + lightweight PO/order log. Formal second-person PO approval applies once staffed; for a one-person operation, the owner's own order record is the control.

### 3.3 Receiving Goods
Whoever receives goods checks quantity/condition before accepting. Credit purchases: invoice kept, matched to goods received.

```
DR  Inventory                              increase, at cost paid
CR  Cash — or Accounts Payable if on credit
```

## 4. Sales Function

### 4.1 Manual Daily Sales Capture (default)
As in Section 2.2 — logged as it happens, totalled at day's end. Sufficient on its own at onboarding.

### 4.2 Upgrading to a Till/POS (optional, later stage)
Once volume/formalization justifies it, a phone-based till app or POS posts the same info automatically:

```
DR  Cost of Sales                          cost of item sold
CR  Inventory
DR  Cash — or Trade Receivables if on credit
CR  Revenue
CR  VAT Output                             only once VAT-registered — Section 12
```

> **Simplification flagged during Phase 2 (GL engine) implementation,
> confirmed with the consultancy:** the Cost of Sales / Inventory-relief
> leg needs per-unit costing, which doesn't exist until Phase 3 ("basic
> inventory"). Until then, a sale posts only `DR Cash (or Trade
> Receivables) / CR Revenue` — no COGS leg, so the system never posts an
> estimated cost figure into real financial statements. The VAT Output leg
> is also deferred, to Phase 5, since it needs a tenant's actual
> VAT-registration flag (§12.2), not just its formalization stage. Both
> legs are added once their prerequisite data exists.

### 4.3 Sales Dashboard
- Top Selling Products by Revenue
- Revenue Growth = (Current − Previous) ÷ Previous × 100
- Gross Profit Margin = (Sales − Cost of Sales) ÷ Sales × 100

> **Note:** still unavailable after Phase 3 — see the §4.2 note above and
> the §6.1 note below. Basic inventory (Phase 3) added an item master and
> stock counts, not per-unit costing tied to each sale; Cost of Sales
> still isn't posted, so this metric would be computed from a number the
> system doesn't have. Needs §4.2's POS/line-item sale capture.

## 5. Debtors and Creditors Function

### 5.1 Book Credit to Known Customers
Track informal customer credit the same way as any receivable — customer, amount, date. Often the fastest win: it's usually where money quietly disappears in these businesses.

### 5.2 Ageing
30/60/90/120-day bands once volume justifies automation; starts as a simple "who owes us, since when" list reviewed weekly.

### 5.3 Paying Suppliers
Small team: owner approves and pays directly. As the team grows: payment batch process with second-approver sign-off above an agreed threshold (Section 16).

## 6. Inventory Function

> **Scope boundary flagged during Phase 3 implementation:** this section
> is built as an item master + recorded stock counts only — no perpetual
> quantity-on-hand tracking (a sale doesn't reference specific items or
> deduct their quantity) and no auto-posted §6.4 count-adjustment journal.
> Perpetual tracking would need line-item sale capture, which is §4.2's
> POS upgrade — explicitly "optional, later stage" in this Blueprint, not
> something to bolt onto the free-text sales log as a side effect. The
> §6.4 gain/loss journal needs a system-computed "expected" figure to diff
> the physical count against; the GL's Inventory account balance could
> stand in for that, but since it only ever increases (no COGS is posted
> — see §4.2's note), a count-vs-book variance computed that way would
> conflate real shrinkage with unposted COGS and risk posting a misleading
> number. Stock counts are recorded as a dated snapshot per item;
> consultant review decides what to do with a count that looks off, per
> this section's own "investigate before adjusting."

### 6.1 Inventory Master
Item/category, unit of measure, reorder point, purchase cost, selling price — detail level matched to what the owner can realistically maintain.

### 6.2 Reorder Point
Simple minimum-stock trigger per item/category, refined from the owner's own experience.

### 6.3 Inventory Dashboard
- How quickly is stock selling?
- How much cash is tied up in stock?
- What's slow-moving/obsolete?

### 6.4 Stock Counts
Ideal: two independent counters. Compensating control (solo owner): count + photograph the count sheet/shelves as a timestamped record, compare to system/log total. Investigate before adjusting.

```
DR  Inventory (Balance Sheet)              if a gain
CR  Inventory Adjustment (P&L)
```

### 6.5 Inventory Ageing
Bands appropriate to the goods (e.g. 30/90/180 days for hardware/durable clothing) to catch slow-moving/dead stock early.

## 7. Service Revenue

For repairs, alterations, key cutting, tool hire, etc. — logged the same as a sale (Section 4.1). Materials used are logged as a normal cash purchase against that job; no separate inventory/COGS journal otherwise.

## 8. Expense Function

Keep categories short and meaningful: Rent, Utilities, Transport/fuel, Airtime/data, Repairs & maintenance, Packaging, Casual labour (Section 9), Bank/mobile money charges. Every expense logged the day it's paid, from the daily cash sheet.

> **Build-order note (added during Phase 1 implementation):** §2.3's end-of-day
> formula is `opening float + cash sales − cash paid out`. "Cash paid out"
> only balances correctly if it covers both stock purchases (§3.1) and
> ordinary expenses (this section) — the original phase table scoped only
> §3.1 into Phase 1 alongside Daily Cash Control, which would have made the
> daily cash count unable to reconcile against real cash-paid-out days (e.g.
> paying rent or transport). Expenses are built into Phase 1 as a result,
> sharing the same capture shape as purchases (see `docs/README` phase
> table). Casual labour (§9.1) stays out of Phase 1 — it's paid via the
> `casual_labour` expense category here as a placeholder until its own log
> lands in Phase 6.

## 9. Labour & Payroll

> **Build-order note (added during Phase 2 implementation):** the original
> phase table listed this section's journal pattern (§9.2) as part of
> Phase 2 (GL engine). It's deferred to Phase 6 instead, alongside the
> casual labour log (§9.1) and formal payroll capture themselves — neither
> has a source data model yet (no employee master), and posting logic with
> no data to post from would be dead code. In the meantime, casual labour
> payments are captured as the `casual_labour` Expense category (§8) and
> post the ordinary expense journal.

> **§9.1 delivered in Phase 6:** a named `casual_workers` master and
> `casual_labour_payments` log replace the generic expense-category
> placeholder above — but the GL treatment is unchanged, still posting to
> the same `expense_casual_labour` account. A better-structured capture
> of the same economic event, not a new one.

### 9.1 Casual/Informal Labour Log
Record who was paid, for what, how much, when — the starting point even before formal payroll exists.

### 9.2 Formal Payroll (once registered)
Employee master, monthly pay run, statutory deductions calculated automatically, payslip per employee, remittance by due dates.

```
DR  Wages/Salaries Expense                 gross pay
CR  Cash/Bank                              net pay
CR  Statutory Payable(s)                   once formally registered as an employer
```

> **Still deferred:** §9.2 formal payroll needs statutory-deduction rates
> that are themselves configurable tax figures (non-negotiable #5, same
> shape as `tax_settings` from Phase 5), plus an employee master, a pay-
> run capture flow, and payslip generation — a build of comparable size
> to Phase 5 in its own right, not something to fold into "assets and
> casual labour." Left for a future phase.

## 10. Cash and Bank Function

> **Delivered in Phase 6.** Each bank account gets its own dedicated GL
> account (not a shared "Bank" account per currency the way Cash is), so
> multiple accounts can each be reconciled against their own statement
> independently. No opening-balance journal posts when a bank account is
> added — same reasoning as every other opening-balance deferral since
> Phase 2 (still no owner's-equity/capital account to balance it
> against); `opening_balance` is recorded as reference data only. Not
> built: "authorized users" (§10.1's field list) — access is already
> whoever holds a `client_user`/`consultant` membership on the tenant,
> and a narrower per-bank-account authorization concept wasn't
> obviously useful enough to add speculatively.

### 10.1 Bank Account Master
Not assumed from day one — many clients start entirely in cash. Opening a bank account is itself a formalization milestone (usually a VAT-registration prerequisite). Record: bank name, account number, currency, opening balance, authorized users.

### 10.2 Bank Reconciliations
Once banking is part of the routine, match banked cash against the bank statement each period.

> **Implementation note:** a reconciliation is an attestation record
> (what the statement said, on what date, confirmed by whom), not itself
> a journal posting. `ledger_balance` is computed server-side from the
> GL at the moment it's recorded — never trusted from client input — so
> the variance shown is always measured against what the books actually
> say, not what a form happened to submit.

### 10.3 Cash in Multiple Currencies
Many clients hold/transact in both USD cash and ZWG, often at a rate agreed on the spot rather than the official rate. Record the currency and rate used per transaction where it differs from the last recorded rate. Formal month-end revaluation applies once the business banks in more than one currency and reports formally.

## 11. Assets Function

> **Build-order note (added during Phase 2 implementation):** same
> reasoning as the §9 note above — the original phase table listed this
> section's depreciation journal pattern as part of Phase 2, but there's
> no asset register yet to depreciate. Deferred to Phase 6, alongside the
> asset register itself.

> **Delivered in Phase 6, with two scoping decisions worth recording:**
> adding an asset to the register does not itself post an acquisition
> journal — it's master data (matches §1.1's "equipment/fixtures owned"
> opening snapshot: durable items the business already has, not
> necessarily a new cash purchase happening through this system).
> Depreciation is a manually-triggered straight-line run
> (`cost / useful_life_months`), not a scheduled job — this app has no
> cron infrastructure, and matches the cash-first framing already used
> for the compliance calendar (Phase 5): the consulting team decides
> when to run it.

### 11.1 Asset Register
Anything durable above a value threshold agreed with the client (delivery vehicle, shelving, fridge, till device). Small tools/consumables stay in Expenses.

```
DR  Depreciation (P&L)
CR  Accumulated Depreciation (Balance Sheet)
```

### 11.2 Disposal
Remove from register on sale/scrap/loss; record any gain/loss on disposal.

## 12. Tax & Compliance Function

### 12.1 Formalization Ladder
- **Unregistered** — focus on clean records so the business is ready to register and can demonstrate genuine turnover if questioned.
- **Presumptive tax** — qualifying informal traders may pay flat presumptive tax in lieu of full corporate tax if they don't keep full books; a compliant operator with proper books and a valid tax clearance can be exempt instead. A real trade-off to discuss per client.
- **Formally registered** — TIN issued, filing standard returns (VAT once threshold met or voluntary, income/corporate tax, PAYE if employing staff formally).

### 12.2 VAT Registration
Registration required once annual taxable turnover exceeds a set threshold; voluntary registration allowed below it. **Threshold figures vary by source and are periodically revised — store as a configurable value, confirm current figure with ZIMRA/a registered tax practitioner, do not hard-code.** Track turnover on a rolling 12-month basis.

> **Scope boundary flagged during Phase 5 implementation:** `tenants` now
> has a real `vat_registered` flag and `tax_settings` gives a place to
> record a configurable, effective-dated threshold/rate — but VAT Output
> is still not posted on sales (the gap flagged back in the §4.2 Phase 2
> note). Wiring it in changes existing sale-posting behavior and needs a
> VAT-inclusive-vs-exclusive amount decision, which deserves its own
> focused pass rather than being a side effect of the compliance-calendar
> build. Deliberately deferred, not an oversight.

> **Rolling 12-month turnover tracking:** also not built yet — the
> Sales Dashboard-style aggregation this needs (`sum(revenue) over the
> trailing 12 months`) is straightforward against the journal once VAT
> posting itself is wired in; tracked as a follow-up alongside it rather
> than built in isolation now.

### 12.3 Council & Trading Licences
Track licence + renewal date alongside tax obligations — licence renewal is increasingly linked to tax compliance.

### 12.4 Compliance Calendar
Running calendar per client at their current stage — presumptive tax payment, VAT returns if registered, PAYE if applicable, council licence renewal — with reminders. Status per period: Not Started / Prepared / Filed / Confirmed.

> **Implementation note:** items are entered manually by the consulting
> team (or jointly with the owner — see §16), not auto-generated on a
> recurring schedule. Matches the Blueprint's own "cash-first, not
> system-first" framing: the consulting team already knows the calendar
> and needs a place to track status against it now; auto-generating the
> next period's item on a schedule is a reasonable later automation, not
> assumed here. "Reminders" (notifications) also aren't built — this
> phase is the tracked record a reminder system would read from.

### 12.5 Penalty & Interest Tracking
Logged on its own, separate from ordinary expenses, so cause gets fixed rather than absorbed.

## 13. General Ledger & Chart of Accounts

Keep it short and specific to what the business needs — expandable as the business grows.

## 14. Trial Balance Function
- Debits must equal credits
- Closed periods can't be posted to without owner authorization
- Corrections are by reversal, not deletion — always a trail

> **Implementation note (added during Phase 4):** "owner authorization"
> is modelled as "a consultant on the tenant" — the client-side app
> (client_user) can never post into a period once closed; a consultant
> can, which is how an authorized correction actually gets in.
> `reverse_journal()` (Phase 2) is unaffected either way since it always
> posts as of the current date, never backdated.

## 15. Financial Statements Function

Even a business that never needed financial statements before will need them — loan application, supplier credit line, tax registration. Minimum: a simple P&L and Statement of Financial Position each month, mapped from the same accounts used day to day, nothing prepared separately after the fact.

> **Scope boundary flagged during Phase 4 implementation:** the trial
> balance, P&L, and balance sheet are all computed per currency, not
> combined — only Cash is currency-split in the chart of accounts
> (Cash - USD / Cash - ZWG); Revenue, Inventory, and the expense accounts
> carry both USD and ZWG activity, so a report that summed them together
> without splitting by currency would silently combine incompatible
> figures (the same class of bug already caught and fixed for
> `customer_balances`/`supplier_balances` in Phase 3). A USD-and-ZWG
> business currently sees two parallel statements, not one converted
> figure — combined-currency reporting (an actual FX conversion, at a
> real rate, for presentation) is a deliberately deferred later
> refinement, not attempted here. There's also no owner's-equity/capital
> account yet (§1.1's opening-balance snapshot isn't built), so the
> balance sheet's only equity line is a computed "Retained Earnings"
> (cumulative net income to date) rather than a stored account — see
> `supabase/migrations/0011_reporting_and_period_close.sql`.

## 16. Approval Matrix

Living document — revisit thresholds and approver count as the client formalizes and grows staff.

| Decision | Small team (owner + 0–2 staff) | As the business grows |
|---|---|---|
| Cash purchase/restock | Owner or trusted staff; owner reviews daily cash sheet | Purchasing separated from approval once staffed |
| Credit purchase/new supplier | Owner approves directly | Second-person approval above an agreed amount |
| Supplier payment | Owner pays directly | Dual sign-off above an agreed threshold |
| Stock adjustment | Owner counts and reviews personally | Two independent counters, owner approves |
| Casual labour/payroll | Owner approves directly | Formal payroll sign-off once employees are registered |
| Tax filing/registration step | Owner or consulting team, jointly | Delegated to a bookkeeper/finance role once one exists |

> **Implementation note (added during Phase 7):** built as retrospective
> flagging, not a blocking pre-approval gate — non-negotiable #1 already
> requires every action to post its real journal immediately, and a
> small-team client (this table's own "small team" column) has no one to
> wait on anyway. A consultant sets an optional per-tenant,
> per-decision-type, per-currency dollar threshold
> (`approval_thresholds`); crossing it sets `needs_approval = true` on
> the row at insert time, and a consultant clears it later from the
> console — matching "owner reviews the daily cash sheet" as the
> compensating control, just formalized into a queue instead of relying
> on the cash sheet alone. Scoped to exactly the three rows above with a
> real dollar-threshold shape: **Credit purchase**, **Supplier payment**,
> **Casual labour**. **Cash purchase/restock** is deliberately excluded —
> this table's own row already names the daily cash sheet as its
> control, so a second threshold-flag would be redundant. **Tax
> filing/registration step** already has its own status workflow
> (`compliance_items`, Phase 5) — a dollar threshold doesn't apply to a
> filing deadline. **Stock adjustment**'s control is "two independent
> counters, owner approves" — the counting process itself, not a dollar
> variance figure (and Phase 3 already deferred a reliable stock-variance
> valuation) — so it's implemented as unconditional consultant sign-off
> on every `stock_counts` row, not threshold-gated. See
> `supabase/migrations/0016_approvals.sql`.
