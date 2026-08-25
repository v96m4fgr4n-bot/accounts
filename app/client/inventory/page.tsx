import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { getPrimaryTenant } from '@/lib/tenant';
import { addInventoryItem, logStockCount } from './actions';

export default async function InventoryPage() {
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

  const { data: items } = await supabase
    .from('inventory_items')
    .select('id, name, unit_of_measure, reorder_point')
    .order('name');

  const { data: recentCounts } = await supabase
    .from('stock_counts')
    .select('id, inventory_item_id, counted_quantity, counted_at, note')
    .order('counted_at', { ascending: false })
    .limit(20);

  const latestCountByItem = new Map<string, { counted_quantity: number; counted_at: string }>();
  for (const c of recentCounts ?? []) {
    if (!latestCountByItem.has(c.inventory_item_id)) {
      latestCountByItem.set(c.inventory_item_id, c);
    }
  }

  return (
    <main style={{ padding: '1.5rem', maxWidth: 640 }}>
      <p style={{ marginBottom: 0 }}>{tenant.name}</p>
      <h1 style={{ marginTop: '0.25rem' }}>Stock</h1>

      {items && items.length > 0 ? (
        <ul>
          {items.map((item) => {
            const latest = latestCountByItem.get(item.id);
            const low =
              item.reorder_point != null &&
              latest != null &&
              latest.counted_quantity <= item.reorder_point;
            return (
              <li key={item.id} style={{ marginBottom: '1.25rem' }}>
                <strong>{item.name}</strong>
                {item.unit_of_measure ? ` (${item.unit_of_measure})` : ''}
                {latest ? (
                  <span>
                    {' '}
                    — last counted {latest.counted_quantity} on{' '}
                    {latest.counted_at.slice(0, 10)}
                    {low ? ' — reorder soon' : ''}
                  </span>
                ) : (
                  <span> — not counted yet</span>
                )}
                <form action={logStockCount} style={{ marginTop: '0.4rem' }}>
                  <input type="hidden" name="tenant_id" value={tenant.id} />
                  <input type="hidden" name="inventory_item_id" value={item.id} />
                  <input
                    type="number"
                    name="counted_quantity"
                    step="0.01"
                    min="0"
                    placeholder="Count now"
                    required
                    style={{ padding: '0.4rem', marginRight: '0.5rem', width: '8rem' }}
                  />
                  <input
                    type="text"
                    name="note"
                    placeholder="Note (optional)"
                    style={{ padding: '0.4rem', marginRight: '0.5rem' }}
                  />
                  <button type="submit" style={{ padding: '0.4rem 0.75rem' }}>
                    Log count
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      ) : (
        <p>No stock items yet.</p>
      )}

      <section style={{ marginTop: '2rem', borderTop: '1px solid #ccc', paddingTop: '1rem' }}>
        <h2>Add a stock item</h2>
        <form action={addInventoryItem}>
          <input type="hidden" name="tenant_id" value={tenant.id} />
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>
            Name
            <input type="text" name="name" required style={{ display: 'block', width: '100%', padding: '0.5rem' }} />
          </label>
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>
            Unit (e.g. each, box, kg)
            <input type="text" name="unit_of_measure" style={{ display: 'block', width: '100%', padding: '0.5rem' }} />
          </label>
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>
            Reorder when stock falls to
            <input type="number" name="reorder_point" step="0.01" min="0" style={{ display: 'block', width: '100%', padding: '0.5rem' }} />
          </label>
          <button type="submit" style={{ padding: '0.5rem 1rem' }}>
            Add item
          </button>
        </form>
      </section>
    </main>
  );
}
