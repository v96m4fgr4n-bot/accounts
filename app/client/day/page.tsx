import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { getPrimaryTenant } from '@/lib/tenant';
import { todayIsoDate } from '@/lib/format';
import { Money } from '@/components/CurrencyBadge';
import { StatusBadge } from '@/components/StatusBadge';
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
      <main className="container-narrow">
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>No business is linked to this login yet. Contact your consultant.</p>
        </div>
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
    <main className="container-narrow">
      <p className="muted" style={{ marginBottom: 0 }}>{tenant.name}</p>
      <h1 style={{ marginTop: '0.25rem' }}>Today — {tradeDate}</h1>

      <nav className="nav-tabs" style={{ marginBottom: '1.5rem' }}>
        <a href="/client/day?currency=USD" className={`nav-tab${currency === 'USD' ? ' active' : ''}`}>
          USD cash
        </a>
        <a href="/client/day?currency=ZWG" className={`nav-tab${currency === 'ZWG' ? ' active' : ''}`}>
          ZWG cash
        </a>
      </nav>

      {!cashDay ? (
        <section className="card">
          <h2>Start the day</h2>
          <p className="muted">Count the {currency} float in the till before you open, then enter it here.</p>
          <form action={openCashDay}>
            <input type="hidden" name="tenant_id" value={tenant.id} />
            <input type="hidden" name="trade_date" value={tradeDate} />
            <input type="hidden" name="currency" value={currency} />
            <label className="field">
              <span className="field-label">Opening float</span>
              <input
                type="number"
                name="opening_float"
                step="0.01"
                min="0"
                required
                className="input"
              />
            </label>
            <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>
              Start the day
            </button>
          </form>
        </section>
      ) : (
        <>
          <section className="card" style={{ marginBottom: '1.5rem' }}>
            <p style={{ margin: 0 }}>
              Opening float: <Money amount={cashDay.opening_float} currency={currency} />
              {cashDay.status === 'closed' ? <span className="muted"> — day closed</span> : ''}
            </p>
          </section>

          {cashDay.status === 'open' && (
            <>
              <section className="card" style={{ marginBottom: '1.5rem' }}>
                <h2>Log a sale</h2>
                <form action={logSale}>
                  <HiddenFields tenantId={tenant.id} cashDayId={cashDay.id} currency={currency} />
                  <TextField name="description" label="What was sold" required />
                  <NumberField name="amount" label="Amount" required />
                  {currency === 'ZWG' && <RateField />}
                  <label className="field">
                    <span className="field-label">Payment</span>
                    <select name="payment_method" defaultValue="cash" className="input">
                      <option value="cash">Paid cash</option>
                      <option value="account">On account (book credit)</option>
                    </select>
                  </label>
                  <TextField name="customer_name" label="Customer name (if on account)" />
                  <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>
                    Log sale
                  </button>
                </form>
              </section>

              <section className="card" style={{ marginBottom: '1.5rem' }}>
                <h2>Log stock bought</h2>
                <form action={logPurchase}>
                  <HiddenFields tenantId={tenant.id} cashDayId={cashDay.id} currency={currency} />
                  <TextField name="description" label="What was bought" required />
                  <label className="field">
                    <span className="field-label">Payment</span>
                    <select name="payment_method" defaultValue="cash" className="input">
                      <option value="cash">Paid cash</option>
                      <option value="credit">On credit (pay supplier later)</option>
                    </select>
                  </label>
                  <TextField name="supplier" label="From whom" />
                  <NumberField name="amount" label="Amount owed" required />
                  {currency === 'ZWG' && <RateField />}
                  <ReceiptCheckbox />
                  <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>
                    Log purchase
                  </button>
                </form>
              </section>

              <section className="card" style={{ marginBottom: '1.5rem' }}>
                <h2>Log an expense</h2>
                <form action={logExpense}>
                  <HiddenFields tenantId={tenant.id} cashDayId={cashDay.id} currency={currency} />
                  <label className="field">
                    <span className="field-label">Category</span>
                    <select name="category" required className="input">
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
                  <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>
                    Log expense
                  </button>
                </form>
              </section>
            </>
          )}

          <TodayList title="Sales" rows={sales?.data} render={(s) => (
            <span>
              <Money amount={s.amount} currency={currency} /> — {s.description}
              {s.payment_method === 'account' ? ` (on account: ${s.customer_name})` : ''}
            </span>
          )} />

          <TodayList title="Stock bought" rows={purchases?.data} render={(p) => (
            <span>
              <Money amount={p.amount} currency={currency} /> — {p.description}
              {p.supplier ? ` (from ${p.supplier})` : ''}
            </span>
          )} />

          <TodayList title="Expenses" rows={expenses?.data} render={(e) => (
            <span>
              <Money amount={e.amount} currency={currency} /> — {e.description}
            </span>
          )} />

          {cashDay.status === 'open' && (
            <section className="card" style={{ marginTop: '1.5rem' }}>
              <h2>Count the till and close the day</h2>
              <p className="muted">Count all the {currency} cash in the till now, then enter what you counted.</p>
              <form action={closeCashDay}>
                <input type="hidden" name="cash_day_id" value={cashDay.id} />
                <NumberField name="closing_count" label="Cash counted" required />
                <TextField name="variance_note" label="If it doesn't match, why (optional)" />
                <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>
                  Close the day
                </button>
              </form>
            </section>
          )}

          {cashDay.status === 'closed' && summary?.data && (
            <section className="card" style={{ marginTop: '1.5rem' }}>
              <h2>Day closed</h2>
              <p>Cash counted: <Money amount={summary.data.closing_count} currency={currency} /></p>
              <p>Expected: <Money amount={summary.data.expected_cash} currency={currency} /></p>
              <p>
                {summary.data.variance === 0 ? (
                  <StatusBadge severity="ok">Matched</StatusBadge>
                ) : summary.data.variance > 0 ? (
                  <StatusBadge severity="pending">
                    Over by <Money amount={summary.data.variance} currency={currency} />
                  </StatusBadge>
                ) : (
                  <StatusBadge severity="pending">
                    Short by <Money amount={Math.abs(summary.data.variance)} currency={currency} />
                  </StatusBadge>
                )}
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
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="text"
        name={name}
        required={required}
        className="input"
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
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="number"
        name={name}
        step="0.01"
        min="0"
        required={required}
        className="input"
      />
    </label>
  );
}

function RateField() {
  return (
    <label className="field">
      <span className="field-label">Rate used today (ZWG per USD)</span>
      <input
        type="number"
        name="exchange_rate_to_usd"
        step="0.0001"
        min="0"
        required
        className="input"
      />
    </label>
  );
}

function ReceiptCheckbox() {
  return (
    <label className="field" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
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
    <section className="card" style={{ marginBottom: '1.5rem' }}>
      <h3 style={{ marginTop: 0 }}>{title} today</h3>
      <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
        {rows.map((row) => (
          <li key={row.id} style={{ marginBottom: '0.4rem' }}>{render(row)}</li>
        ))}
      </ul>
    </section>
  );
}
