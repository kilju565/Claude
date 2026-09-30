/** Sum of line-item prices for a cart. */
export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}
