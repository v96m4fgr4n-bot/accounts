import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { getPrimaryTenant } from '@/lib/tenant';
import { formatMoney, todayIsoDate } from '@/lib/format';
import {
  openCashDay,
  logSale,
  logPurchase,
  logExpense,
  closeCashDay,
} from './actions';

const EXPENSE_CATEGORIES: { value: string; label: string }[] = [
  { value: 'rent', label: 'Rent' },
  { value: 'utilities', label: 'Electricity / water' },
  { value: 'transport', label: 'Transport / fuel' },
  { value: 'airtime_data', label: 'Airtime / data' },
  { value: 'repairs_maintenance', label: 'Repairs' },
  { value: 'packaging', label: 'Packaging' },
  { value: 'casual_labour', label: 'Paid someone to help' },
  { value: 'bank_charges', label: 'Bank / mobile money charges' },
  { value: 'other', label: 'Other' },
];

export default async function DayPage({
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
  const tradeDate = todayIsoDate();

  const { data: cashDay } = await supabase
    .from('cash_days')
    .select('id, opening_float, status, closing_count')
    .eq('trade_date', tradeDate)
    .eq('currency', currency)
    .maybeSingle();

  const [sales, purchases, expenses, summary] = cashDay
    ? await Promise.all([
        supabase
          .from('sales')
          .select('id, description, amount, payment_method, customer_name, sold_at')
          .eq('cash_day_id', cashDay.id)
          .order('sold_at', { ascending: false }),
        supabase
          .from('purchases')
          .select('id, description, amount, supplier, purchased_at')
          .eq('cash_day_id', cashDay.id)
          .order('purchased_at', { ascending: false }),
        supabase
          .from('expenses')
          .select('id, description, amount, category, paid_at')
          .eq('cash_day_id', cashDay.id)
          .order('paid_at', { ascending: false }),
        supabase
          .from('cash_day_summary')
          .select('*')
          .eq('cash_day_id', cashDay.id)
          .single(),
      ])
    : [null, null, null, null];

  return (
    <main style={{ padding: '1.5rem', maxWidth: 640 }}>
      <p style={{ marginBottom: 0 }}>{tenant.name}</p>
      <h1 style={{ marginTop: '0.25rem' }}>Today — {tradeDate}</h1>

      <nav style={{ marginBottom: '1.5rem' }}>
        <a href="/client/day?currency=USD" style={{ marginRight: '1rem', fontWeight: currency === 'USD' ? 'bold' : 'normal' }}>
          USD cash
        </a>
        <a href="/client/day?currency=ZWG" style={{ fontWeight: currency === 'ZWG' ? 'bold' : 'normal' }}>
          ZWG cash
        </a>
      </nav>

      {!cashDay ? (
        <section>
          <h2>Start the day</h2>
          <p>Count the {currency} float in the till before you open, then enter it here.</p>
          <form action={openCashDay}>
            <input type="hidden" name="tenant_id" value={tenant.id} />
            <input type="hidden" name="trade_date" value={tradeDate} />
            <input type="hidden" name="currency" value={currency} />
            <label style={{ display: 'block', marginBottom: '0.5rem' }}>
              Opening float
              <input
                type="number"
                name="opening_float"
                step="0.01"
                min="0"
                required
                style={{ display: 'block', width: '100%', padding: '0.5rem' }}
              />
            </label>
            <button type="submit" style={{ padding: '0.5rem 1rem' }}>
              Start the day
            </button>
          </form>
        </section>
      ) : (
        <>
          <section style={{ marginBottom: '2rem' }}>
            <p>
              Opening float: <strong>{formatMoney(cashDay.opening_float, currency)}</strong>
              {cashDay.status === 'closed' ? ' — day closed' : ''}
            </p>
          </section>

          {cashDay.status === 'open' && (
            <>
              <section style={{ marginBottom: '1.5rem' }}>
                <h2>Log a sale</h2>
                <form action={logSale}>
                  <HiddenFields tenantId={tenant.id} cashDayId={cashDay.id} currency={currency} />
                  <TextField name="description" label="What was sold" required />
                  <NumberField name="amount" label="Amount" required />
                  {currency === 'ZWG' && <RateField />}
                  <label style={{ display: 'block', marginBottom: '0.5rem' }}>
                    <select name="payment_method" defaultValue="cash">
                      <option value="cash">Paid cash</option>
                      <option value="account">On account (book credit)</option>
                    </select>
                  </label>
                  <TextField name="customer_name" label="Customer name (if on account)" />
                  <button type="submit" style={{ padding: '0.5rem 1rem' }}>
                    Log sale
                  </button>
                </form>
              </section>

              <section style={{ marginBottom: '1.5rem' }}>
                <h2>Log stock bought</h2>
                <form action={logPurchase}>
                  <HiddenFields tenantId={tenant.id} cashDayId={cashDay.id} currency={currency} />
                  <TextField name="description" label="What was bought" required />
                  <TextField name="supplier" label="From whom" />
                  <NumberField name="amount" label="Amount paid" required />
                  {currency === 'ZWG' && <RateField />}
                  <ReceiptCheckbox />
                  <button type="submit" style={{ padding: '0.5rem 1rem' }}>
                    Log purchase
                  </button>
                </form>
              </section>

              <section style={{ marginBottom: '1.5rem' }}>
                <h2>Log an expense</h2>
                <form action={logExpense}>
                  <HiddenFields tenantId={tenant.id} cashDayId={cashDay.id} currency={currency} />
                  <label style={{ display: 'block', marginBottom: '0.5rem' }}>
                    Category
                    <select name="category" required style={{ display: 'block', width: '100%', padding: '0.5rem' }}>
                      {EXPENSE_CATEGORIES.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <TextField name="description" label="What was it for" required />
                  <NumberField name="amount" label="Amount paid" required />
                  {currency === 'ZWG' && <RateField />}
                  <ReceiptCheckbox />
                  <button type="submit" style={{ padding: '0.5rem 1rem' }}>
                    Log expense
                  </button>
                </form>
              </section>
            </>
          )}

          <TodayList title="Sales" rows={sales?.data} render={(s) => (
            <span>
              {formatMoney(s.amount, currency)} — {s.description}
              {s.payment_method === 'account' ? ` (on account: ${s.customer_name})` : ''}
            </span>
          )} />

          <TodayList title="Stock bought" rows={purchases?.data} render={(p) => (
            <span>
              {formatMoney(p.amount, currency)} — {p.description}
              {p.supplier ? ` (from ${p.supplier})` : ''}
            </span>
          )} />

          <TodayList title="Expenses" rows={expenses?.data} render={(e) => (
            <span>
              {formatMoney(e.amount, currency)} — {e.description}
            </span>
          )} />

          {cashDay.status === 'open' && (
            <section style={{ marginTop: '2rem', borderTop: '1px solid #ccc', paddingTop: '1rem' }}>
              <h2>Count the till and close the day</h2>
              <p>Count all the {currency} cash in the till now, then enter what you counted.</p>
              <form action={closeCashDay}>
                <input type="hidden" name="cash_day_id" value={cashDay.id} />
                <NumberField name="closing_count" label="Cash counted" required />
                <TextField name="variance_note" label="If it doesn't match, why (optional)" />
                <button type="submit" style={{ padding: '0.5rem 1rem' }}>
                  Close the day
                </button>
              </form>
            </section>
          )}

          {cashDay.status === 'closed' && summary?.data && (
            <section style={{ marginTop: '2rem', borderTop: '1px solid #ccc', paddingTop: '1rem' }}>
              <h2>Day closed</h2>
              <p>Cash counted: {formatMoney(summary.data.closing_count, currency)}</p>
              <p>Expected: {formatMoney(summary.data.expected_cash, currency)}</p>
              <p>
                <strong>
                  {summary.data.variance === 0
                    ? 'Matched.'
                    : summary.data.variance > 0
                      ? `Over by ${formatMoney(summary.data.variance, currency)}.`
                      : `Short by ${formatMoney(Math.abs(summary.data.variance), currency)}.`}
                </strong>
              </p>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function HiddenFields({
  tenantId,
  cashDayId,
  currency,
}: {
  tenantId: string;
  cashDayId: string;
  currency: string;
}) {
  return (
    <>
      <input type="hidden" name="tenant_id" value={tenantId} />
      <input type="hidden" name="cash_day_id" value={cashDayId} />
      <input type="hidden" name="currency" value={currency} />
    </>
  );
}

function TextField({
  name,
  label,
  required,
}: {
  name: string;
  label: string;
  required?: boolean;
}) {
  return (
    <label style={{ display: 'block', marginBottom: '0.5rem' }}>
      {label}
      <input
        type="text"
        name={name}
        required={required}
        style={{ display: 'block', width: '100%', padding: '0.5rem' }}
      />
    </label>
  );
}

function NumberField({
  name,
  label,
  required,
}: {
  name: string;
  label: string;
  required?: boolean;
}) {
  return (
    <label style={{ display: 'block', marginBottom: '0.5rem' }}>
      {label}
      <input
        type="number"
        name={name}
        step="0.01"
        min="0"
        required={required}
        style={{ display: 'block', width: '100%', padding: '0.5rem' }}
      />
    </label>
  );
}

function RateField() {
  return (
    <label style={{ display: 'block', marginBottom: '0.5rem' }}>
      Rate used today (ZWG per USD)
      <input
        type="number"
        name="exchange_rate_to_usd"
        step="0.0001"
        min="0"
        required
        style={{ display: 'block', width: '100%', padding: '0.5rem' }}
      />
    </label>
  );
}

function ReceiptCheckbox() {
  return (
    <label style={{ display: 'block', marginBottom: '0.5rem' }}>
      <input type="checkbox" name="has_receipt" /> Got a receipt
    </label>
  );
}

function TodayList<T extends { id: string }>({
  title,
  rows,
  render,
}: {
  title: string;
  rows: T[] | null | undefined;
  render: (row: T) => React.ReactNode;
}) {
  if (!rows || rows.length === 0) return null;
  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <h3>{title} today</h3>
      <ul>
        {rows.map((row) => (
          <li key={row.id}>{render(row)}</li>
        ))}
      </ul>
    </section>
  );
}
