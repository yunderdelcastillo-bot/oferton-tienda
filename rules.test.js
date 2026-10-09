const test = require('node:test');
const assert = require('node:assert/strict');
const { suggestRegularPrice, validateQuantity } = require('../lib/rules');
test('precio normal sugerido es precio de oferta por 1.20', () => {
  assert.equal(suggestRegularPrice(50), 60);
  assert.equal(suggestRegularPrice(100), 120);
  assert.equal(suggestRegularPrice(200), 240);
  assert.equal(suggestRegularPrice(12.5), 15);
});
test('rechaza precio de oferta inválido', () => {
  assert.throws(() => suggestRegularPrice(0));
  assert.throws(() => suggestRegularPrice('no es precio'));
});
test('valida cantidad contra stock disponible', () => {
  assert.equal(validateQuantity(2, 2), true);
  assert.equal(validateQuantity(3, 2), false);
  assert.equal(validateQuantity(0, 2), false);
  assert.equal(validateQuantity(1.5, 2), false);
});
