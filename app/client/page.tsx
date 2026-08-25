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
    <main style={{ padding: '2rem', maxWidth: 640 }}>
      <h1>Your business</h1>
      {tenants && tenants.length > 0 ? (
        <ul>
          {tenants.map((t) => (
            <li key={t.id}>
              <strong>{t.name}</strong> — {t.formalization_stage}
            </li>
          ))}
        </ul>
      ) : (
        <p>No business is linked to this login yet. Contact your consultant.</p>
      )}
      {tenants && tenants.length > 0 && (
        <ul>
          <li>
            <a href="/client/day">Today&apos;s cash sheet</a>
          </li>
          <li>
            <a href="/client/debtors">Who owes you</a>
          </li>
          <li>
            <a href="/client/creditors">Who you owe</a>
          </li>
          <li>
            <a href="/client/inventory">Stock</a>
          </li>
        </ul>
      )}
    </main>
  );
}
