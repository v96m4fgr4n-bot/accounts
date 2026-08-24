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

### 4.3 Sales Dashboard
- Top Selling Products by Revenue
- Revenue Growth = (Current − Previous) ÷ Previous × 100
- Gross Profit Margin = (Sales − Cost of Sales) ÷ Sales × 100

## 5. Debtors and Creditors Function

### 5.1 Book Credit to Known Customers
Track informal customer credit the same way as any receivable — customer, amount, date. Often the fastest win: it's usually where money quietly disappears in these businesses.

### 5.2 Ageing
30/60/90/120-day bands once volume justifies automation; starts as a simple "who owes us, since when" list reviewed weekly.

### 5.3 Paying Suppliers
Small team: owner approves and pays directly. As the team grows: payment batch process with second-approver sign-off above an agreed threshold (Section 16).

## 6. Inventory Function

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

## 9. Labour & Payroll

### 9.1 Casual/Informal Labour Log
Record who was paid, for what, how much, when — the starting point even before formal payroll exists.

### 9.2 Formal Payroll (once registered)
Employee master, monthly pay run, statutory deductions calculated automatically, payslip per employee, remittance by due dates.

```
DR  Wages/Salaries Expense                 gross pay
CR  Cash/Bank                              net pay
CR  Statutory Payable(s)                   once formally registered as an employer
```

## 10. Cash and Bank Function

### 10.1 Bank Account Master
Not assumed from day one — many clients start entirely in cash. Opening a bank account is itself a formalization milestone (usually a VAT-registration prerequisite). Record: bank name, account number, currency, opening balance, authorized users.

### 10.2 Bank Reconciliations
Once banking is part of the routine, match banked cash against the bank statement each period.

### 10.3 Cash in Multiple Currencies
Many clients hold/transact in both USD cash and ZWG, often at a rate agreed on the spot rather than the official rate. Record the currency and rate used per transaction where it differs from the last recorded rate. Formal month-end revaluation applies once the business banks in more than one currency and reports formally.

## 11. Assets Function

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

### 12.3 Council & Trading Licences
Track licence + renewal date alongside tax obligations — licence renewal is increasingly linked to tax compliance.

### 12.4 Compliance Calendar
Running calendar per client at their current stage — presumptive tax payment, VAT returns if registered, PAYE if applicable, council licence renewal — with reminders. Status per period: Not Started / Prepared / Filed / Confirmed.

### 12.5 Penalty & Interest Tracking
Logged on its own, separate from ordinary expenses, so cause gets fixed rather than absorbed.

## 13. General Ledger & Chart of Accounts

Keep it short and specific to what the business needs — expandable as the business grows.

## 14. Trial Balance Function
- Debits must equal credits
- Closed periods can't be posted to without owner authorization
- Corrections are by reversal, not deletion — always a trail

## 15. Financial Statements Function

Even a business that never needed financial statements before will need them — loan application, supplier credit line, tax registration. Minimum: a simple P&L and Statement of Financial Position each month, mapped from the same accounts used day to day, nothing prepared separately after the fact.

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
