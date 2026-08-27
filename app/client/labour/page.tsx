import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { getPrimaryTenant } from '@/lib/tenant';
import { todayIsoDate } from '@/lib/format';
import { Money } from '@/components/CurrencyBadge';
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
      <main className="container-narrow">
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>No business is linked to this login yet. Contact your consultant.</p>
        </div>
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
    <main className="container-narrow">
      <p className="muted" style={{ marginBottom: 0 }}>{tenant.name}</p>
      <h1 style={{ marginTop: '0.25rem' }}>Paying someone who helps</h1>

      <nav className="nav-tabs" style={{ marginBottom: '1.5rem' }}>
        <a href="/client/labour?currency=USD" className={`nav-tab${currency === 'USD' ? ' active' : ''}`}>
          USD
        </a>
        <a href="/client/labour?currency=ZWG" className={`nav-tab${currency === 'ZWG' ? ' active' : ''}`}>
          ZWG
        </a>
      </nav>

      {cashDay && cashDay.status === 'open' ? (
        <section className="card" style={{ marginBottom: '1.5rem' }}>
          <h2>Log a payment</h2>
          <form action={logCasualLabourPayment}>
            <input type="hidden" name="tenant_id" value={tenant.id} />
            <input type="hidden" name="cash_day_id" value={cashDay.id} />
            <input type="hidden" name="currency" value={currency} />
            <label className="field">
              <span className="field-label">Who was paid</span>
              <input type="text" name="worker_name" required className="input" />
            </label>
            <label className="field">
              <span className="field-label">What for</span>
              <input type="text" name="description" required className="input" />
            </label>
            <label className="field">
              <span className="field-label">Amount ({currency})</span>
              <input type="number" name="amount" step="0.01" min="0" required className="input" />
            </label>
            {currency === 'ZWG' && (
              <label className="field">
                <span className="field-label">Rate used today</span>
                <input type="number" name="exchange_rate_to_usd" step="0.0001" min="0" required className="input" />
              </label>
            )}
            <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>
              Log payment
            </button>
          </form>
        </section>
      ) : (
        <p className="muted">
          <a href={`/client/day?currency=${currency}`}>Start today&apos;s {currency} cash day</a> to log a payment.
        </p>
      )}

      {recent && recent.length > 0 && (
        <section className="card">
          <h2>Recent payments</h2>
          <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {recent.map((r) => {
              const worker = Array.isArray(r.casual_workers) ? r.casual_workers[0] : r.casual_workers;
              return (
                <li key={r.id} style={{ marginBottom: '0.4rem' }}>
                  <span className="muted">{String(r.paid_at).slice(0, 10)}</span> — {worker?.name ?? 'unknown'} — {r.description} —{' '}
                  <Money amount={r.amount} currency={currency} />
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}
