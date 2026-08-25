import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { formatMoney, todayIsoDate } from '@/lib/format';
import { addAsset, runDepreciation, disposeAsset } from './actions';

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
      <main style={{ padding: '2rem', maxWidth: 640 }}>
        <h1>Assets</h1>
        {tenants.length === 0 ? (
          <p>No clients assigned to you yet.</p>
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
      </main>
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
    <main style={{ padding: '2rem', maxWidth: 800 }}>
      <p>
        <a href="/console/assets">All clients</a>
      </p>
      <h1>{tenant?.name ?? 'Assets'}</h1>

      <section style={{ marginBottom: '2rem' }}>
        <h2>Asset register</h2>
        {!assets || assets.length === 0 ? (
          <p>Nothing on the register yet.</p>
        ) : (
          <table style={{ borderCollapse: 'collapse', width: '100%', marginBottom: '1rem' }}>
            <thead>
              <tr>
                {['Asset', 'Cost', 'Acquired', 'Life', 'Depreciated', 'Book value', 'Status', ''].map((h) => (
                  <th key={h} style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '0.3rem' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => {
                const bookValue = a.cost - a.accumulated_depreciation;
                return (
                  <tr key={a.id}>
                    <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>{a.name}</td>
                    <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>{formatMoney(a.cost, a.currency)}</td>
                    <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>{a.acquired_at}</td>
                    <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>{a.useful_life_months}mo</td>
                    <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>
                      {formatMoney(a.accumulated_depreciation, a.currency)}
                    </td>
                    <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>{formatMoney(bookValue, a.currency)}</td>
                    <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>
                      {a.disposed_at ? `disposed ${a.disposed_at}` : 'active'}
                    </td>
                    <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>
                      {!a.disposed_at && (
                        <>
                          <form action={runDepreciation} style={{ display: 'inline-block', marginRight: '0.5rem' }}>
                            <input type="hidden" name="asset_id" value={a.id} />
                            <input type="date" name="period_through" defaultValue={today} required style={{ padding: '0.2rem', width: '9rem' }} />
                            <button type="submit" style={{ padding: '0.2rem 0.4rem' }}>
                              Depreciate
                            </button>
                          </form>
                          <form action={disposeAsset} style={{ display: 'inline-block' }}>
                            <input type="hidden" name="asset_id" value={a.id} />
                            <input type="date" name="disposed_at" defaultValue={today} required style={{ padding: '0.2rem', width: '9rem' }} />
                            <input type="number" name="proceeds" step="0.01" min="0" placeholder="Proceeds" style={{ padding: '0.2rem', width: '6rem' }} />
                            <button type="submit" style={{ padding: '0.2rem 0.4rem' }}>
                              Dispose
                            </button>
                          </form>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <form action={addAsset}>
          <input type="hidden" name="tenant_id" value={tenantId} />
          <input type="text" name="name" placeholder="Asset name" required style={{ padding: '0.4rem', marginRight: '0.5rem' }} />
          <input type="number" name="cost" step="0.01" min="0" placeholder="Cost" required style={{ padding: '0.4rem', marginRight: '0.5rem', width: '7rem' }} />
          <select name="currency" style={{ marginRight: '0.5rem' }}>
            <option value="USD">USD</option>
            <option value="ZWG">ZWG</option>
          </select>
          <input type="date" name="acquired_at" required style={{ padding: '0.4rem', marginRight: '0.5rem' }} />
          <input type="number" name="useful_life_months" min="1" placeholder="Useful life (months)" required style={{ padding: '0.4rem', marginRight: '0.5rem', width: '10rem' }} />
          <button type="submit" style={{ padding: '0.4rem 0.75rem' }}>
            Add to register
          </button>
        </form>
      </section>
    </main>
  );
}
