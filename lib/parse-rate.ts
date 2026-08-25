export function parseRate(currency: string, formData: FormData) {
  if (currency !== 'ZWG') return null;
  const raw = formData.get('exchange_rate_to_usd');
  const rate = raw ? Number(raw) : NaN;
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('A rate is required for ZWG transactions.');
  }
  return rate;
}
