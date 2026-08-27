import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';

export default async function ClientHome() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: tenants } = await supabase
    .from('tenants')
    .select('id, name, formalization_stage');

  return (
    <main className="container-narrow">
      <h1>Your business</h1>
      {tenants && tenants.length > 0 ? (
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          {tenants.map((t) => (
            <div key={t.id}>
              <strong>{t.name}</strong>
              <p className="muted" style={{ margin: '0.25rem 0 0' }}>{t.formalization_stage}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">No business is linked to this login yet. Contact your consultant.</p>
      )}
      {tenants && tenants.length > 0 && (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <a className="tile" href="/client/day">Today&apos;s cash sheet</a>
          <a className="tile" href="/client/debtors">Who owes you</a>
          <a className="tile" href="/client/creditors">Who you owe</a>
          <a className="tile" href="/client/inventory">Stock</a>
          <a className="tile" href="/client/labour">Paying someone who helps</a>
        </div>
      )}
    </main>
  );
}
