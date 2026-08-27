import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { setApprovalThreshold, approveItem, signOffStockCount } from './actions';
import { CurrencyBadge, Money } from '@/components/CurrencyBadge';

const DECISION_TYPES = [
  { value: 'credit_purchase', label: 'Credit purchase' },
  { value: 'supplier_payment', label: 'Supplier payment' },
  { value: 'casual_labour', label: 'Casual labour payment' },
];

type Purchase = {
  id: string;
  description: string;
  amount: number;
  currency: 'USD' | 'ZWG';
  purchased_at: string;
  supplier: string | null;
};
type SupplierPayment = {
  id: string;
  amount: number;
  currency: 'USD' | 'ZWG';
  paid_at: string;
  suppliers: { name: string } | { name: string }[] | null;
};
type CasualLabourPayment = {
  id: string;
  description: string;
  amount: number;
  currency: 'USD' | 'ZWG';
  paid_at: string;
  casual_workers: { name: string } | { name: string }[] | null;
};
type StockCount = {
  id: string;
  counted_quantity: number;
  counted_at: string;
  inventory_items: { name: string } | { name: string }[] | null;
};

function oneName(rel: { name: string } | { name: string }[] | null) {
  return (Array.isArray(rel) ? rel[0] : rel)?.name ?? '—';
}

export default async function ApprovalsPage({
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
      <div className="container-narrow">
        <h1>Approvals</h1>
        {tenants.length === 0 ? (
          <p className="muted">No clients assigned to you yet.</p>
        ) : (
          <ul>
            {tenants.map((t) => (
              <li key={t.id}>
                <a href={`/console/approvals?tenant=${t.id}`}>{t.name}</a>
              </li>
            ))}
          </ul>
        )}
        <p>
          <a href="/console">Back to console</a>
        </p>
      </div>
    );
  }

  const tenant = tenants.find((t) => t.id === tenantId);

  const [{ data: thresholds }, { data: purchases }, { data: supplierPayments }, { data: casualLabour }, { data: stockCounts }] =
    await Promise.all([
      supabase
        .from('approval_thresholds')
        .select('decision_type, currency, threshold_amount')
        .eq('tenant_id', tenantId),
      supabase
        .from('purchases')
        .select('id, description, amount, currency, purchased_at, supplier')
        .eq('tenant_id', tenantId)
        .eq('needs_approval', true)
        .is('approved_by', null)
        .order('purchased_at'),
      supabase
        .from('supplier_payments')
        .select('id, amount, currency, paid_at, suppliers (name)')
        .eq('tenant_id', tenantId)
        .eq('needs_approval', true)
        .is('approved_by', null)
        .order('paid_at'),
      supabase
        .from('casual_labour_payments')
        .select('id, description, amount, currency, paid_at, casual_workers (name)')
        .eq('tenant_id', tenantId)
        .eq('needs_approval', true)
        .is('approved_by', null)
        .order('paid_at'),
      supabase
        .from('stock_counts')
        .select('id, counted_quantity, counted_at, inventory_items (name)')
        .eq('tenant_id', tenantId)
        .is('signed_off_by', null)
        .order('counted_at'),
    ]);

  const thresholdMap = new Map((thresholds ?? []).map((t) => [`${t.decision_type}:${t.currency}`, t.threshold_amount]));

  return (
    <>
      <div className="topbar">
        <div className="topbar-brand">
          <div className="topbar-mark" />
          <span>Console</span>
        </div>
        <span className="muted">/ Approvals</span>
      </div>
      <div className="container">
        <p>
          <a href="/console/approvals">All clients</a>
        </p>
        <h1>{tenant?.name ?? 'Approvals'}</h1>

        <section style={{ marginBottom: '2rem' }}>
          <h2>Approval thresholds</h2>
          <p className="muted" style={{ fontSize: '0.9em' }}>
            Transactions over these amounts are flagged for your review after posting — the client&apos;s own daily
            cash-sheet review stays the primary control below any threshold. Leave a decision type/currency unset for
            no flagging.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ marginBottom: '1rem' }}>
              <thead>
                <tr>
                  {['Decision', 'Currency', 'Threshold'].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DECISION_TYPES.flatMap((d) =>
                  (['USD', 'ZWG'] as const).map((currency) => (
                    <tr key={`${d.value}:${currency}`}>
                      <td>{d.label}</td>
                      <td>
                        <CurrencyBadge currency={currency} />
                      </td>
                      <td>
                        <form action={setApprovalThreshold} style={{ display: 'flex', gap: '0.4rem' }}>
                          <input type="hidden" name="tenant_id" value={tenantId} />
                          <input type="hidden" name="decision_type" value={d.value} />
                          <input type="hidden" name="currency" value={currency} />
                          <input
                            type="number"
                            name="threshold_amount"
                            step="0.01"
                            min="0.01"
                            defaultValue={thresholdMap.get(`${d.value}:${currency}`) ?? ''}
                            placeholder="unset"
                            className="input"
                            style={{ width: '7rem' }}
                          />
                          <button type="submit" className="btn btn-secondary btn-sm">
                            Save
                          </button>
                        </form>
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section style={{ marginBottom: '2rem' }}>
          <h2>Pending approvals</h2>
          {!purchases?.length && !supplierPayments?.length && !casualLabour?.length ? (
            <p className="muted">Nothing flagged for review.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    {['Type', 'Date', 'Detail', 'Amount', ''].map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(purchases as Purchase[] | null ?? []).map((p) => (
                    <tr key={p.id}>
                      <td>Credit purchase</td>
                      <td>{p.purchased_at.slice(0, 10)}</td>
                      <td>
                        {p.description}
                        {p.supplier ? ` (${p.supplier})` : ''}
                      </td>
                      <td>
                        <Money amount={p.amount} currency={p.currency} />
                      </td>
                      <td>
                        <ApproveForm table="purchases" id={p.id} tenantId={tenantId} />
                      </td>
                    </tr>
                  ))}
                  {(supplierPayments as SupplierPayment[] | null ?? []).map((sp) => (
                    <tr key={sp.id}>
                      <td>Supplier payment</td>
                      <td>{sp.paid_at.slice(0, 10)}</td>
                      <td>{oneName(sp.suppliers)}</td>
                      <td>
                        <Money amount={sp.amount} currency={sp.currency} />
                      </td>
                      <td>
                        <ApproveForm table="supplier_payments" id={sp.id} tenantId={tenantId} />
                      </td>
                    </tr>
                  ))}
                  {(casualLabour as CasualLabourPayment[] | null ?? []).map((cl) => (
                    <tr key={cl.id}>
                      <td>Casual labour</td>
                      <td>{cl.paid_at.slice(0, 10)}</td>
                      <td>
                        {cl.description} ({oneName(cl.casual_workers)})
                      </td>
                      <td>
                        <Money amount={cl.amount} currency={cl.currency} />
                      </td>
                      <td>
                        <ApproveForm table="casual_labour_payments" id={cl.id} tenantId={tenantId} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <h2>Stock counts awaiting sign-off</h2>
          {!stockCounts?.length ? (
            <p className="muted">Nothing awaiting sign-off.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    {['Item', 'Counted', 'Quantity', ''].map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(stockCounts as StockCount[]).map((sc) => (
                    <tr key={sc.id}>
                      <td>{oneName(sc.inventory_items)}</td>
                      <td>{sc.counted_at.slice(0, 10)}</td>
                      <td>{sc.counted_quantity}</td>
                      <td>
                        <form action={signOffStockCount}>
                          <input type="hidden" name="stock_count_id" value={sc.id} />
                          <input type="hidden" name="tenant_id" value={tenantId} />
                          <button type="submit" className="btn btn-primary btn-sm">
                            Sign off
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function ApproveForm({ table, id, tenantId }: { table: string; id: string; tenantId: string }) {
  return (
    <form action={approveItem}>
      <input type="hidden" name="table" value={table} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="tenant_id" value={tenantId} />
      <button type="submit" className="btn btn-primary btn-sm">
        Approve
      </button>
    </form>
  );
}
