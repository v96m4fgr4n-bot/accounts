import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { todayIsoDate } from '@/lib/format';
import { addAsset, runDepreciation, disposeAsset } from './actions';
import { Money } from '@/components/CurrencyBadge';

export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string }>;
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

  if (!tenantId) {
    return (
      <div className="container-narrow">
        <h1>Assets</h1>
        {tenants.length === 0 ? (
          <p className="muted">No clients assigned to you yet.</p>
        ) : (
          <ul>
            {tenants.map((t) => (
              <li key={t.id}>
                <a href={`/console/assets?tenant=${t.id}`}>{t.name}</a>
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

  const { data: assets } = await supabase
    .from('assets')
    .select('id, name, cost, currency, acquired_at, useful_life_months, accumulated_depreciation, disposed_at, disposal_proceeds')
    .eq('tenant_id', tenantId)
    .order('acquired_at');

  const today = todayIsoDate();

  return (
    <>
      <div className="topbar">
        <div className="topbar-brand">
          <div className="topbar-mark" />
          <span>Console</span>
        </div>
        <span className="muted">/ Assets</span>
      </div>
      <div className="container">
        <p>
          <a href="/console/assets">All clients</a>
        </p>
        <h1>{tenant?.name ?? 'Assets'}</h1>

        <section style={{ marginBottom: '2rem' }}>
          <h2>Asset register</h2>
          {!assets || assets.length === 0 ? (
            <p className="muted">Nothing on the register yet.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table" style={{ marginBottom: '1rem' }}>
                <thead>
                  <tr>
                    {['Asset', 'Cost', 'Acquired', 'Life', 'Depreciated', 'Book value', 'Status', ''].map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {assets.map((a) => {
                    const bookValue = a.cost - a.accumulated_depreciation;
                    return (
                      <tr key={a.id}>
                        <td>{a.name}</td>
                        <td>
                          <Money amount={a.cost} currency={a.currency} />
                        </td>
                        <td>{a.acquired_at}</td>
                        <td>{a.useful_life_months}mo</td>
                        <td>
                          <Money amount={a.accumulated_depreciation} currency={a.currency} />
                        </td>
                        <td>
                          <Money amount={bookValue} currency={a.currency} />
                        </td>
                        <td>{a.disposed_at ? `disposed ${a.disposed_at}` : <span className="muted">active</span>}</td>
                        <td>
                          {!a.disposed_at && (
                            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                              <form action={runDepreciation} style={{ display: 'flex', gap: '0.3rem' }}>
                                <input type="hidden" name="asset_id" value={a.id} />
                                <input type="date" name="period_through" defaultValue={today} required className="input" style={{ width: '9rem' }} />
                                <button type="submit" className="btn btn-secondary btn-sm">
                                  Depreciate
                                </button>
                              </form>
                              <form action={disposeAsset} style={{ display: 'flex', gap: '0.3rem' }}>
                                <input type="hidden" name="asset_id" value={a.id} />
                                <input type="date" name="disposed_at" defaultValue={today} required className="input" style={{ width: '9rem' }} />
                                <input type="number" name="proceeds" step="0.01" min="0" placeholder="Proceeds" className="input" style={{ width: '6rem' }} />
                                <button type="submit" className="btn btn-secondary btn-sm">
                                  Dispose
                                </button>
                              </form>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <form action={addAsset} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="hidden" name="tenant_id" value={tenantId} />
            <input type="text" name="name" placeholder="Asset name" required className="input" style={{ width: 'auto' }} />
            <input type="number" name="cost" step="0.01" min="0" placeholder="Cost" required className="input" style={{ width: '7rem' }} />
            <select name="currency" className="input" style={{ width: 'auto' }}>
              <option value="USD">USD</option>
              <option value="ZWG">ZWG</option>
            </select>
            <input type="date" name="acquired_at" required className="input" style={{ width: 'auto' }} />
            <input type="number" name="useful_life_months" min="1" placeholder="Useful life (months)" required className="input" style={{ width: '10rem' }} />
            <button type="submit" className="btn btn-primary">
              Add to register
            </button>
          </form>
        </section>
      </div>
    </>
  );
}
