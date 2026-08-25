// Verifies Phase 5 (supabase/migrations/0012): tax_settings is
// consultant-only to write and immutable once recorded (non-negotiable
// #5/#6), compliance_items can be created/updated by any tenant member
// per the Blueprint's "owner or consulting team, jointly" (§16), the
// tenants UPDATE path is scoped to exactly formalization_stage/
// vat_registered via a column-level grant (not the whole row), the
// vat_registered-requires-formalized check constraint, and a penalty
// posts its journal and shows up in cash_day_summary's till
// reconciliation.
//
// Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_ANON_KEY
// (several checks read auth.uid(), so have to run as a signed-in user).
// Skips without them. No afterAll cleanup — see the other test files.

import { describe, test, expect, beforeAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

const canRun = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);
const describeIfConfigured = canRun ? describe : describe.skip;

describeIfConfigured('compliance (Phase 5)', () => {
  let admin: SupabaseClient;
  const suffix = `compliance-test-${crypto.randomUUID().slice(0, 8)}`;
  const password = 'correct horse battery staple 6!';
  const clientEmail = `compliance-client-${suffix}@example.test`;
  const consultantEmail = `compliance-consultant-${suffix}@example.test`;

  let tenantId: string;
  let clientUserId: string;
  let consultantUserId: string;

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
      .insert({ name: `Compliance Test Tenant (${suffix})`, formalization_stage: 'presumptive' })
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
  });

  test('tax_settings: consultant can record a figure, client_user cannot, and it is immutable', async () => {
    const asConsultant = await signInAs(consultantEmail);
    const { error: consultantErr } = await asConsultant.from('tax_settings').insert({
      setting_key: `vat_threshold_usd_${suffix}`,
      value: 25000,
      effective_from: '2026-01-01',
      created_by: consultantUserId,
    });
    expect(consultantErr).toBeNull();

    const asClient = await signInAs(clientEmail);
    const { error: clientErr } = await asClient.from('tax_settings').insert({
      setting_key: `vat_threshold_usd_${suffix}_2`,
      value: 25000,
      effective_from: '2026-01-01',
      created_by: clientUserId,
    });
    expect(clientErr).not.toBeNull();

    const { data: existing } = await admin
      .from('tax_settings')
      .select('id')
      .eq('setting_key', `vat_threshold_usd_${suffix}`)
      .single();
    const { error: updateErr } = await admin
      .from('tax_settings')
      .update({ value: 30000 })
      .eq('id', existing!.id);
    expect(updateErr).not.toBeNull();
  });

  test('current_tax_setting resolves the value in effect as of a date', async () => {
    const key = `presumptive_flat_usd_${suffix}`;
    await admin.from('tax_settings').insert([
      { setting_key: key, value: 30, effective_from: '2025-01-01', created_by: consultantUserId },
      { setting_key: key, value: 40, effective_from: '2026-01-01', created_by: consultantUserId },
    ]);

    const { data: before, error: beforeErr } = await admin.rpc('current_tax_setting', {
      p_key: key,
      p_as_of: '2025-06-01',
    });
    expect(beforeErr).toBeNull();
    expect(before).toBe(30);

    const { data: after } = await admin.rpc('current_tax_setting', { p_key: key, p_as_of: '2026-06-01' });
    expect(after).toBe(40);
  });

  test('compliance_items: any tenant member can add and progress an item (owner/consultant, jointly)', async () => {
    const asClient = await signInAs(clientEmail);
    const { data: item, error: insertErr } = await asClient
      .from('compliance_items')
      .insert({
        tenant_id: tenantId,
        obligation_type: 'presumptive_tax',
        period_label: '2026-04',
        due_date: '2026-05-10',
        created_by: clientUserId,
      })
      .select('id')
      .single();
    expect(insertErr).toBeNull();

    const { error: updateErr } = await asClient
      .from('compliance_items')
      .update({ status: 'prepared' })
      .eq('id', item!.id);
    expect(updateErr).toBeNull();

    const asConsultant = await signInAs(consultantEmail);
    const { error: consultantUpdateErr } = await asConsultant
      .from('compliance_items')
      .update({ status: 'filed' })
      .eq('id', item!.id);
    expect(consultantUpdateErr).toBeNull();

    const { data: after } = await admin.from('compliance_items').select('status').eq('id', item!.id).single();
    expect(after?.status).toBe('filed');
  });

  test('tenants: a consultant can update formalization_stage/vat_registered but not other columns, and vat requires formalized', async () => {
    const asConsultant = await signInAs(consultantEmail);

    const { error: vatWithoutFormalErr } = await asConsultant
      .from('tenants')
      .update({ formalization_stage: 'unregistered', vat_registered: true })
      .eq('id', tenantId);
    expect(vatWithoutFormalErr).not.toBeNull();

    const { error: validErr } = await asConsultant
      .from('tenants')
      .update({ formalization_stage: 'registered', vat_registered: true })
      .eq('id', tenantId);
    expect(validErr).toBeNull();

    // The column-level grant only covers formalization_stage/
    // vat_registered — attempting to also change name in the same
    // request must be rejected outright, not silently ignored.
    const { error: nameErr } = await asConsultant
      .from('tenants')
      .update({ name: 'renamed by a consultant', vat_registered: true })
      .eq('id', tenantId);
    expect(nameErr).not.toBeNull();

    const asClient = await signInAs(clientEmail);
    const { error: clientErr } = await asClient
      .from('tenants')
      .update({ vat_registered: false })
      .eq('id', tenantId);
    expect(clientErr).not.toBeNull();
  });

  test('a penalty posts DR Penalties Expense / CR Cash and appears in cash_day_summary', async () => {
    const { data: day, error: dayErr } = await admin
      .from('cash_days')
      .insert({ tenant_id: tenantId, trade_date: '2026-05-01', currency: 'USD', opening_float: 50, opened_by: clientUserId })
      .select('id')
      .single();
    expect(dayErr).toBeNull();

    await admin.from('sales').insert({
      tenant_id: tenantId,
      cash_day_id: day!.id,
      sold_at: '2026-05-01T09:00:00Z',
      description: 'sale',
      amount: 20,
      currency: 'USD',
      payment_method: 'cash',
      recorded_by: clientUserId,
    });

    const { data: penalty, error: penaltyErr } = await admin
      .from('compliance_penalties')
      .insert({
        tenant_id: tenantId,
        cash_day_id: day!.id,
        paid_at: '2026-05-01T10:00:00Z',
        description: 'Late presumptive tax filing penalty',
        amount: 8,
        currency: 'USD',
        recorded_by: clientUserId,
      })
      .select('id')
      .single();
    expect(penaltyErr).toBeNull();

    const { data: entry } = await admin
      .from('journal_entries')
      .select('id')
      .eq('source_type', 'penalty')
      .eq('source_id', penalty!.id)
      .single();
    const { data: lines } = await admin
      .from('journal_lines')
      .select('account_id, side, amount')
      .eq('journal_entry_id', entry!.id)
      .order('side');
    const { data: penaltyAccount } = await admin
      .from('accounts')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('code', 'expense_penalties')
      .single();
    const { data: cashAccount } = await admin
      .from('accounts')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('code', 'cash_usd')
      .single();
    expect(lines).toEqual([
      { account_id: cashAccount!.id, side: 'credit', amount: 8 },
      { account_id: penaltyAccount!.id, side: 'debit', amount: 8 },
    ]);

    // expected = 50 opening + 20 cash sale - 8 penalty = 62
    const { data: summary } = await admin
      .from('cash_day_summary')
      .select('penalties_total, expected_cash')
      .eq('cash_day_id', day!.id)
      .single();
    expect(summary?.penalties_total).toBe(8);
    expect(summary?.expected_cash).toBe(62);
  });
});
