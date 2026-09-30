import { applyDiscount } from './discounts.js';
import { subtotal } from './pricing.js';

/** Prices a cart end-to-end: line items → subtotal → discount → rounded total. */
export function checkout(cart) {
  const base = subtotal(cart.items);
  const total = applyDiscount(base, cart.discountCode);
  return { subtotal: base, total: Math.round(total * 100) / 100 };
}
