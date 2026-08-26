// Verifies Phase 7 (supabase/migrations/0016): a credit purchase,
// supplier payment, or casual labour payment gets needs_approval=true
// only once it crosses a consultant-configured per-tenant/per-currency
// threshold (Blueprint §16) — an unconfigured decision type/currency
// never flags, and a cash purchase never flags regardless of amount
// (that control is the daily cash sheet itself). Also verifies the
// column-level-grant approve/sign-off shape: a client_user can't
// approve or sign off at all, and a consultant can't record someone
// else as the approver/signer (the exact-actor-match check added to
// all four RLS policies during self-review) or smuggle another column
// through the same UPDATE.
//
// Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_ANON_KEY
// — the approve/sign-off RLS policies and approval_thresholds' insert
// policy read auth.uid(), so they're exercised as signed-in users, not
// the service role (same lesson as reverse_journal/period_closes/
// run_asset_depreciation). Skips without them, same convention as the
// other suites. No afterAll cleanup — see the other test files for why.

import { describe, test, expect, beforeAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

const canRun = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);
const describeIfConfigured = canRun ? describe : describe.skip;

describeIfConfigured('approvals and stock sign-off (Phase 7)', () => {
  let admin: SupabaseClient;
  const suffix = `p7-test-${crypto.randomUUID().slice(0, 8)}`;
  const password = 'correct horse battery staple 7!';
  const clientEmail = `p7-client-${suffix}@example.test`;
  const consultantEmail = `p7-consultant-${suffix}@example.test`;
  const otherConsultantEmail = `p7-consultant2-${suffix}@example.test`;

  let tenantId: string;
  let clientUserId: string;
  let consultantUserId: string;
  let otherConsultantUserId: string;
  let cashDayId: string;
  let supplierId: string;
  let workerId: string;

  let asClient: SupabaseClient;
  let asConsultant: SupabaseClient;
  let asOtherConsultant: SupabaseClient;

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
      .insert({ name: `Phase 7 Test Tenant (${suffix})` })
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

    const { data: otherConsultantUser, error: con2Err } = await admin.auth.admin.createUser({
      email: otherConsultantEmail,
      password,
      email_confirm: true,
    });
    if (con2Err) throw con2Err;
    otherConsultantUserId = otherConsultantUser.user.id;

    const { error: mErr } = await admin.from('tenant_memberships').insert([
      { tenant_id: tenantId, user_id: clientUserId, role: 'client_user' },
      { tenant_id: tenantId, user_id: consultantUserId, role: 'consultant' },
      { tenant_id: tenantId, user_id: otherConsultantUserId, role: 'consultant' },
    ]);
    if (mErr) throw mErr;

    const { data: day, error: dErr } = await admin
      .from('cash_days')
      .insert({ tenant_id: tenantId, trade_date: '2026-07-01', currency: 'USD', opening_float: 500, opened_by: clientUserId })
      .select('id')
      .single();
    if (dErr) throw dErr;
    cashDayId = day.id;

    const { data: supplier, error: sErr } = await admin
      .from('suppliers')
      .insert({ tenant_id: tenantId, name: 'Harare Wholesalers' })
      .select('id')
      .single();
    if (sErr) throw sErr;
    supplierId = supplier.id;

    const { data: worker, error: wErr } = await admin
      .from('casual_workers')
      .insert({ tenant_id: tenantId, name: 'Farai' })
      .select('id')
      .single();
    if (wErr) throw wErr;
    workerId = worker.id;

    asClient = await signInAs(clientEmail);
    asConsultant = await signInAs(consultantEmail);
    asOtherConsultant = await signInAs(otherConsultantEmail);
  });

  test('a client_user cannot set an approval threshold, but a consultant can', async () => {
    const { error: clientErr } = await asClient.from('approval_thresholds').insert({
      tenant_id: tenantId,
      decision_type: 'credit_purchase',
      currency: 'USD',
      threshold_amount: 100,
      updated_by: clientUserId,
    });
    expect(clientErr).not.toBeNull();

    // On INSERT there's no trigger to normalize updated_by (the
    // touch_updated_at trigger is BEFORE UPDATE only) — the insert RLS
    // policy itself requires it to match the caller.
    const { data: threshold, error: consultantErr } = await asConsultant
      .from('approval_thresholds')
      .insert({
        tenant_id: tenantId,
        decision_type: 'credit_purchase',
        currency: 'USD',
        threshold_amount: 100,
        updated_by: consultantUserId,
      })
      .select('id, updated_by')
      .single();
    expect(consultantErr).toBeNull();
    expect(threshold?.updated_by).toBe(consultantUserId);

    // On UPDATE, the touch_updated_at trigger overwrites updated_by
    // with the real caller regardless of what's sent — even a lie
    // naming a different consultant.
    const { data: updated, error: updateErr } = await asOtherConsultant
      .from('approval_thresholds')
      .update({ threshold_amount: 120, updated_by: consultantUserId })
      .eq('id', threshold!.id)
      .select('updated_by, threshold_amount')
      .single();
    expect(updateErr).toBeNull();
    expect(updated?.updated_by).toBe(otherConsultantUserId);
    expect(updated?.threshold_amount).toBe(120);

    await asConsultant.from('approval_thresholds').insert([
      { tenant_id: tenantId, decision_type: 'supplier_payment', currency: 'USD', threshold_amount: 200, updated_by: consultantUserId },
      { tenant_id: tenantId, decision_type: 'casual_labour', currency: 'USD', threshold_amount: 20, updated_by: consultantUserId },
    ]);
  });

  test('a credit purchase over threshold flags needs_approval; at/under threshold and cash purchases never flag', async () => {
    const { data: overThreshold, error: overErr } = await admin
      .from('purchases')
      .insert({
        tenant_id: tenantId,
        cash_day_id: cashDayId,
        supplier_id: supplierId,
        payment_method: 'credit',
        description: 'Bulk stock',
        amount: 150,
        currency: 'USD',
        recorded_by: clientUserId,
      })
      .select('needs_approval')
      .single();
    expect(overErr).toBeNull();
    expect(overThreshold?.needs_approval).toBe(true);

    const { data: atThreshold } = await admin
      .from('purchases')
      .insert({
        tenant_id: tenantId,
        cash_day_id: cashDayId,
        supplier_id: supplierId,
        payment_method: 'credit',
        description: 'Exactly at threshold',
        amount: 120,
        currency: 'USD',
        recorded_by: clientUserId,
      })
      .select('needs_approval')
      .single();
    expect(atThreshold?.needs_approval).toBe(false);

    const { data: cashPurchase } = await admin
      .from('purchases')
      .insert({
        tenant_id: tenantId,
        cash_day_id: cashDayId,
        payment_method: 'cash',
        description: 'Big cash purchase, never flagged',
        amount: 999,
        currency: 'USD',
        recorded_by: clientUserId,
      })
      .select('needs_approval')
      .single();
    expect(cashPurchase?.needs_approval).toBe(false);

    // No threshold configured for ZWG at all — never flags regardless of amount.
    const { data: noThresholdCurrency } = await admin
      .from('purchases')
      .insert({
        tenant_id: tenantId,
        cash_day_id: cashDayId,
        supplier_id: supplierId,
        payment_method: 'credit',
        description: 'Credit purchase in an unconfigured currency',
        amount: 999999,
        currency: 'ZWG',
        exchange_rate_to_usd: 30,
        recorded_by: clientUserId,
      })
      .select('needs_approval')
      .single();
    expect(noThresholdCurrency?.needs_approval).toBe(false);
  });

  test('a supplier payment and a casual labour payment over their thresholds flag; under does not', async () => {
    const { data: flaggedPayment } = await admin
      .from('supplier_payments')
      .insert({
        tenant_id: tenantId,
        supplier_id: supplierId,
        cash_day_id: cashDayId,
        amount: 250,
        currency: 'USD',
        recorded_by: clientUserId,
      })
      .select('needs_approval')
      .single();
    expect(flaggedPayment?.needs_approval).toBe(true);

    const { data: smallPayment } = await admin
      .from('supplier_payments')
      .insert({
        tenant_id: tenantId,
        supplier_id: supplierId,
        cash_day_id: cashDayId,
        amount: 50,
        currency: 'USD',
        recorded_by: clientUserId,
      })
      .select('needs_approval')
      .single();
    expect(smallPayment?.needs_approval).toBe(false);

    const { data: flaggedLabour } = await admin
      .from('casual_labour_payments')
      .insert({
        tenant_id: tenantId,
        worker_id: workerId,
        cash_day_id: cashDayId,
        description: 'Big one-off job',
        amount: 25,
        currency: 'USD',
        recorded_by: clientUserId,
      })
      .select('needs_approval')
      .single();
    expect(flaggedLabour?.needs_approval).toBe(true);
  });

  test('only a consultant can approve, and only as themselves — never on behalf of another user or another column', async () => {
    const { data: flagged, error } = await admin
      .from('purchases')
      .insert({
        tenant_id: tenantId,
        cash_day_id: cashDayId,
        supplier_id: supplierId,
        payment_method: 'credit',
        description: 'To be approved',
        amount: 500,
        currency: 'USD',
        recorded_by: clientUserId,
      })
      .select('id')
      .single();
    expect(error).toBeNull();
    const purchaseId = flagged!.id;

    // A client_user has no UPDATE grant on this table at all anymore
    // (0016 revokes the blanket grant and re-grants only approved_by/
    // approved_at) — column-level grant, not just RLS.
    const { error: clientErr } = await asClient
      .from('purchases')
      .update({ approved_by: clientUserId, approved_at: new Date().toISOString() })
      .eq('id', purchaseId);
    expect(clientErr).not.toBeNull();

    // A consultant can't record someone else as the approver.
    const { error: impersonateErr } = await asConsultant
      .from('purchases')
      .update({ approved_by: otherConsultantUserId, approved_at: new Date().toISOString() })
      .eq('id', purchaseId);
    expect(impersonateErr).not.toBeNull();

    // A consultant can't smuggle another column through the same update
    // — the column-level GRANT only covers approved_by/approved_at.
    const { error: smuggleErr } = await asConsultant
      .from('purchases')
      .update({ approved_by: consultantUserId, approved_at: new Date().toISOString(), amount: 1 })
      .eq('id', purchaseId);
    expect(smuggleErr).not.toBeNull();

    // A consultant approving as themselves succeeds, and needs_approval
    // stays true (it's a fact about what applied at insert time, not
    // cleared on review).
    const { data: approved, error: approveErr } = await asConsultant
      .from('purchases')
      .update({ approved_by: consultantUserId, approved_at: new Date().toISOString() })
      .eq('id', purchaseId)
      .select('needs_approval, approved_by, approved_at')
      .single();
    expect(approveErr).toBeNull();
    expect(approved?.needs_approval).toBe(true);
    expect(approved?.approved_by).toBe(consultantUserId);
    expect(approved?.approved_at).not.toBeNull();
  });

  test('stock count sign-off follows the same shape: consultant-only, exact-actor-match', async () => {
    const { data: item, error: itemErr } = await admin
      .from('inventory_items')
      .insert({ tenant_id: tenantId, name: 'Bag of cement' })
      .select('id')
      .single();
    expect(itemErr).toBeNull();

    const { data: count, error: countErr } = await admin
      .from('stock_counts')
      .insert({ tenant_id: tenantId, inventory_item_id: item!.id, counted_quantity: 42, recorded_by: clientUserId })
      .select('id')
      .single();
    expect(countErr).toBeNull();
    const stockCountId = count!.id;

    const { error: clientErr } = await asClient
      .from('stock_counts')
      .update({ signed_off_by: clientUserId, signed_off_at: new Date().toISOString() })
      .eq('id', stockCountId);
    expect(clientErr).not.toBeNull();

    const { error: impersonateErr } = await asConsultant
      .from('stock_counts')
      .update({ signed_off_by: otherConsultantUserId, signed_off_at: new Date().toISOString() })
      .eq('id', stockCountId);
    expect(impersonateErr).not.toBeNull();

    const { data: signedOff, error: signErr } = await asConsultant
      .from('stock_counts')
      .update({ signed_off_by: consultantUserId, signed_off_at: new Date().toISOString() })
      .eq('id', stockCountId)
      .select('signed_off_by, signed_off_at')
      .single();
    expect(signErr).toBeNull();
    expect(signedOff?.signed_off_by).toBe(consultantUserId);
    expect(signedOff?.signed_off_at).not.toBeNull();
  });
});
