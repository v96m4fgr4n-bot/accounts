// Verifies Phase 6 (supabase/migrations 0013-0015): casual labour
// payments post to the existing expense_casual_labour account and show
// up in cash_day_summary; bank accounts auto-seed their own GL account
// and reject a deposit in the wrong currency; bank_reconciliations
// computes ledger_balance server-side regardless of what the client
// sends, and is immutable; asset depreciation posts correct straight-
// line amounts and can't double-post the same period or run past full
// depreciation; and disposal posts a balanced entry in every gain/loss/
// break-even case, including the edge case that exposed a real bug
// during development (disposing before any depreciation has run, where
// a naive implementation would try to post a zero-amount journal line).
//
// Mostly the service-role client, except run_asset_depreciation and
// dispose_asset — both check is_tenant_member(), which reads auth.uid(),
// which is null under the service-role key (it's a role credential, not
// a user session) — same lesson already learned from reverse_journal's
// test in Phase 2. Those two calls go through a signed-in user client
// instead. Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and
// SUPABASE_ANON_KEY. No afterAll cleanup — see the other test files for
// why.

import { describe, test, expect, beforeAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

const canRun = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);
const describeIfConfigured = canRun ? describe : describe.skip;

describeIfConfigured('assets, casual labour, banking (Phase 6)', () => {
  let admin: SupabaseClient;
  let asUser: SupabaseClient;
  const suffix = `p6-test-${crypto.randomUUID().slice(0, 8)}`;
  const password = 'correct horse battery staple 7!';

  let tenantId: string;
  let userId: string;

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
      .select('id')
      .eq('source_type', sourceType)
      .eq('source_id', sourceId)
      .single();
    if (error) throw error;
    return data;
  }

  async function openDay(tradeDate: string, currency: 'USD' | 'ZWG', openingFloat: number) {
    const { data, error } = await admin
      .from('cash_days')
      .insert({ tenant_id: tenantId, trade_date: tradeDate, currency, opening_float: openingFloat, opened_by: userId })
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
      .insert({ name: `Phase 6 Test Tenant (${suffix})` })
      .select('id')
      .single();
    if (tErr) throw tErr;
    tenantId = tenant.id;

    const email = `p6-owner-${suffix}@example.test`;
    const { data: user, error: uErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (uErr) throw uErr;
    userId = user.user.id;

    const { error: mErr } = await admin
      .from('tenant_memberships')
      .insert({ tenant_id: tenantId, user_id: userId, role: 'client_user' });
    if (mErr) throw mErr;

    asUser = createClient(SUPABASE_URL!, ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInErr } = await asUser.auth.signInWithPassword({ email, password });
    if (signInErr) throw signInErr;
  });

  test('a casual labour payment posts to expense_casual_labour and appears in cash_day_summary', async () => {
    const dayId = await openDay('2026-06-01', 'USD', 30);
    const { data: worker } = await admin
      .from('casual_workers')
      .insert({ tenant_id: tenantId, name: 'Tapiwa' })
      .select('id')
      .single();

    const { data: payment, error } = await admin
      .from('casual_labour_payments')
      .insert({
        tenant_id: tenantId,
        worker_id: worker!.id,
        cash_day_id: dayId,
        paid_at: '2026-06-01T10:00:00Z',
        description: 'Unloading delivery',
        amount: 5,
        currency: 'USD',
        recorded_by: userId,
      })
      .select('id')
      .single();
    expect(error).toBeNull();

    const entry = await journalFor('casual_labour', payment!.id);
    const lines = await linesFor(entry.id);
    const expenseId = await accountId('expense_casual_labour');
    const cashId = await accountId('cash_usd');
    expect(lines).toEqual([
      { account_id: cashId, side: 'credit', amount: 5 },
      { account_id: expenseId, side: 'debit', amount: 5 },
    ]);

    const { data: summary } = await admin
      .from('cash_day_summary')
      .select('casual_labour_total, expected_cash')
      .eq('cash_day_id', dayId)
      .single();
    expect(summary?.casual_labour_total).toBe(5);
    expect(summary?.expected_cash).toBe(25); // 30 opening - 5 paid
  });

  test('a bank account auto-seeds its own GL account, and a deposit posts and rejects the wrong currency', async () => {
    const { data: bankAccount, error: bankErr } = await admin
      .from('bank_accounts')
      .insert({ tenant_id: tenantId, bank_name: 'CBZ', account_number: '1234567890', currency: 'USD', created_by: userId })
      .select('id, gl_account_id')
      .single();
    expect(bankErr).toBeNull();
    expect(bankAccount!.gl_account_id).not.toBeNull();

    const dayId = await openDay('2026-06-02', 'USD', 100);

    const { error: wrongCurrencyErr } = await admin.from('bank_deposits').insert({
      tenant_id: tenantId,
      bank_account_id: bankAccount!.id,
      cash_day_id: dayId,
      amount: 50,
      currency: 'ZWG',
      exchange_rate_to_usd: 30,
      recorded_by: userId,
    });
    expect(wrongCurrencyErr).not.toBeNull();

    const { data: deposit, error: depositErr } = await admin
      .from('bank_deposits')
      .insert({
        tenant_id: tenantId,
        bank_account_id: bankAccount!.id,
        cash_day_id: dayId,
        deposited_at: '2026-06-02T15:00:00Z',
        amount: 60,
        currency: 'USD',
        recorded_by: userId,
      })
      .select('id')
      .single();
    expect(depositErr).toBeNull();

    const entry = await journalFor('bank_deposit', deposit!.id);
    const lines = await linesFor(entry.id);
    const cashId = await accountId('cash_usd');
    expect(lines).toEqual([
      { account_id: cashId, side: 'credit', amount: 60 },
      { account_id: bankAccount!.gl_account_id, side: 'debit', amount: 60 },
    ]);

    const { data: balance } = await admin.rpc('bank_account_balance', {
      p_bank_account_id: bankAccount!.id,
      p_as_of: '2026-06-30',
    });
    expect(balance).toBe(60);
  });

  test('bank_reconciliations computes ledger_balance server-side and is immutable', async () => {
    const { data: bankAccount } = await admin
      .from('bank_accounts')
      .insert({ tenant_id: tenantId, bank_name: 'Steward', account_number: '9999', currency: 'USD', created_by: userId })
      .select('id')
      .single();

    const dayId = await openDay('2026-06-03', 'USD', 0);
    await admin.from('bank_deposits').insert({
      tenant_id: tenantId,
      bank_account_id: bankAccount!.id,
      cash_day_id: dayId,
      deposited_at: '2026-06-03T09:00:00Z',
      amount: 40,
      currency: 'USD',
      recorded_by: userId,
    });

    const { data: recon, error } = await admin
      .from('bank_reconciliations')
      .insert({
        tenant_id: tenantId,
        bank_account_id: bankAccount!.id,
        statement_date: '2026-06-03',
        statement_closing_balance: 40,
        ledger_balance: 999999, // must be ignored/overwritten server-side
        reconciled_by: userId,
      })
      .select('ledger_balance')
      .single();
    expect(error).toBeNull();
    expect(recon?.ledger_balance).toBe(40);

    const { data: existing } = await admin
      .from('bank_reconciliations')
      .select('id')
      .eq('bank_account_id', bankAccount!.id)
      .single();
    const { error: updateErr } = await admin
      .from('bank_reconciliations')
      .update({ note: 'edited' })
      .eq('id', existing!.id);
    expect(updateErr).not.toBeNull();
  });

  test('asset depreciation posts straight-line amounts, updates the register, and guards against double/over-depreciation', async () => {
    const { data: asset } = await admin
      .from('assets')
      .insert({
        tenant_id: tenantId,
        name: 'Delivery bicycle',
        cost: 120,
        currency: 'USD',
        acquired_at: '2026-01-01',
        useful_life_months: 12,
        created_by: userId,
      })
      .select('id')
      .single();

    // 120 / 12 months = 10/month. Depreciating through 2026-04-01 from
    // acquisition (2026-01-01) is 3 months elapsed = 30.
    const { data: entryId, error } = await asUser.rpc('run_asset_depreciation', {
      p_asset_id: asset!.id,
      p_period_through: '2026-04-01',
    });
    expect(error).toBeNull();

    const lines = await linesFor(entryId as string);
    const depExpenseId = await accountId('depreciation_expense');
    const accumDepId = await accountId('accumulated_depreciation');
    expect(lines).toEqual([
      { account_id: accumDepId, side: 'credit', amount: 30 },
      { account_id: depExpenseId, side: 'debit', amount: 30 },
    ]);

    const { data: updatedAsset } = await admin
      .from('assets')
      .select('accumulated_depreciation')
      .eq('id', asset!.id)
      .single();
    expect(updatedAsset?.accumulated_depreciation).toBe(30);

    // Same period again: zero months elapsed, rejected.
    const { error: sameMonthErr } = await asUser.rpc('run_asset_depreciation', {
      p_asset_id: asset!.id,
      p_period_through: '2026-04-01',
    });
    expect(sameMonthErr).not.toBeNull();

    // Jump straight to fully depreciated, then confirm a further run is rejected.
    const { error: fullErr } = await asUser.rpc('run_asset_depreciation', {
      p_asset_id: asset!.id,
      p_period_through: '2027-06-01',
    });
    expect(fullErr).toBeNull();
    const { data: fullyDepreciated } = await admin
      .from('assets')
      .select('accumulated_depreciation, cost')
      .eq('id', asset!.id)
      .single();
    expect(fullyDepreciated?.accumulated_depreciation).toBe(fullyDepreciated?.cost);

    const { error: overErr } = await asUser.rpc('run_asset_depreciation', {
      p_asset_id: asset!.id,
      p_period_through: '2027-07-01',
    });
    expect(overErr).not.toBeNull();
  });

  test('disposal balances in a gain, a loss, and the zero-depreciation edge case', async () => {
    // Gain: never depreciated (accumulated_depreciation = 0 — the case
    // that originally caused a zero-amount journal-line bug), sold above cost.
    const { data: gainAsset } = await admin
      .from('assets')
      .insert({ tenant_id: tenantId, name: 'Signage', cost: 50, currency: 'USD', acquired_at: '2026-01-01', useful_life_months: 24, created_by: userId })
      .select('id')
      .single();
    const { data: gainEntryId, error: gainErr } = await asUser.rpc('dispose_asset', {
      p_asset_id: gainAsset!.id,
      p_disposed_at: '2026-06-10',
      p_proceeds: 70,
    });
    expect(gainErr).toBeNull();
    const gainLines = await linesFor(gainEntryId as string);
    const gainSum = gainLines.reduce((s, l) => s + (l.side === 'debit' ? l.amount : -l.amount), 0);
    expect(gainSum).toBe(0);
    expect(gainLines.length).toBeGreaterThanOrEqual(2);

    // Loss: some depreciation posted, sold below book value.
    const { data: lossAsset } = await admin
      .from('assets')
      .insert({ tenant_id: tenantId, name: 'Fridge', cost: 200, currency: 'USD', acquired_at: '2026-01-01', useful_life_months: 20, created_by: userId })
      .select('id')
      .single();
    await asUser.rpc('run_asset_depreciation', { p_asset_id: lossAsset!.id, p_period_through: '2026-05-01' });
    // book value = 200 - (10/mo * 4mo = 40) = 160; sold for 100 -> loss 60.
    const { data: lossEntryId, error: lossErr } = await asUser.rpc('dispose_asset', {
      p_asset_id: lossAsset!.id,
      p_disposed_at: '2026-06-10',
      p_proceeds: 100,
    });
    expect(lossErr).toBeNull();
    const lossLines = await linesFor(lossEntryId as string);
    const lossSum = lossLines.reduce((s, l) => s + (l.side === 'debit' ? l.amount : -l.amount), 0);
    expect(lossSum).toBe(0);

    // Break-even: proceeds exactly match book value -> no gain/loss leg.
    const { data: evenAsset } = await admin
      .from('assets')
      .insert({ tenant_id: tenantId, name: 'Shelving', cost: 90, currency: 'USD', acquired_at: '2026-01-01', useful_life_months: 9, created_by: userId })
      .select('id')
      .single();
    // 90/9 = 10/mo; 3 months -> 30 depreciated, book value 60.
    await asUser.rpc('run_asset_depreciation', { p_asset_id: evenAsset!.id, p_period_through: '2026-04-01' });
    const { data: evenEntryId, error: evenErr } = await asUser.rpc('dispose_asset', {
      p_asset_id: evenAsset!.id,
      p_disposed_at: '2026-06-10',
      p_proceeds: 60,
    });
    expect(evenErr).toBeNull();
    const evenLines = await linesFor(evenEntryId as string);
    const disposalGainLossId = await accountId('disposal_gain_loss');
    expect(evenLines.some((l) => l.account_id === disposalGainLossId)).toBe(false);
    const evenSum = evenLines.reduce((s, l) => s + (l.side === 'debit' ? l.amount : -l.amount), 0);
    expect(evenSum).toBe(0);

    // A second disposal of the same asset is rejected.
    const { error: redisposeErr } = await asUser.rpc('dispose_asset', {
      p_asset_id: evenAsset!.id,
      p_disposed_at: '2026-06-11',
      p_proceeds: 0,
    });
    expect(redisposeErr).not.toBeNull();
  });
});
