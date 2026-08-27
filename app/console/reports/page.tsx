import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { formatMoney, todayIsoDate, startOfCurrentMonthIsoDate } from '@/lib/format';
import { closePeriod } from './actions';
import { CurrencyBadge } from '@/components/CurrencyBadge';

type ReportRow = {
  account_code: string;
  account_name: string;
  account_type: string;
  currency: 'USD' | 'ZWG';
};
type TrialBalanceRow = ReportRow & { debit_balance: number; credit_balance: number };
type AmountRow = ReportRow & { amount: number };

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string; asOf?: string; from?: string; to?: string }>;
}) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: memberships } = await supabase
    .from('tenant_memberships')
    .select('role, tenants (id, name)');
  const isConsultant = memberships?.some((m) => m.role === 'consultant') ?? false;
  if (!isConsultant) redirect('/client');

  const tenants = (memberships ?? [])
    .map((m) => (Array.isArray(m.tenants) ? m.tenants[0] : m.tenants))
    .filter((t): t is { id: string; name: string } => Boolean(t));

  const params = await searchParams;
  const tenantId = params.tenant;
  const asOf = params.asOf || todayIsoDate();
  const from = params.from || startOfCurrentMonthIsoDate();
  const to = params.to || todayIsoDate();

  if (!tenantId) {
    return (
      <div className="container-narrow">
        <h1>Reports</h1>
        {tenants.length === 0 ? (
          <p className="muted">No clients assigned to you yet.</p>
        ) : (
          <ul>
            {tenants.map((t) => (
              <li key={t.id}>
                <a href={`/console/reports?tenant=${t.id}`}>{t.name}</a>
              </li>
            ))}
          </ul>
        )}
        <p>
          <a href="/console">Back to console</a>
        </p>
      </div>
    );
  }

  const tenant = tenants.find((t) => t.id === tenantId);

  const [{ data: trialBalance }, { data: incomeStatement }, { data: balanceSheet }, { data: closes }] =
    await Promise.all([
      supabase.rpc('trial_balance', { p_tenant_id: tenantId, p_as_of: asOf }),
      supabase.rpc('income_statement', { p_tenant_id: tenantId, p_from: from, p_to: to }),
      supabase.rpc('balance_sheet', { p_tenant_id: tenantId, p_as_of: asOf }),
      supabase
        .from('period_closes')
        .select('closed_through, note, created_at')
        .eq('tenant_id', tenantId)
        .order('closed_through', { ascending: false })
        .limit(1),
    ]);

  const closedThrough = closes?.[0]?.closed_through as string | undefined;

  return (
    <>
      <div className="topbar">
        <div className="topbar-brand">
          <div className="topbar-mark" />
          <span>Console</span>
        </div>
        <span className="muted">/ Reports</span>
      </div>
      <div className="container">
        <p>
          <a href="/console/reports">All clients</a>
        </p>
        <h1>{tenant?.name ?? 'Reports'}</h1>

        <section className="card" style={{ marginBottom: '2rem' }}>
          <h2>Period close</h2>
          {closedThrough ? (
            <p>Closed through {closedThrough}. Postings on or before this date need a consultant.</p>
          ) : (
            <p className="muted">No period closed yet — everything is open.</p>
          )}
          <form action={closePeriod} style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <input type="hidden" name="tenant_id" value={tenantId} />
            <label className="field" style={{ marginBottom: 0 }}>
              <span className="field-label">Close through</span>
              <input
                type="date"
                name="closed_through"
                required
                min={closedThrough ? new Date(new Date(closedThrough).getTime() + 86400000).toISOString().slice(0, 10) : undefined}
                className="input"
              />
            </label>
            <label className="field" style={{ marginBottom: 0 }}>
              <span className="field-label">Note</span>
              <input type="text" name="note" placeholder="Note (optional)" className="input" />
            </label>
            <button type="submit" className="btn btn-primary">
              Close period
            </button>
          </form>
        </section>

        <section style={{ marginBottom: '2rem' }}>
          <h2>Trial balance</h2>
          <form method="get" style={{ marginBottom: '0.75rem', display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }}>
            <input type="hidden" name="tenant" value={tenantId} />
            <label className="field" style={{ marginBottom: 0 }}>
              <span className="field-label">As of</span>
              <input type="date" name="asOf" defaultValue={asOf} className="input" />
            </label>
            <button type="submit" className="btn btn-secondary">
              Update
            </button>
          </form>
          <ReportTable
            rows={trialBalance as TrialBalanceRow[] | null}
            columns={['Account', 'Currency', 'Debit', 'Credit']}
            render={(r: TrialBalanceRow) => [
              r.account_name,
              <CurrencyBadge key="currency" currency={r.currency} />,
              <span key="debit" className="money">{formatMoney(r.debit_balance, r.currency)}</span>,
              <span key="credit" className="money">{formatMoney(r.credit_balance, r.currency)}</span>,
            ]}
          />
        </section>

        <section style={{ marginBottom: '2rem' }}>
          <h2>Income statement</h2>
          <form method="get" style={{ marginBottom: '0.75rem', display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }}>
            <input type="hidden" name="tenant" value={tenantId} />
            <label className="field" style={{ marginBottom: 0 }}>
              <span className="field-label">From</span>
              <input type="date" name="from" defaultValue={from} className="input" />
            </label>
            <label className="field" style={{ marginBottom: 0 }}>
              <span className="field-label">To</span>
              <input type="date" name="to" defaultValue={to} className="input" />
            </label>
            <button type="submit" className="btn btn-secondary">
              Update
            </button>
          </form>
          <ReportTable
            rows={incomeStatement as AmountRow[] | null}
            columns={['Account', 'Type', 'Currency', 'Amount']}
            render={(r: AmountRow) => [
              r.account_name,
              r.account_type,
              <CurrencyBadge key="currency" currency={r.currency} />,
              <span key="amount" className="money">{formatMoney(r.amount, r.currency)}</span>,
            ]}
          />
        </section>

        <section>
          <h2>Balance sheet</h2>
          <p className="muted" style={{ fontSize: '0.9em' }}>As of {asOf} (uses the same date as the trial balance above).</p>
          <ReportTable
            rows={balanceSheet as AmountRow[] | null}
            columns={['Account', 'Type', 'Currency', 'Amount']}
            render={(r: AmountRow) => [
              r.account_name,
              r.account_type,
              <CurrencyBadge key="currency" currency={r.currency} />,
              <span key="amount" className="money">{formatMoney(r.amount, r.currency)}</span>,
            ]}
          />
        </section>
      </div>
    </>
  );
}

function ReportTable<T>({
  rows,
  columns,
  render,
}: {
  rows: T[] | null;
  columns: string[];
  render: (row: T) => React.ReactNode[];
}) {
  if (!rows || rows.length === 0) return <p className="muted">No activity.</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {render(row).map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
