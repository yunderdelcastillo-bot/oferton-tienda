function suggestRegularPrice(offerPrice) {
  const n = Number(offerPrice);
  if (!Number.isFinite(n) || n <= 0) throw new Error('El precio de oferta debe ser mayor que cero.');
  return Math.round((n * 1.2 + Number.EPSILON) * 100) / 100;
}
function validateQuantity(quantity, stock) {
  const q = Number(quantity), s = Number(stock);
  return Number.isInteger(q) && q > 0 && Number.isInteger(s) && s >= q;
}
module.exports = { suggestRegularPrice, validateQuantity };
