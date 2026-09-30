const DISCOUNT_RATES = {
  SAVE10: 0.1,
  HALFOFF: 0.5,
};

/** Applies a percentage discount code to an amount. Unknown codes leave the amount unchanged. */
export function applyDiscount(amount, code) {
  const rate = DISCOUNT_RATES[code] ?? 0;
  return amount * rate;
}
