import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { todayIsoDate } from '@/lib/format';
import { CurrencyBadge } from '@/components/CurrencyBadge';
import { StatusBadge } from '@/components/StatusBadge';

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
    <>
      <div className="topbar">
        <div className="topbar-brand">
          <div className="topbar-mark" />
          <span>Console</span>
        </div>
        <span className="muted">/ Dashboard</span>
      </div>
      <div className="container">
        <p className="muted">Signed in as {user.email}.</p>

        <nav style={{ marginBottom: '1.5rem' }}>
          <a href="/console/approvals" className="btn btn-secondary btn-sm">
            Approvals queue
          </a>
        </nav>

        <h2>Assigned clients</h2>
        {summaries.length === 0 ? (
          <p className="muted">No clients assigned to you yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  {['Client', 'Today', 'Pending approvals', 'Unsigned counts', 'Overdue compliance', ''].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {summaries.map((s) => (
                  <tr key={s.tenant.id}>
                    <td>
                      <strong>{s.tenant.name}</strong>
                      <br />
                      <span className="muted" style={{ fontSize: '0.85em' }}>{s.tenant.formalization_stage}</span>
                    </td>
                    <td>
                      {s.cashDays.length === 0 ? (
                        <span className="muted">not started</span>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                          {s.cashDays.map((d) => (
                            <span key={d.currency} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                              <CurrencyBadge currency={d.currency} />
                              <StatusBadge severity={d.status === 'closed' ? 'ok' : 'pending'}>{d.status}</StatusBadge>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>
                      {s.pendingApprovals > 0 ? (
                        <StatusBadge severity="pending">{s.pendingApprovals}</StatusBadge>
                      ) : (
                        <span className="muted">0</span>
                      )}
                    </td>
                    <td>
                      {s.unsignedCounts > 0 ? (
                        <StatusBadge severity="pending">{s.unsignedCounts}</StatusBadge>
                      ) : (
                        <span className="muted">0</span>
                      )}
                    </td>
                    <td>
                      {s.overdueItems > 0 ? (
                        <StatusBadge severity="urgent">{s.overdueItems}</StatusBadge>
                      ) : (
                        <span className="muted">0</span>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
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
          </div>
        )}
      </div>
    </>
  );
}
