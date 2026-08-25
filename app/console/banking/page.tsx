import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { formatMoney, todayIsoDate } from '@/lib/format';
import { addBankAccount, logBankDeposit, recordReconciliation } from './actions';

export default async function BankingPage({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string; currency?: string }>;
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
  const currency: 'USD' | 'ZWG' = params.currency === 'ZWG' ? 'ZWG' : 'USD';

  if (!tenantId) {
    return (
      <main style={{ padding: '2rem', maxWidth: 640 }}>
        <h1>Banking</h1>
        {tenants.length === 0 ? (
          <p>No clients assigned to you yet.</p>
        ) : (
          <ul>
            {tenants.map((t) => (
              <li key={t.id}>
                <a href={`/console/banking?tenant=${t.id}`}>{t.name}</a>
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

  const { data: bankAccounts } = await supabase
    .from('bank_accounts')
    .select('id, bank_name, account_number, currency, opening_balance, opened_at')
    .eq('tenant_id', tenantId)
    .order('opened_at');

  const balances = await Promise.all(
    (bankAccounts ?? []).map(async (ba) => {
      const { data } = await supabase.rpc('bank_account_balance', { p_bank_account_id: ba.id });
      return { id: ba.id, balance: (data as number) ?? 0 };
    }),
  );
  const balanceById = new Map(balances.map((b) => [b.id, b.balance]));

  const { data: recentReconciliations } = await supabase
    .from('bank_reconciliations')
    .select('id, bank_account_id, statement_date, statement_closing_balance, ledger_balance, note')
    .eq('tenant_id', tenantId)
    .order('statement_date', { ascending: false })
    .limit(10);

  const { data: cashDay } = await supabase
    .from('cash_days')
    .select('id, status')
    .eq('trade_date', todayIsoDate())
    .eq('currency', currency)
    .maybeSingle();

  return (
    <main style={{ padding: '2rem', maxWidth: 800 }}>
      <p>
        <a href="/console/banking">All clients</a>
      </p>
      <h1>{tenant?.name ?? 'Banking'}</h1>

      <section style={{ marginBottom: '2rem' }}>
        <h2>Bank accounts</h2>
        {!bankAccounts || bankAccounts.length === 0 ? (
          <p>No bank account recorded yet — many clients start entirely in cash.</p>
        ) : (
          <ul>
            {bankAccounts.map((ba) => (
              <li key={ba.id} style={{ marginBottom: '0.5rem' }}>
                <strong>{ba.bank_name}</strong> ({ba.account_number}) — {ba.currency} — book balance{' '}
                {formatMoney(balanceById.get(ba.id) ?? 0, ba.currency)}
              </li>
            ))}
          </ul>
        )}
        <form action={addBankAccount}>
          <input type="hidden" name="tenant_id" value={tenantId} />
          <input type="text" name="bank_name" placeholder="Bank name" required style={{ padding: '0.4rem', marginRight: '0.5rem' }} />
          <input type="text" name="account_number" placeholder="Account number" required style={{ padding: '0.4rem', marginRight: '0.5rem' }} />
          <select name="currency" style={{ marginRight: '0.5rem' }}>
            <option value="USD">USD</option>
            <option value="ZWG">ZWG</option>
          </select>
          <input type="number" name="opening_balance" step="0.01" min="0" placeholder="Opening balance" style={{ padding: '0.4rem', marginRight: '0.5rem', width: '8rem' }} />
          <input type="date" name="opened_at" style={{ padding: '0.4rem', marginRight: '0.5rem' }} />
          <button type="submit" style={{ padding: '0.4rem 0.75rem' }}>
            Add account
          </button>
        </form>
      </section>

      {bankAccounts && bankAccounts.length > 0 && (
        <>
          <section style={{ marginBottom: '2rem' }}>
            <h2>Bank a deposit</h2>
            {cashDay && cashDay.status === 'open' ? (
              <form action={logBankDeposit}>
                <input type="hidden" name="tenant_id" value={tenantId} />
                <input type="hidden" name="cash_day_id" value={cashDay.id} />
                <input type="hidden" name="currency" value={currency} />
                <select name="bank_account_id" required style={{ padding: '0.4rem', marginRight: '0.5rem' }}>
                  {bankAccounts
                    .filter((ba) => ba.currency === currency)
                    .map((ba) => (
                      <option key={ba.id} value={ba.id}>
                        {ba.bank_name} ({ba.account_number})
                      </option>
                    ))}
                </select>
                <input type="number" name="amount" step="0.01" min="0" placeholder={`Amount (${currency})`} required style={{ padding: '0.4rem', marginRight: '0.5rem' }} />
                {currency === 'ZWG' && (
                  <input type="number" name="exchange_rate_to_usd" step="0.0001" min="0" placeholder="Rate used today" required style={{ padding: '0.4rem', marginRight: '0.5rem' }} />
                )}
                <button type="submit" style={{ padding: '0.4rem 0.75rem' }}>
                  Log deposit
                </button>
              </form>
            ) : (
              <p style={{ fontSize: '0.9em' }}>
                Today&apos;s {currency} cash day isn&apos;t open on the client side yet — a deposit logs against the
                day&apos;s till like any other cash-out.
              </p>
            )}
            <nav style={{ marginTop: '0.5rem' }}>
              <a href={`/console/banking?tenant=${tenantId}&currency=USD`} style={{ marginRight: '1rem', fontWeight: currency === 'USD' ? 'bold' : 'normal' }}>
                USD
              </a>
              <a href={`/console/banking?tenant=${tenantId}&currency=ZWG`} style={{ fontWeight: currency === 'ZWG' ? 'bold' : 'normal' }}>
                ZWG
              </a>
            </nav>
          </section>

          <section>
            <h2>Reconciliation</h2>
            {recentReconciliations && recentReconciliations.length > 0 && (
              <ul>
                {recentReconciliations.map((r) => {
                  const ba = bankAccounts.find((b) => b.id === r.bank_account_id);
                  const variance = r.statement_closing_balance - (r.ledger_balance ?? 0);
                  return (
                    <li key={r.id}>
                      {r.statement_date} — {ba?.bank_name}: statement{' '}
                      {formatMoney(r.statement_closing_balance, ba?.currency ?? 'USD')}, books{' '}
                      {formatMoney(r.ledger_balance ?? 0, ba?.currency ?? 'USD')}
                      {variance !== 0 ? ` — variance ${formatMoney(variance, ba?.currency ?? 'USD')}` : ' — matched'}
                    </li>
                  );
                })}
              </ul>
            )}
            <form action={recordReconciliation}>
              <input type="hidden" name="tenant_id" value={tenantId} />
              <select name="bank_account_id" required style={{ padding: '0.4rem', marginRight: '0.5rem' }}>
                {bankAccounts.map((ba) => (
                  <option key={ba.id} value={ba.id}>
                    {ba.bank_name} ({ba.account_number})
                  </option>
                ))}
              </select>
              <input type="date" name="statement_date" required style={{ padding: '0.4rem', marginRight: '0.5rem' }} />
              <input type="number" name="statement_closing_balance" step="0.01" placeholder="Statement closing balance" required style={{ padding: '0.4rem', marginRight: '0.5rem' }} />
              <input type="text" name="note" placeholder="Note (optional)" style={{ padding: '0.4rem', marginRight: '0.5rem' }} />
              <button type="submit" style={{ padding: '0.4rem 0.75rem' }}>
                Record
              </button>
            </form>
          </section>
        </>
      )}
    </main>
  );
}
