import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { todayIsoDate } from '@/lib/format';

export default async function ConsoleHome() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: memberships } = await supabase
    .from('tenant_memberships')
    .select('role');
  const isConsultant = memberships?.some((m) => m.role === 'consultant') ?? false;
  if (!isConsultant) redirect('/client');

  const { data: tenants } = await supabase
    .from('tenants')
    .select('id, name, formalization_stage')
    .order('name');

  const today = todayIsoDate();

  const summaries = await Promise.all(
    (tenants ?? []).map(async (t) => {
      const [cashDays, pendingApprovals, unsignedCounts, overdueItems] = await Promise.all([
        supabase
          .from('cash_days')
          .select('currency, status')
          .eq('tenant_id', t.id)
          .eq('trade_date', today),
        Promise.all([
          supabase
            .from('purchases')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', t.id)
            .eq('needs_approval', true)
            .is('approved_by', null),
          supabase
            .from('supplier_payments')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', t.id)
            .eq('needs_approval', true)
            .is('approved_by', null),
          supabase
            .from('casual_labour_payments')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', t.id)
            .eq('needs_approval', true)
            .is('approved_by', null),
        ]).then((results) => results.reduce((sum, r) => sum + (r.count ?? 0), 0)),
        supabase
          .from('stock_counts')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', t.id)
          .is('signed_off_by', null),
        supabase
          .from('compliance_items')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', t.id)
          .lt('due_date', today)
          .not('status', 'in', '(filed,confirmed)'),
      ]);

      return {
        tenant: t,
        cashDays: cashDays.data ?? [],
        pendingApprovals,
        unsignedCounts: unsignedCounts.count ?? 0,
        overdueItems: overdueItems.count ?? 0,
      };
    }),
  );

  return (
    <main style={{ padding: '2rem', maxWidth: 1000 }}>
      <h1>Console</h1>
      <p>Signed in as {user.email}.</p>

      <nav style={{ marginBottom: '1.5rem' }}>
        <a href="/console/approvals" style={{ marginRight: '1rem' }}>
          Approvals queue
        </a>
      </nav>

      <h2>Assigned clients</h2>
      {summaries.length === 0 ? (
        <p>No clients assigned to you yet.</p>
      ) : (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              {['Client', 'Today', 'Pending approvals', 'Unsigned counts', 'Overdue compliance', ''].map((h) => (
                <th key={h} style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '0.4rem' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {summaries.map((s) => (
              <tr key={s.tenant.id}>
                <td style={{ padding: '0.4rem', borderBottom: '1px solid #eee' }}>
                  <strong>{s.tenant.name}</strong>
                  <br />
                  <span style={{ fontSize: '0.85em', color: '#666' }}>{s.tenant.formalization_stage}</span>
                </td>
                <td style={{ padding: '0.4rem', borderBottom: '1px solid #eee' }}>
                  {s.cashDays.length === 0
                    ? 'not started'
                    : s.cashDays.map((d) => `${d.currency}: ${d.status}`).join(', ')}
                </td>
                <td style={{ padding: '0.4rem', borderBottom: '1px solid #eee', color: s.pendingApprovals > 0 ? 'crimson' : undefined }}>
                  {s.pendingApprovals}
                </td>
                <td style={{ padding: '0.4rem', borderBottom: '1px solid #eee' }}>{s.unsignedCounts}</td>
                <td style={{ padding: '0.4rem', borderBottom: '1px solid #eee', color: s.overdueItems > 0 ? 'crimson' : undefined }}>
                  {s.overdueItems}
                </td>
                <td style={{ padding: '0.4rem', borderBottom: '1px solid #eee', whiteSpace: 'nowrap' }}>
                  <a href={`/console/reports?tenant=${s.tenant.id}`}>reports</a>{' '}
                  <a href={`/console/journal?tenant=${s.tenant.id}`}>journal</a>{' '}
                  <a href={`/console/compliance?tenant=${s.tenant.id}`}>compliance</a>{' '}
                  <a href={`/console/banking?tenant=${s.tenant.id}`}>banking</a>{' '}
                  <a href={`/console/assets?tenant=${s.tenant.id}`}>assets</a>{' '}
                  <a href={`/console/approvals?tenant=${s.tenant.id}`}>approvals</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
