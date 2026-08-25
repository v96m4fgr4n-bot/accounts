'use server';

import { revalidatePath } from 'next/cache';
import { createServerSupabase } from '@/lib/supabase/server';

export async function addInventoryItem(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const reorderPoint = formData.get('reorder_point');
  const costPrice = formData.get('cost_price');
  const sellingPrice = formData.get('selling_price');

  const { error } = await supabase.from('inventory_items').insert({
    tenant_id: String(formData.get('tenant_id')),
    name: String(formData.get('name')),
    unit_of_measure: String(formData.get('unit_of_measure') || '') || null,
    reorder_point: reorderPoint ? Number(reorderPoint) : null,
    cost_price: costPrice ? Number(costPrice) : null,
    selling_price: sellingPrice ? Number(sellingPrice) : null,
  });
  if (error) throw new Error(error.message);

  revalidatePath('/client/inventory');
}

export async function logStockCount(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const countedQuantity = Number(formData.get('counted_quantity'));
  if (!Number.isFinite(countedQuantity) || countedQuantity < 0) {
    throw new Error('Enter what you actually counted.');
  }

  const { error } = await supabase.from('stock_counts').insert({
    tenant_id: String(formData.get('tenant_id')),
    inventory_item_id: String(formData.get('inventory_item_id')),
    counted_quantity: countedQuantity,
    note: String(formData.get('note') || '') || null,
    recorded_by: user.id,
  });
  if (error) throw new Error(error.message);

  revalidatePath('/client/inventory');
}
