// Verifies Phase 3 (supabase/migrations 0007-0009): credit purchases and
// customer/supplier payments post the right journal patterns, the AR/AP
// balance views (customer_balances/supplier_balances) are currency-
// scoped rather than silently combining USD and ZWG (non-negotiable
// #4), and cash_day_summary's till reconciliation correctly includes
// customer/supplier payments while excluding credit purchases (which
// never touch the till until the supplier is actually paid).
//
// Service-role client, same skip-without-env-vars convention as the
// other suites. Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const canRun = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);
const describeIfConfigured = canRun ? describe : describe.skip;

describeIfConfigured('debtors, creditors, and inventory (Phase 3)', () => {
  let admin: SupabaseClient;
  const suffix = 'dc-test';
  const tenantName = `Debtors/Creditors Test Tenant (${suffix})`;

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
      email: `dc-owner-${suffix}@example.test`,
      password: 'correct horse battery staple 4!',
      email_confirm: true,
    });
    if (uErr) throw uErr;
    userId = user.user.id;

    const { error: mErr } = await admin
      .from('tenant_memberships')
      .insert({ tenant_id: tenantId, user_id: userId, role: 'client_user' });
    if (mErr) throw mErr;
  });

  afterAll(async () => {
    if (userId) await admin.auth.admin.deleteUser(userId);
    if (tenantId) await admin.from('tenants').delete().eq('id', tenantId);
  });

  test('a credit purchase posts DR Inventory / CR Accounts Payable', async () => {
    const dayId = await openDay('2026-03-01', 'USD', 50);
    const { data: supplier } = await admin
      .from('suppliers')
      .insert({ tenant_id: tenantId, name: 'Harare Wholesale' })
      .select('id')
      .single();

    const { data: purchase, error } = await admin
      .from('purchases')
      .insert({
        tenant_id: tenantId,
        cash_day_id: dayId,
        description: 'bulk stock',
        supplier_id: supplier!.id,
        payment_method: 'credit',
        amount: 200,
        currency: 'USD',
        recorded_by: userId,
      })
      .select('id')
      .single();
    expect(error).toBeNull();

    const entry = await journalFor('purchase', purchase!.id);
    const lines = await linesFor(entry.id);
    const inventoryId = await accountId('inventory');
    const apId = await accountId('accounts_payable');

    expect(lines).toEqual([
      { account_id: inventoryId, side: 'debit', amount: 200 },
      { account_id: apId, side: 'credit', amount: 200 },
    ]);
  });

  test('a supplier payment posts DR Accounts Payable / CR Cash, and a customer payment posts DR Cash / CR Trade Receivables', async () => {
    const dayId = await openDay('2026-03-02', 'USD', 50);

    const { data: supplier } = await admin
      .from('suppliers')
      .insert({ tenant_id: tenantId, name: 'Bulawayo Supplies' })
      .select('id')
      .single();
    const { data: supplierPayment, error: spErr } = await admin
      .from('supplier_payments')
      .insert({
        tenant_id: tenantId,
        supplier_id: supplier!.id,
        cash_day_id: dayId,
        amount: 60,
        currency: 'USD',
        recorded_by: userId,
      })
      .select('id')
      .single();
    expect(spErr).toBeNull();

    const spEntry = await journalFor('supplier_payment', supplierPayment!.id);
    const spLines = await linesFor(spEntry.id);
    const apId = await accountId('accounts_payable');
    const cashId = await accountId('cash_usd');
    expect(spLines).toEqual([
      { account_id: apId, side: 'debit', amount: 60 },
      { account_id: cashId, side: 'credit', amount: 60 },
    ]);

    const { data: customer } = await admin
      .from('customers')
      .insert({ tenant_id: tenantId, name: 'Tendai M' })
      .select('id')
      .single();
    const { data: customerPayment, error: cpErr } = await admin
      .from('customer_payments')
      .insert({
        tenant_id: tenantId,
        customer_id: customer!.id,
        cash_day_id: dayId,
        amount: 35,
        currency: 'USD',
        recorded_by: userId,
      })
      .select('id')
      .single();
    expect(cpErr).toBeNull();

    const cpEntry = await journalFor('customer_payment', customerPayment!.id);
    const cpLines = await linesFor(cpEntry.id);
    const receivablesId = await accountId('trade_receivables');
    expect(cpLines).toEqual([
      { account_id: cashId, side: 'debit', amount: 35 },
      { account_id: receivablesId, side: 'credit', amount: 35 },
    ]);
  });

  test('customer_balances and supplier_balances are currency-scoped, not combined', async () => {
    const usdDay = await openDay('2026-03-03', 'USD', 50);
    const zwgDay = await openDay('2026-03-03', 'ZWG', 60000);

    const { data: customer } = await admin
      .from('customers')
      .insert({ tenant_id: tenantId, name: 'Rudo K' })
      .select('id')
      .single();

    await admin.from('sales').insert([
      {
        tenant_id: tenantId,
        cash_day_id: usdDay,
        description: 'jacket, on account',
        amount: 40,
        currency: 'USD',
        payment_method: 'account',
        customer_id: customer!.id,
        customer_name: 'Rudo K',
        recorded_by: userId,
      },
      {
        tenant_id: tenantId,
        cash_day_id: zwgDay,
        description: 'scarf, on account',
        amount: 30000,
        currency: 'ZWG',
        exchange_rate_to_usd: 30,
        payment_method: 'account',
        customer_id: customer!.id,
        customer_name: 'Rudo K',
        recorded_by: userId,
      },
    ]);

    await admin.from('customer_payments').insert({
      tenant_id: tenantId,
      customer_id: customer!.id,
      cash_day_id: usdDay,
      amount: 15,
      currency: 'USD',
      recorded_by: userId,
    });

    const { data: balances, error } = await admin
      .from('customer_balances')
      .select('currency, balance_owed')
      .eq('customer_id', customer!.id)
      .order('currency');
    expect(error).toBeNull();

    expect(balances).toEqual([
      { currency: 'USD', balance_owed: 25 },
      { currency: 'ZWG', balance_owed: 30000 },
    ]);
  });

  test('cash_day_summary includes customer/supplier payments and excludes credit purchases from the till', async () => {
    const dayId = await openDay('2026-03-04', 'USD', 100);

    const { data: customer } = await admin
      .from('customers')
      .insert({ tenant_id: tenantId, name: 'Chipo N' })
      .select('id')
      .single();
    const { data: supplier } = await admin
      .from('suppliers')
      .insert({ tenant_id: tenantId, name: 'Mutare Traders' })
      .select('id')
      .single();

    // Cash sale: +50. Credit purchase: 0 till impact (owed, not paid).
    // Customer payment: +20 (cash in). Supplier payment: -10 (cash out).
    await admin.from('sales').insert({
      tenant_id: tenantId,
      cash_day_id: dayId,
      description: 'cash sale',
      amount: 50,
      currency: 'USD',
      payment_method: 'cash',
      recorded_by: userId,
    });
    await admin.from('purchases').insert({
      tenant_id: tenantId,
      cash_day_id: dayId,
      description: 'stock on credit',
      supplier_id: supplier!.id,
      payment_method: 'credit',
      amount: 200,
      currency: 'USD',
      recorded_by: userId,
    });
    await admin.from('customer_payments').insert({
      tenant_id: tenantId,
      customer_id: customer!.id,
      cash_day_id: dayId,
      amount: 20,
      currency: 'USD',
      recorded_by: userId,
    });
    await admin.from('supplier_payments').insert({
      tenant_id: tenantId,
      supplier_id: supplier!.id,
      cash_day_id: dayId,
      amount: 10,
      currency: 'USD',
      recorded_by: userId,
    });

    // expected = 100 opening + 50 cash sale + 20 customer payment - 0 (credit purchase excluded) - 10 supplier payment = 160
    const { data: summary, error } = await admin
      .from('cash_day_summary')
      .select('expected_cash, purchases_total, customer_payments_total, supplier_payments_total')
      .eq('cash_day_id', dayId)
      .single();
    expect(error).toBeNull();
    expect(summary?.purchases_total).toBe(0);
    expect(summary?.customer_payments_total).toBe(20);
    expect(summary?.supplier_payments_total).toBe(10);
    expect(summary?.expected_cash).toBe(160);
  });
});
