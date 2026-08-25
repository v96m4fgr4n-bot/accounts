'use server';

import { revalidatePath } from 'next/cache';
import { createServerSupabase } from '@/lib/supabase/server';
import { getOrCreateCustomerId, getOrCreateSupplierId } from '@/lib/refs';
import { parseRate } from '@/lib/parse-rate';

export async function openCashDay(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const tenantId = String(formData.get('tenant_id'));
  const tradeDate = String(formData.get('trade_date'));
  const currency = String(formData.get('currency'));
  const openingFloat = Number(formData.get('opening_float'));

  if (!Number.isFinite(openingFloat) || openingFloat < 0) {
    throw new Error('Enter a valid opening float.');
  }

  const { error } = await supabase.from('cash_days').insert({
    tenant_id: tenantId,
    trade_date: tradeDate,
    currency,
    opening_float: openingFloat,
    opened_by: user.id,
  });
  if (error) throw new Error(error.message);

  revalidatePath('/client/day');
}

export async function logSale(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const currency = String(formData.get('currency'));
  const paymentMethod = String(formData.get('payment_method'));
  const tenantId = String(formData.get('tenant_id'));
  const customerName = String(formData.get('customer_name') || '').trim();

  if (paymentMethod === 'account' && !customerName) {
    throw new Error('Enter who it was sold to on account.');
  }
  const customerId =
    paymentMethod === 'account'
      ? await getOrCreateCustomerId(supabase, tenantId, customerName)
      : null;

  const { error } = await supabase.from('sales').insert({
    tenant_id: tenantId,
    cash_day_id: String(formData.get('cash_day_id')),
    description: String(formData.get('description')),
    amount: Number(formData.get('amount')),
    currency,
    exchange_rate_to_usd: parseRate(currency, formData),
    payment_method: paymentMethod,
    customer_name: paymentMethod === 'account' ? customerName : null,
    customer_id: customerId,
    recorded_by: user.id,
  });
  if (error) throw new Error(error.message);

  revalidatePath('/client/day');
}

export async function logPurchase(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const currency = String(formData.get('currency'));
  const tenantId = String(formData.get('tenant_id'));
  const supplierName = String(formData.get('supplier') || '').trim();
  const paymentMethod = String(formData.get('payment_method') || 'cash');

  if (paymentMethod === 'credit' && !supplierName) {
    throw new Error('Enter which supplier this is owed to.');
  }
  const supplierId =
    paymentMethod === 'credit'
      ? await getOrCreateSupplierId(supabase, tenantId, supplierName)
      : null;

  const { error } = await supabase.from('purchases').insert({
    tenant_id: tenantId,
    cash_day_id: String(formData.get('cash_day_id')),
    description: String(formData.get('description')),
    supplier: supplierName || null,
    supplier_id: supplierId,
    payment_method: paymentMethod,
    amount: Number(formData.get('amount')),
    currency,
    exchange_rate_to_usd: parseRate(currency, formData),
    has_receipt: formData.get('has_receipt') === 'on',
    recorded_by: user.id,
  });
  if (error) throw new Error(error.message);

  revalidatePath('/client/day');
}

export async function logExpense(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const currency = String(formData.get('currency'));

  const { error } = await supabase.from('expenses').insert({
    tenant_id: String(formData.get('tenant_id')),
    cash_day_id: String(formData.get('cash_day_id')),
    category: String(formData.get('category')),
    description: String(formData.get('description')),
    amount: Number(formData.get('amount')),
    currency,
    exchange_rate_to_usd: parseRate(currency, formData),
    has_receipt: formData.get('has_receipt') === 'on',
    recorded_by: user.id,
  });
  if (error) throw new Error(error.message);

  revalidatePath('/client/day');
}

export async function closeCashDay(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const closingCount = Number(formData.get('closing_count'));
  if (!Number.isFinite(closingCount) || closingCount < 0) {
    throw new Error('Enter what you actually counted in the till.');
  }
  const varianceNote = formData.get('variance_note');

  const { error } = await supabase
    .from('cash_days')
    .update({
      closing_count: closingCount,
      variance_note: varianceNote ? String(varianceNote) : null,
      closed_by: user.id,
      closed_at: new Date().toISOString(),
      status: 'closed',
    })
    .eq('id', String(formData.get('cash_day_id')));
  if (error) throw new Error(error.message);

  revalidatePath('/client/day');
}
