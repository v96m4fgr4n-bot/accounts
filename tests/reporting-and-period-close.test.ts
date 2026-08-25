// Verifies Phase 4 (supabase/migrations/0011): the three reporting
// functions (trial_balance, income_statement, balance_sheet) stay
// currency-scoped rather than silently combining USD and ZWG (the same
// class of bug already caught in Phase 3's customer_balances), the
// trial balance's debit/credit columns sum equal per currency (the
// report-level proof of non-negotiable #3), the balance sheet's derived
// Retained Earnings makes Assets = Liabilities + Equity balance exactly,
// and period closing (§14) blocks an ordinary client_user's posting into
// a closed period while still allowing a consultant's.
//
// Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_ANON_KEY
// (period-close authorization checks auth.uid(), so it has to be
// exercised as a signed-in user, not the service role). Skips without
// them, same convention as the other suites. No afterAll cleanup — see
// the other test files for why (accounts.tenant_id is ON DELETE
// RESTRICT by design).

import { describe, test, expect, beforeAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

const canRun = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);
const describeIfConfigured = canRun ? describe : describe.skip;

describeIfConfigured('reporting and period close (Phase 4)', () => {
  let admin: SupabaseClient;
  const suffix = `report-test-${crypto.randomUUID().slice(0, 8)}`;
  const tenantName = `Reporting Test Tenant (${suffix})`;
  const password = 'correct horse battery staple 5!';
  const clientEmail = `report-client-${suffix}@example.test`;
  const consultantEmail = `report-consultant-${suffix}@example.test`;

  let tenantId: string;
  let clientUserId: string;
  let consultantUserId: string;

  async function openDay(tradeDate: string, currency: 'USD' | 'ZWG', openingFloat: number) {
    const { data, error } = await admin
      .from('cash_days')
      .insert({
        tenant_id: tenantId,
        trade_date: tradeDate,
        currency,
        opening_float: openingFloat,
        opened_by: clientUserId,
      })
      .select('id')
      .single();
    if (error) throw error;
    return data.id as string;
  }

  async function signInAs(email: string) {
    const client = createClient(SUPABASE_URL!, ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return client;
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

    const { data: clientUser, error: cuErr } = await admin.auth.admin.createUser({
      email: clientEmail,
      password,
      email_confirm: true,
    });
    if (cuErr) throw cuErr;
    clientUserId = clientUser.user.id;

    const { data: consultantUser, error: conErr } = await admin.auth.admin.createUser({
      email: consultantEmail,
      password,
      email_confirm: true,
    });
    if (conErr) throw conErr;
    consultantUserId = consultantUser.user.id;

    const { error: mErr } = await admin.from('tenant_memberships').insert([
      { tenant_id: tenantId, user_id: clientUserId, role: 'client_user' },
      { tenant_id: tenantId, user_id: consultantUserId, role: 'consultant' },
    ]);
    if (mErr) throw mErr;

    // Activity across both currencies so currency-scoping is actually
    // exercised, not just assumed: a USD cash sale + expense, and a ZWG
    // cash sale, on the same day.
    // sold_at/paid_at must be set explicitly here — left to their
    // now()-default, these would post journals dated today instead of
    // April 2026, landing outside every date range this suite queries.
    const usdDay = await openDay('2026-04-01', 'USD', 100);
    await admin.from('sales').insert({
      tenant_id: tenantId,
      cash_day_id: usdDay,
      sold_at: '2026-04-01T09:00:00Z',
      description: 'USD sale',
      amount: 80,
      currency: 'USD',
      payment_method: 'cash',
      recorded_by: clientUserId,
    });
    await admin.from('expenses').insert({
      tenant_id: tenantId,
      cash_day_id: usdDay,
      paid_at: '2026-04-01T09:30:00Z',
      category: 'rent',
      description: 'rent',
      amount: 30,
      currency: 'USD',
      recorded_by: clientUserId,
    });

    const zwgDay = await openDay('2026-04-01', 'ZWG', 60000);
    await admin.from('sales').insert({
      tenant_id: tenantId,
      cash_day_id: zwgDay,
      sold_at: '2026-04-01T09:00:00Z',
      description: 'ZWG sale',
      amount: 90000,
      currency: 'ZWG',
      exchange_rate_to_usd: 30,
      payment_method: 'cash',
      recorded_by: clientUserId,
    });
  });

  test('trial balance sums debit_balance equal to credit_balance within each currency', async () => {
    const { data, error } = await admin.rpc('trial_balance', {
      p_tenant_id: tenantId,
      p_as_of: '2026-04-30',
    });
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);

    const byCurrency = new Map<string, { debit: number; credit: number }>();
    for (const row of data as { currency: string; debit_balance: number; credit_balance: number }[]) {
      const bucket = byCurrency.get(row.currency) ?? { debit: 0, credit: 0 };
      bucket.debit += row.debit_balance;
      bucket.credit += row.credit_balance;
      byCurrency.set(row.currency, bucket);
    }

    expect(byCurrency.get('USD')?.debit).toBeCloseTo(byCurrency.get('USD')?.credit ?? -1, 6);
    expect(byCurrency.get('ZWG')?.debit).toBeCloseTo(byCurrency.get('ZWG')?.credit ?? -1, 6);
  });

  test('income statement keeps USD and ZWG revenue separate, not combined', async () => {
    const { data, error } = await admin.rpc('income_statement', {
      p_tenant_id: tenantId,
      p_from: '2026-04-01',
      p_to: '2026-04-30',
    });
    expect(error).toBeNull();

    const rows = data as { account_code: string; currency: string; amount: number }[];
    const usdRevenue = rows.find((r) => r.account_code === 'revenue' && r.currency === 'USD');
    const zwgRevenue = rows.find((r) => r.account_code === 'revenue' && r.currency === 'ZWG');
    const usdRent = rows.find((r) => r.account_code === 'expense_rent' && r.currency === 'USD');

    expect(usdRevenue?.amount).toBe(80);
    expect(zwgRevenue?.amount).toBe(90000);
    expect(usdRent?.amount).toBe(30);
  });

  test('balance sheet balances per currency via derived Retained Earnings', async () => {
    const { data, error } = await admin.rpc('balance_sheet', {
      p_tenant_id: tenantId,
      p_as_of: '2026-04-30',
    });
    expect(error).toBeNull();

    const rows = data as { account_type: string; currency: string; amount: number }[];
    const byCurrency = new Map<string, { assets: number; liabilitiesAndEquity: number }>();
    for (const row of rows) {
      const bucket = byCurrency.get(row.currency) ?? { assets: 0, liabilitiesAndEquity: 0 };
      if (row.account_type === 'asset') bucket.assets += row.amount;
      else bucket.liabilitiesAndEquity += row.amount;
      byCurrency.set(row.currency, bucket);
    }

    // USD: cash 80 (sale) - 30 (rent) = 50 asset; retained earnings = 80 - 30 = 50 equity.
    expect(byCurrency.get('USD')?.assets).toBeCloseTo(50, 6);
    expect(byCurrency.get('USD')?.assets).toBeCloseTo(byCurrency.get('USD')!.liabilitiesAndEquity, 6);
    // ZWG: cash 90000 asset; retained earnings = 90000 equity.
    expect(byCurrency.get('ZWG')?.assets).toBeCloseTo(90000, 6);
    expect(byCurrency.get('ZWG')?.assets).toBeCloseTo(byCurrency.get('ZWG')!.liabilitiesAndEquity, 6);
  });

  test('period_closes: monotonic guard, immutability, and consultant-only insert', async () => {
    // Signed in as the consultant, not the service role — service_role
    // has BYPASSRLS and would never actually exercise the
    // period_closes_insert_consultants policy's closed_by = auth.uid()
    // check, only the trigger. Using the real user proves the policy
    // itself permits a legitimate consultant close, not just that the
    // trigger fires.
    const asConsultant = await signInAs(consultantEmail);

    const { error: firstCloseErr } = await asConsultant.from('period_closes').insert({
      tenant_id: tenantId,
      closed_through: '2026-04-15',
      closed_by: consultantUserId,
    });
    expect(firstCloseErr).toBeNull();

    const { error: earlierCloseErr } = await asConsultant.from('period_closes').insert({
      tenant_id: tenantId,
      closed_through: '2026-04-10',
      closed_by: consultantUserId,
    });
    expect(earlierCloseErr).not.toBeNull();

    const { data: existing } = await admin
      .from('period_closes')
      .select('id')
      .eq('tenant_id', tenantId)
      .single();
    const { error: updateErr } = await admin
      .from('period_closes')
      .update({ note: 'edited' })
      .eq('id', existing!.id);
    expect(updateErr).not.toBeNull();

    const asClient = await signInAs(clientEmail);
    const { error: clientCloseErr } = await asClient.from('period_closes').insert({
      tenant_id: tenantId,
      closed_through: '2026-04-20',
      closed_by: clientUserId,
    });
    expect(clientCloseErr).not.toBeNull();
  });

  test('a closed period blocks an ordinary posting but not a consultant-authorized one', async () => {
    const dayId = await openDay('2026-04-16', 'USD', 10);

    // post_journal's period-lock check reads auth.uid(), which is null
    // under the service-role key — this has to be exercised as actual
    // signed-in users, the same reasoning as reverse_journal's own test.
    const asClient = await signInAs(clientEmail);
    const asConsultant = await signInAs(consultantEmail);

    // The period is closed through 2026-04-15 (previous test). Backdating
    // a sale's sold_at into that window should be rejected by post_journal
    // when the inserting user isn't a consultant.
    const { error: blockedErr } = await asClient.from('sales').insert({
      tenant_id: tenantId,
      cash_day_id: dayId,
      sold_at: '2026-04-10T12:00:00Z',
      description: 'backdated into closed period',
      amount: 5,
      currency: 'USD',
      payment_method: 'cash',
      recorded_by: clientUserId,
    });
    expect(blockedErr).not.toBeNull();
    expect(blockedErr!.message).toContain('closed period');

    // A consultant posting the same backdated entry is the authorized
    // path and should succeed.
    const { error: allowedErr } = await asConsultant.from('sales').insert({
      tenant_id: tenantId,
      cash_day_id: dayId,
      sold_at: '2026-04-10T12:00:00Z',
      description: 'consultant-authorized correction',
      amount: 5,
      currency: 'USD',
      payment_method: 'cash',
      recorded_by: consultantUserId,
    });
    expect(allowedErr).toBeNull();
  });
});
