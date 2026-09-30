import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkout } from '../src/checkout.js';

test('charges each line item by quantity', () => {
  const receipt = checkout({
    items: [
      { sku: 'mug', price: 12, quantity: 2 },
      { sku: 'tea', price: 5, quantity: 1 },
    ],
  });
  assert.equal(receipt.subtotal, 29);
});

test('applies percentage discount codes to the subtotal', () => {
  const receipt = checkout({ items: [{ sku: 'kettle', price: 40, quantity: 1 }], discountCode: 'SAVE10' });
  assert.equal(receipt.total, 36);
});
