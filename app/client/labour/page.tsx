import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { getPrimaryTenant } from '@/lib/tenant';
import { formatMoney, todayIsoDate } from '@/lib/format';
import { logCasualLabourPayment } from './actions';

export default async function LabourPage({
  searchParams,
}: {
  searchParams: Promise<{ currency?: string }>;
}) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const tenant = await getPrimaryTenant(supabase);
  if (!tenant) {
    return (
      <main style={{ padding: '1.5rem', maxWidth: 480 }}>
        <p>No business is linked to this login yet. Contact your consultant.</p>
      </main>
    );
  }

  const params = await searchParams;
  const currency: 'USD' | 'ZWG' = params.currency === 'ZWG' ? 'ZWG' : 'USD';

  const { data: cashDay } = await supabase
    .from('cash_days')
    .select('id, status')
    .eq('trade_date', todayIsoDate())
    .eq('currency', currency)
    .maybeSingle();

  const { data: recent } = await supabase
    .from('casual_labour_payments')
    .select('id, description, amount, paid_at, casual_workers ( name )')
    .eq('currency', currency)
    .order('paid_at', { ascending: false })
    .limit(20);

  return (
    <main style={{ padding: '1.5rem', maxWidth: 640 }}>
      <p style={{ marginBottom: 0 }}>{tenant.name}</p>
      <h1 style={{ marginTop: '0.25rem' }}>Paying someone who helps</h1>

      {cashDay && cashDay.status === 'open' ? (
        <form action={logCasualLabourPayment} style={{ marginBottom: '1.5rem' }}>
          <input type="hidden" name="tenant_id" value={tenant.id} />
          <input type="hidden" name="cash_day_id" value={cashDay.id} />
          <input type="hidden" name="currency" value={currency} />
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>
            Who was paid
            <input type="text" name="worker_name" required style={{ display: 'block', width: '100%', padding: '0.5rem' }} />
          </label>
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>
            What for
            <input type="text" name="description" required style={{ display: 'block', width: '100%', padding: '0.5rem' }} />
          </label>
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>
            Amount ({currency})
            <input type="number" name="amount" step="0.01" min="0" required style={{ display: 'block', width: '100%', padding: '0.5rem' }} />
          </label>
          {currency === 'ZWG' && (
            <label style={{ display: 'block', marginBottom: '0.5rem' }}>
              Rate used today
              <input type="number" name="exchange_rate_to_usd" step="0.0001" min="0" required style={{ display: 'block', width: '100%', padding: '0.5rem' }} />
            </label>
          )}
          <button type="submit" style={{ padding: '0.5rem 1rem' }}>
            Log payment
          </button>
        </form>
      ) : (
        <p>
          <a href={`/client/day?currency=${currency}`}>Start today&apos;s {currency} cash day</a> to log a payment.
        </p>
      )}

      <nav style={{ marginBottom: '1.5rem' }}>
        <a href="/client/labour?currency=USD" style={{ marginRight: '1rem', fontWeight: currency === 'USD' ? 'bold' : 'normal' }}>
          USD
        </a>
        <a href="/client/labour?currency=ZWG" style={{ fontWeight: currency === 'ZWG' ? 'bold' : 'normal' }}>
          ZWG
        </a>
      </nav>

      {recent && recent.length > 0 && (
        <section>
          <h2>Recent payments</h2>
          <ul>
            {recent.map((r) => {
              const worker = Array.isArray(r.casual_workers) ? r.casual_workers[0] : r.casual_workers;
              return (
                <li key={r.id}>
                  {String(r.paid_at).slice(0, 10)} — {worker?.name ?? 'unknown'} — {r.description} —{' '}
                  {formatMoney(r.amount, currency)}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}
