// Verifies CLAUDE.md non-negotiable #2: tenant isolation is enforced by
// Postgres RLS, not application code. This test never filters by
// tenant_id itself — it signs in as each user and lets RLS alone decide
// what comes back, so a policy bug (or a missing `force row level
// security`) fails the test the same way it would fail in production.
//
// Requires a Supabase instance (local `supabase start`, or a disposable
// test project) with migrations from supabase/migrations applied, plus:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
// Skips (not fails) when these aren't set, so `vitest run` stays green
// in environments without Supabase configured.

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

const canRun = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);
const describeIfConfigured = canRun ? describe : describe.skip;

describeIfConfigured('tenant RLS isolation', () => {
  let admin: SupabaseClient;

  const suffix = 'rls-test';
  const tenantAName = `Tenant A (${suffix})`;
  const tenantBName = `Tenant B (${suffix})`;
  const userAEmail = `owner-a-${suffix}@example.test`;
  const userBEmail = `owner-b-${suffix}@example.test`;
  const password = 'correct horse battery staple 1!';

  let tenantAId: string;
  let tenantBId: string;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: tenantA, error: tErrA } = await admin
      .from('tenants')
      .insert({ name: tenantAName })
      .select('id')
      .single();
    if (tErrA) throw tErrA;
    tenantAId = tenantA.id;

    const { data: tenantB, error: tErrB } = await admin
      .from('tenants')
      .insert({ name: tenantBName })
      .select('id')
      .single();
    if (tErrB) throw tErrB;
    tenantBId = tenantB.id;

    const { data: userA, error: uErrA } = await admin.auth.admin.createUser({
      email: userAEmail,
      password,
      email_confirm: true,
    });
    if (uErrA) throw uErrA;
    userAId = userA.user.id;

    const { data: userB, error: uErrB } = await admin.auth.admin.createUser({
      email: userBEmail,
      password,
      email_confirm: true,
    });
    if (uErrB) throw uErrB;
    userBId = userB.user.id;

    const { error: mErr } = await admin.from('tenant_memberships').insert([
      { tenant_id: tenantAId, user_id: userAId, role: 'client_user' },
      { tenant_id: tenantBId, user_id: userBId, role: 'client_user' },
    ]);
    if (mErr) throw mErr;
  });

  afterAll(async () => {
    if (userAId) await admin.auth.admin.deleteUser(userAId);
    if (userBId) await admin.auth.admin.deleteUser(userBId);
    if (tenantAId) await admin.from('tenants').delete().eq('id', tenantAId);
    if (tenantBId) await admin.from('tenants').delete().eq('id', tenantBId);
  });

  async function signInAs(email: string) {
    const client = createClient(SUPABASE_URL!, ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return client;
  }

  test('a user reading tenants sees only their own tenant', async () => {
    const asUserA = await signInAs(userAEmail);

    const { data, error } = await asUserA.from('tenants').select('id, name');

    expect(error).toBeNull();
    const ids = (data ?? []).map((row) => row.id);
    expect(ids).toContain(tenantAId);
    expect(ids).not.toContain(tenantBId);
  });

  test("a user cannot read another tenant's row by direct id lookup", async () => {
    const asUserA = await signInAs(userAEmail);

    const { data, error } = await asUserA
      .from('tenants')
      .select('id')
      .eq('id', tenantBId)
      .maybeSingle();

    // RLS makes the row invisible rather than erroring — a crafted
    // request for another tenant's id must come back empty, not denied
    // with detail that confirms the row exists.
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  test('a user reading memberships sees only their own membership row', async () => {
    const asUserA = await signInAs(userAEmail);

    const { data, error } = await asUserA
      .from('tenant_memberships')
      .select('tenant_id, user_id');

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].user_id).toBe(userAId);
    expect(data![0].tenant_id).toBe(tenantAId);
  });

  test('a user cannot insert a membership granting themselves another tenant', async () => {
    const asUserA = await signInAs(userAEmail);

    const { error } = await asUserA
      .from('tenant_memberships')
      .insert({ tenant_id: tenantBId, user_id: userAId, role: 'consultant' });

    // No insert policy exists yet (Phase 0 is read-only client-side), so
    // this must be rejected by RLS, not silently accepted.
    expect(error).not.toBeNull();
  });
});
