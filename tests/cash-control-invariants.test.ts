// Verifies CLAUDE.md non-negotiable #4 (currency and rate recorded per
// transaction, never assumed) and the cash_days immutability trigger
// from supabase/migrations/0003 (closed days, and their opening fields,
// can't be silently edited — same "correct by reversal" spirit as
// journal immutability, non-negotiable #6).
//
// Uses the service-role client only — this file is about constraints
// and triggers, not RLS, which tests/rls-tenant-isolation.test.ts
// already covers. Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY;
// skips (not fails) without them, same convention as the RLS suite.

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const canRun = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);
const describeIfConfigured = canRun ? describe : describe.skip;

describeIfConfigured('cash control invariants', () => {
  let admin: SupabaseClient;
  // Random per run — see the afterAll note below for why this can't be
  // a fixed suffix.
  const suffix = `cash-test-${crypto.randomUUID().slice(0, 8)}`;
  const tenantName = `Cash Test Tenant (${suffix})`;
  const userEmail = `cash-owner-${suffix}@example.test`;
  const password = 'correct horse battery staple 2!';

  let tenantId: string;
  let userId: string;

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
      email: userEmail,
      password,
      email_confirm: true,
    });
    if (uErr) throw uErr;
    userId = user.user.id;

    const { error: mErr } = await admin
      .from('tenant_memberships')
      .insert({ tenant_id: tenantId, user_id: userId, role: 'client_user' });
    if (mErr) throw mErr;
  });

  // No afterAll cleanup: every tenant gets a chart of accounts the
  // moment it's created (0005's seed_default_accounts trigger), and
  // accounts.tenant_id is ON DELETE RESTRICT by design — a tenant's
  // history can never be silently deleted, including test tenants. Run
  // this suite against a disposable/local project you reset between
  // runs, not a long-lived one — see README's real-project verification
  // section.

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

  test('a ZWG sale without a rate is rejected', async () => {
    const dayId = await openDay('2026-01-05', 'ZWG', 1000);

    const { error } = await admin.from('sales').insert({
      tenant_id: tenantId,
      cash_day_id: dayId,
      description: 'shirt',
      amount: 5000,
      currency: 'ZWG',
      payment_method: 'cash',
      recorded_by: userId,
    });

    expect(error).not.toBeNull();
  });

  test('a USD sale needs no rate, and two ZWG sales on the same day keep independent rates', async () => {
    const dayId = await openDay('2026-01-06', 'USD', 50);

    const { error: usdErr } = await admin.from('sales').insert({
      tenant_id: tenantId,
      cash_day_id: dayId,
      description: 'trousers',
      amount: 20,
      currency: 'USD',
      payment_method: 'cash',
      recorded_by: userId,
    });
    expect(usdErr).toBeNull();

    const zwgDayId = await openDay('2026-01-06', 'ZWG', 60000);

    const { error: firstErr } = await admin.from('sales').insert({
      tenant_id: tenantId,
      cash_day_id: zwgDayId,
      description: 'belt, morning rate',
      amount: 6000,
      currency: 'ZWG',
      exchange_rate_to_usd: 30,
      payment_method: 'cash',
      recorded_by: userId,
    });
    expect(firstErr).toBeNull();

    const { error: secondErr } = await admin.from('sales').insert({
      tenant_id: tenantId,
      cash_day_id: zwgDayId,
      description: 'belt, afternoon rate',
      amount: 6600,
      currency: 'ZWG',
      exchange_rate_to_usd: 33,
      payment_method: 'cash',
      recorded_by: userId,
    });
    expect(secondErr).toBeNull();

    const { data: rows, error: readErr } = await admin
      .from('sales')
      .select('description, exchange_rate_to_usd')
      .eq('cash_day_id', zwgDayId)
      .order('description');
    expect(readErr).toBeNull();

    // A later transaction's rate must never overwrite an earlier one's —
    // each row keeps the rate that was actually agreed at the time.
    expect(rows).toEqual([
      { description: 'belt, afternoon rate', exchange_rate_to_usd: 33 },
      { description: 'belt, morning rate', exchange_rate_to_usd: 30 },
    ]);
  });

  test('closing a cash day computes expected cash and variance, then locks the day', async () => {
    const dayId = await openDay('2026-01-07', 'USD', 100);

    await admin.from('sales').insert({
      tenant_id: tenantId,
      cash_day_id: dayId,
      description: 'sale',
      amount: 40,
      currency: 'USD',
      payment_method: 'cash',
      recorded_by: userId,
    });
    await admin.from('purchases').insert({
      tenant_id: tenantId,
      cash_day_id: dayId,
      description: 'stock',
      amount: 15,
      currency: 'USD',
      recorded_by: userId,
    });
    await admin.from('expenses').insert({
      tenant_id: tenantId,
      cash_day_id: dayId,
      category: 'transport',
      description: 'delivery fare',
      amount: 5,
      currency: 'USD',
      recorded_by: userId,
    });

    // expected = 100 opening + 40 sales - 15 purchases - 5 expenses = 120
    const { data: preClose } = await admin
      .from('cash_day_summary')
      .select('expected_cash')
      .eq('cash_day_id', dayId)
      .single();
    expect(preClose?.expected_cash).toBe(120);

    const { error: closeErr } = await admin
      .from('cash_days')
      .update({
        closing_count: 118,
        closed_by: userId,
        closed_at: new Date().toISOString(),
        status: 'closed',
      })
      .eq('id', dayId);
    expect(closeErr).toBeNull();

    const { data: summary } = await admin
      .from('cash_day_summary')
      .select('expected_cash, closing_count, variance')
      .eq('cash_day_id', dayId)
      .single();
    expect(summary?.variance).toBe(-2);

    // Closed means closed: no further edits, not even to closing_count.
    const { error: reopenErr } = await admin
      .from('cash_days')
      .update({ closing_count: 120 })
      .eq('id', dayId);
    expect(reopenErr).not.toBeNull();
  });

  test('opening_float cannot be changed after the day is opened', async () => {
    const dayId = await openDay('2026-01-08', 'USD', 75);

    const { error } = await admin
      .from('cash_days')
      .update({ opening_float: 999 })
      .eq('id', dayId);

    expect(error).not.toBeNull();
  });
});
