import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { formatMoney, todayIsoDate, startOfCurrentMonthIsoDate } from '@/lib/format';
import { reverseJournalEntry } from './actions';
import { CurrencyBadge } from '@/components/CurrencyBadge';

type Line = {
  side: 'debit' | 'credit';
  amount: number;
  accounts: { code: string; name: string } | { code: string; name: string }[] | null;
};

type Entry = {
  id: string;
  entry_date: string;
  currency: 'USD' | 'ZWG';
  description: string;
  source_type: string;
  reverses: string | null;
  journal_lines: Line[];
};

export default async function JournalPage({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string; from?: string; to?: string }>;
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
  const from = params.from || startOfCurrentMonthIsoDate();
  const to = params.to || todayIsoDate();

  if (!tenantId) {
    return (
      <div className="container-narrow">
        <h1>Journal</h1>
        {tenants.length === 0 ? (
          <p className="muted">No clients assigned to you yet.</p>
        ) : (
          <ul>
            {tenants.map((t) => (
              <li key={t.id}>
                <a href={`/console/journal?tenant=${t.id}`}>{t.name}</a>
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

  const { data: entries } = await supabase
    .from('journal_entries')
    .select('id, entry_date, currency, description, source_type, reverses, journal_lines (side, amount, accounts (code, name))')
    .eq('tenant_id', tenantId)
    .gte('entry_date', from)
    .lte('entry_date', to)
    .order('entry_date', { ascending: false })
    .order('id', { ascending: false });

  const rows = (entries ?? []) as unknown as Entry[];
  const reversedIds = new Set(rows.filter((e) => e.reverses).map((e) => e.reverses as string));

  return (
    <>
      <div className="topbar">
        <div className="topbar-brand">
          <div className="topbar-mark" />
          <span>Console</span>
        </div>
        <span className="muted">/ Journal</span>
      </div>
      <div className="container">
        <p>
          <a href="/console/journal">All clients</a>
        </p>
        <h1>{tenant?.name ?? 'Journal'}</h1>

        <form method="get" className="card" style={{ marginBottom: '1.5rem', display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
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

        {rows.length === 0 ? (
          <p className="muted">No journal entries in this range.</p>
        ) : (
          rows.map((entry) => {
            const lines = Array.isArray(entry.journal_lines) ? entry.journal_lines : [];
            const alreadyReversed = reversedIds.has(entry.id);
            return (
              <section key={entry.id} className="card" style={{ marginBottom: '1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '1rem', flexWrap: 'wrap' }}>
                  <strong>
                    {entry.entry_date} — {entry.description}
                  </strong>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                    <CurrencyBadge currency={entry.currency} />
                    <span className="badge" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
                      {entry.source_type}
                      {entry.reverses ? ' (reversal)' : ''}
                    </span>
                  </span>
                </div>
                <div style={{ overflowX: 'auto', marginTop: '0.75rem' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        {['Account', 'Debit', 'Credit'].map((h) => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line, i) => {
                        const account = Array.isArray(line.accounts) ? line.accounts[0] : line.accounts;
                        return (
                          <tr key={i}>
                            <td>{account ? `${account.name} (${account.code})` : '—'}</td>
                            <td className="money">
                              {line.side === 'debit' ? formatMoney(line.amount, entry.currency) : ''}
                            </td>
                            <td className="money">
                              {line.side === 'credit' ? formatMoney(line.amount, entry.currency) : ''}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {entry.source_type !== 'reversal' && (
                  <div style={{ marginTop: '0.75rem' }}>
                    {alreadyReversed ? (
                      <span className="muted" style={{ fontSize: '0.85em' }}>Already reversed.</span>
                    ) : (
                      <form action={reverseJournalEntry} style={{ display: 'flex', gap: '0.5rem' }}>
                        <input type="hidden" name="tenant_id" value={tenantId} />
                        <input type="hidden" name="journal_entry_id" value={entry.id} />
                        <input
                          type="text"
                          name="reason"
                          placeholder="Reason for reversal"
                          required
                          className="input"
                          style={{ flex: 1 }}
                        />
                        <button type="submit" className="btn btn-secondary btn-sm">
                          Reverse
                        </button>
                      </form>
                    )}
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>
    </>
  );
}
