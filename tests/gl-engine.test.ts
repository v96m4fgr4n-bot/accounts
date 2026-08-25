// Verifies the GL engine (supabase/migrations/0005, 0006): every Phase 1
// transaction type posts the journal pattern CLAUDE.md non-negotiable #1
// requires, the balance invariant (non-negotiable #3) and immutability
// (non-negotiable #6) hold as real DB constraints — not just app-code
// discipline — and reverse_journal() produces a correctly mirrored entry.
//
// Mostly the service-role client (posting/balance/immutability are DB
// invariants independent of who's asking — RLS itself is covered by
// tests/rls-tenant-isolation.test.ts). reverse_journal() is the one
// exception: it checks auth.uid() against tenant_memberships internally,
// which is null under the service-role key, so that test signs in as the
// consultant via the anon key instead — also a more faithful test of how
// it's actually meant to be called. Requires SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_ANON_KEY; skips without them.

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

const canRun = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);
const describeIfConfigured = canRun ? describe : describe.skip;

describeIfConfigured('GL engine', () => {
  let admin: SupabaseClient;
  // Random per run — see the afterAll note below for why this can't be
  // a fixed suffix.
  const suffix = `gl-test-${crypto.randomUUID().slice(0, 8)}`;
  const tenantName = `GL Test Tenant (${suffix})`;
  const consultantEmail = `gl-consultant-${suffix}@example.test`;
  const password = 'correct horse battery staple 3!';

  let tenantId: string;
  let userId: string;
  let consultantId: string;

  async function accountId(code: string) {
    const { data, error } = await admin
      .from('accounts')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('code', code)
      .single();
    if (error) throw error;
    return data.id as string;
  }

  async function linesFor(journalEntryId: string) {
    const { data, error } = await admin
      .from('journal_lines')
      .select('account_id, side, amount')
      .eq('journal_entry_id', journalEntryId)
      .order('side');
    if (error) throw error;
    return data;
  }

  async function journalFor(sourceType: string, sourceId: string) {
    const { data, error } = await admin
      .from('journal_entries')
      .select('id, currency, description')
      .eq('source_type', sourceType)
      .eq('source_id', sourceId)
      .single();
    if (error) throw error;
    return data;
  }

  async function openDay(tradeDate: string, currency: 'USD' | 'ZWG', openingFloat: number) {
    const { data, error } = await admin
      .from('cash_days')
      .insert({
        tenant_id: tenantId,
        trade_date: tradeDate,
        currency,
        opening_float: openingFloat,
        opened_by: userId,
      })
      .select('id')
      .single();
    if (error) throw error;
    return data.id as string;
  }

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: tenant, error: tErr } = await admin
      .from('tenants')
      .insert({ name: tenantName })
      .select('id')
      .single();
    if (tErr) throw tErr;
    tenantId = tenant.id;

    const { data: user, error: uErr } = await admin.auth.admin.createUser({
      email: `gl-owner-${suffix}@example.test`,
      password,
      email_confirm: true,
    });
    if (uErr) throw uErr;
    userId = user.user.id;

    const { data: consultant, error: cErr } = await admin.auth.admin.createUser({
      email: consultantEmail,
      password,
      email_confirm: true,
    });
    if (cErr) throw cErr;
    consultantId = consultant.user.id;

    const { error: mErr } = await admin.from('tenant_memberships').insert([
      { tenant_id: tenantId, user_id: userId, role: 'client_user' },
      { tenant_id: tenantId, user_id: consultantId, role: 'consultant' },
    ]);
    if (mErr) throw mErr;
  });

  // No afterAll cleanup: every tenant gets a chart of accounts the
  // moment it's created (0005's seed_default_accounts trigger), and
  // accounts.tenant_id is ON DELETE RESTRICT by design — a tenant's
  // history can never be silently deleted, including test tenants (and
  // journal_entries/journal_lines are separately immutable regardless of
  // role — non-negotiable #6). Run this suite against a disposable/local
  // project you reset between runs, not a long-lived one — see README's
  // real-project verification section.

  test('a cash sale posts DR Cash / CR Revenue', async () => {
    const dayId = await openDay('2026-02-01', 'USD', 50);
    const { data: sale, error } = await admin
      .from('sales')
      .insert({
        tenant_id: tenantId,
        cash_day_id: dayId,
        description: 'shirt',
        amount: 25,
        currency: 'USD',
        payment_method: 'cash',
        recorded_by: userId,
      })
      .select('id')
      .single();
    expect(error).toBeNull();

    const entry = await journalFor('sale', sale!.id);
    const lines = await linesFor(entry.id);
    const cashId = await accountId('cash_usd');
    const revenueId = await accountId('revenue');

    expect(lines).toEqual([
      { account_id: revenueId, side: 'credit', amount: 25 },
      { account_id: cashId, side: 'debit', amount: 25 },
    ]);
  });

  test('an account (book credit) sale posts DR Trade Receivables / CR Revenue', async () => {
    const dayId = await openDay('2026-02-02', 'USD', 50);
    // Phase 3 (0007) added customer_id and requires it for 'account'
    // sales — sales_account_requires_customer.
    const { data: customer } = await admin
      .from('customers')
      .insert({ tenant_id: tenantId, name: 'Mai Moyo' })
      .select('id')
      .single();
    const { data: sale, error } = await admin
      .from('sales')
      .insert({
        tenant_id: tenantId,
        cash_day_id: dayId,
        description: 'trousers, on account',
        amount: 30,
        currency: 'USD',
        payment_method: 'account',
        customer_name: 'Mai Moyo',
        customer_id: customer!.id,
        recorded_by: userId,
      })
      .select('id')
      .single();
    expect(error).toBeNull();

    const entry = await journalFor('sale', sale!.id);
    const lines = await linesFor(entry.id);
    const receivablesId = await accountId('trade_receivables');
    const revenueId = await accountId('revenue');

    expect(lines).toEqual([
      { account_id: revenueId, side: 'credit', amount: 30 },
      { account_id: receivablesId, side: 'debit', amount: 30 },
    ]);
  });

  test('a purchase posts DR Inventory / CR Cash', async () => {
    const dayId = await openDay('2026-02-03', 'ZWG', 60000);
    const { data: purchase, error } = await admin
      .from('purchases')
      .insert({
        tenant_id: tenantId,
        cash_day_id: dayId,
        description: 'stock restock',
        amount: 12000,
        currency: 'ZWG',
        exchange_rate_to_usd: 30,
        recorded_by: userId,
      })
      .select('id')
      .single();
    expect(error).toBeNull();

    const entry = await journalFor('purchase', purchase!.id);
    expect(entry.currency).toBe('ZWG');
    const lines = await linesFor(entry.id);
    const inventoryId = await accountId('inventory');
    const cashZwgId = await accountId('cash_zwg');

    expect(lines).toEqual([
      { account_id: cashZwgId, side: 'credit', amount: 12000 },
      { account_id: inventoryId, side: 'debit', amount: 12000 },
    ]);
  });

  test('expenses post DR <category expense> / CR Cash', async () => {
    const dayId = await openDay('2026-02-04', 'USD', 50);

    const { data: rentExpense, error: rentErr } = await admin
      .from('expenses')
      .insert({
        tenant_id: tenantId,
        cash_day_id: dayId,
        category: 'rent',
        description: 'shop rent',
        amount: 100,
        currency: 'USD',
        recorded_by: userId,
      })
      .select('id')
      .single();
    expect(rentErr).toBeNull();

    const { data: transportExpense, error: transportErr } = await admin
      .from('expenses')
      .insert({
        tenant_id: tenantId,
        cash_day_id: dayId,
        category: 'transport',
        description: 'delivery fare',
        amount: 8,
        currency: 'USD',
        recorded_by: userId,
      })
      .select('id')
      .single();
    expect(transportErr).toBeNull();

    const rentEntry = await journalFor('expense', rentExpense!.id);
    const rentLines = await linesFor(rentEntry.id);
    const rentAccountId = await accountId('expense_rent');
    const cashUsdId = await accountId('cash_usd');
    expect(rentLines).toEqual([
      { account_id: cashUsdId, side: 'credit', amount: 100 },
      { account_id: rentAccountId, side: 'debit', amount: 100 },
    ]);

    const transportEntry = await journalFor('expense', transportExpense!.id);
    const transportLines = await linesFor(transportEntry.id);
    const transportAccountId = await accountId('expense_transport');
    expect(transportLines).toEqual([
      { account_id: cashUsdId, side: 'credit', amount: 8 },
      { account_id: transportAccountId, side: 'debit', amount: 8 },
    ]);
  });

  test('an unbalanced journal_lines pair is rejected, even inserted directly', async () => {
    const cashId = await accountId('cash_usd');
    const revenueId = await accountId('revenue');

    const { data: entry, error: entryErr } = await admin
      .from('journal_entries')
      .insert({
        tenant_id: tenantId,
        entry_date: '2026-02-05',
        currency: 'USD',
        description: 'manually inserted, deliberately unbalanced',
        source_type: 'manual',
      })
      .select('id')
      .single();
    expect(entryErr).toBeNull();

    const { error: linesErr } = await admin.from('journal_lines').insert([
      { journal_entry_id: entry!.id, tenant_id: tenantId, account_id: cashId, side: 'debit', amount: 10 },
      { journal_entry_id: entry!.id, tenant_id: tenantId, account_id: revenueId, side: 'credit', amount: 9 },
    ]);

    // The balance check is a deferred constraint trigger — it fires at
    // COMMIT. The supabase-js client commits each request internally,
    // so the mismatch surfaces as an error on this insert.
    expect(linesErr).not.toBeNull();
  });

  test('a posted journal cannot be updated or deleted, even via the service role', async () => {
    const dayId = await openDay('2026-02-06', 'USD', 20);
    const { data: sale } = await admin
      .from('sales')
      .insert({
        tenant_id: tenantId,
        cash_day_id: dayId,
        description: 'belt',
        amount: 15,
        currency: 'USD',
        payment_method: 'cash',
        recorded_by: userId,
      })
      .select('id')
      .single();

    const entry = await journalFor('sale', sale!.id);

    const { error: updateErr } = await admin
      .from('journal_entries')
      .update({ description: 'edited after the fact' })
      .eq('id', entry.id);
    expect(updateErr).not.toBeNull();

    const { error: deleteErr } = await admin
      .from('journal_entries')
      .delete()
      .eq('id', entry.id);
    expect(deleteErr).not.toBeNull();

    const { error: lineUpdateErr } = await admin
      .from('journal_lines')
      .update({ amount: 999 })
      .eq('journal_entry_id', entry.id)
      .eq('side', 'debit');
    expect(lineUpdateErr).not.toBeNull();
  });

  test('reverse_journal mirrors the original and blocks a second reversal', async () => {
    const dayId = await openDay('2026-02-07', 'USD', 20);
    const { data: sale } = await admin
      .from('sales')
      .insert({
        tenant_id: tenantId,
        cash_day_id: dayId,
        description: 'hat, wrong amount',
        amount: 40,
        currency: 'USD',
        payment_method: 'cash',
        recorded_by: userId,
      })
      .select('id')
      .single();

    const original = await journalFor('sale', sale!.id);
    const originalLines = await linesFor(original.id);

    // reverse_journal() checks auth.uid() against tenant_memberships
    // (role = 'consultant') itself, so it has to be called as a signed-in
    // consultant, not the service-role key (auth.uid() is null there).
    const asConsultant = createClient(SUPABASE_URL!, ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInErr } = await asConsultant.auth.signInWithPassword({
      email: consultantEmail,
      password,
    });
    expect(signInErr).toBeNull();

    const { data: reversalId, error: reverseErr } = await asConsultant.rpc('reverse_journal', {
      p_journal_entry_id: original.id,
      p_reason: 'logged at the wrong amount',
    });
    expect(reverseErr).toBeNull();

    const { data: reversalEntry, error: reversalReadErr } = await admin
      .from('journal_entries')
      .select('id, reverses, source_type')
      .eq('id', reversalId)
      .single();
    expect(reversalReadErr).toBeNull();
    expect(reversalEntry?.reverses).toBe(original.id);
    expect(reversalEntry?.source_type).toBe('reversal');

    const reversalLines = await linesFor(reversalId as string);
    const flipped = originalLines.map((l) => ({
      account_id: l.account_id,
      side: l.side === 'debit' ? 'credit' : 'debit',
      amount: l.amount,
    }));
    expect(reversalLines.sort((a, b) => a.side.localeCompare(b.side))).toEqual(
      flipped.sort((a, b) => a.side.localeCompare(b.side)),
    );

    const { error: secondReverseErr } = await asConsultant.rpc('reverse_journal', {
      p_journal_entry_id: original.id,
      p_reason: 'trying again',
    });
    expect(secondReverseErr).not.toBeNull();
  });
});
