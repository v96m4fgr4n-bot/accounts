import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { getPrimaryTenant } from '@/lib/tenant';
import { todayIsoDate } from '@/lib/format';
import { Money } from '@/components/CurrencyBadge';
import { recordCustomerPayment } from './actions';

export default async function DebtorsPage({
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

  const { data: balances } = await supabase
    .from('customer_balances')
    .select('customer_id, name, balance_owed, oldest_account_sale_at')
    .eq('currency', currency)
    .gt('balance_owed', 0)
    .order('oldest_account_sale_at', { ascending: true });

  const { data: cashDay } = await supabase
    .from('cash_days')
    .select('id, status')
    .eq('trade_date', todayIsoDate())
    .eq('currency', currency)
    .maybeSingle();

  return (
    <main className="container-narrow">
      <p className="muted" style={{ marginBottom: 0 }}>{tenant.name}</p>
      <h1 style={{ marginTop: '0.25rem' }}>Who owes you</h1>

      <nav className="nav-tabs" style={{ marginBottom: '1.5rem' }}>
        <a href="/client/debtors?currency=USD" className={`nav-tab${currency === 'USD' ? ' active' : ''}`}>
          USD
        </a>
        <a href="/client/debtors?currency=ZWG" className={`nav-tab${currency === 'ZWG' ? ' active' : ''}`}>
          ZWG
        </a>
      </nav>

      {!balances || balances.length === 0 ? (
        <p className="muted">Nobody currently owes you on account.</p>
      ) : (
        <div style={{ display: 'grid', gap: '0.9rem' }}>
          {balances.map((b) => (
            <div key={b.customer_id} className="card">
              <strong>{b.name}</strong> — owes <Money amount={b.balance_owed} currency={currency} />
              {b.oldest_account_sale_at ? (
                <div className="muted" style={{ fontSize: '0.85rem', marginTop: '0.2rem' }}>
                  selling on account since {String(b.oldest_account_sale_at).slice(0, 10)}
                </div>
              ) : null}
              {cashDay && cashDay.status === 'open' ? (
                <form action={recordCustomerPayment} style={{ marginTop: '0.75rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'flex-end' }}>
                  <input type="hidden" name="tenant_id" value={tenant.id} />
                  <input type="hidden" name="customer_id" value={b.customer_id} />
                  <input type="hidden" name="cash_day_id" value={cashDay.id} />
                  <input type="hidden" name="currency" value={currency} />
                  <input
                    type="number"
                    name="amount"
                    step="0.01"
                    min="0"
                    max={b.balance_owed}
                    placeholder={`Amount paid (${currency})`}
                    required
                    className="input input-inline"
                  />
                  {currency === 'ZWG' && (
                    <input
                      type="number"
                      name="exchange_rate_to_usd"
                      step="0.0001"
                      min="0"
                      placeholder="Rate used today"
                      required
                      className="input input-inline"
                    />
                  )}
                  <button type="submit" className="btn btn-primary btn-sm">
                    Record payment
                  </button>
                </form>
              ) : (
                <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.75rem', marginBottom: 0 }}>
                  <a href={`/client/day?currency=${currency}`}>Start today&apos;s {currency} cash day</a> to
                  record a payment.
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
