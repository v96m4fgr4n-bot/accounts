import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { getPrimaryTenant } from '@/lib/tenant';
import { formatMoney, todayIsoDate } from '@/lib/format';
import { recordSupplierPayment } from './actions';

export default async function CreditorsPage({
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

  const { data: balances } = await supabase
    .from('supplier_balances')
    .select('supplier_id, name, balance_owed, oldest_credit_purchase_at')
    .eq('currency', currency)
    .gt('balance_owed', 0)
    .order('oldest_credit_purchase_at', { ascending: true });

  const { data: cashDay } = await supabase
    .from('cash_days')
    .select('id, status')
    .eq('trade_date', todayIsoDate())
    .eq('currency', currency)
    .maybeSingle();

  return (
    <main style={{ padding: '1.5rem', maxWidth: 640 }}>
      <p style={{ marginBottom: 0 }}>{tenant.name}</p>
      <h1 style={{ marginTop: '0.25rem' }}>Who you owe</h1>

      {!balances || balances.length === 0 ? (
        <p>You don&apos;t currently owe any supplier on credit.</p>
      ) : (
        <ul>
          {balances.map((b) => (
            <li key={b.supplier_id} style={{ marginBottom: '1rem' }}>
              <strong>{b.name}</strong> — you owe {formatMoney(b.balance_owed, currency)}
              {b.oldest_credit_purchase_at ? (
                <span> (buying on credit since {String(b.oldest_credit_purchase_at).slice(0, 10)})</span>
              ) : null}
              {cashDay && cashDay.status === 'open' ? (
                <form action={recordSupplierPayment} style={{ marginTop: '0.5rem' }}>
                  <input type="hidden" name="tenant_id" value={tenant.id} />
                  <input type="hidden" name="supplier_id" value={b.supplier_id} />
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
                    style={{ padding: '0.4rem', marginRight: '0.5rem' }}
                  />
                  {currency === 'ZWG' && (
                    <input
                      type="number"
                      name="exchange_rate_to_usd"
                      step="0.0001"
                      min="0"
                      placeholder="Rate used today"
                      required
                      style={{ padding: '0.4rem', marginRight: '0.5rem' }}
                    />
                  )}
                  <button type="submit" style={{ padding: '0.4rem 0.75rem' }}>
                    Record payment
                  </button>
                </form>
              ) : (
                <p style={{ fontSize: '0.9em' }}>
                  <a href={`/client/day?currency=${currency}`}>Start today&apos;s {currency} cash day</a> to
                  record a payment.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <nav style={{ marginTop: '1.5rem' }}>
        <a href="/client/creditors?currency=USD" style={{ marginRight: '1rem', fontWeight: currency === 'USD' ? 'bold' : 'normal' }}>
          USD
        </a>
        <a href="/client/creditors?currency=ZWG" style={{ fontWeight: currency === 'ZWG' ? 'bold' : 'normal' }}>
          ZWG
        </a>
      </nav>
    </main>
  );
}
