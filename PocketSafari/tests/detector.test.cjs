const test = require("node:test");
const assert = require("node:assert/strict");
const { detectReceipt } = require("../Resources/detector.js");
const receipt = "Thank you for your order\nOrder number: AB-1234\nSubtotal: $20.00\nTax: $1.60\nTotal: USD $21.60";
const address = "https://shop.example/receipt?secret=abc#private";
test("only labeled final USD total is logged, with no URL secrets", () => {
  assert.deepEqual(detectReceipt(receipt, address), { merchant:"shop.example", note:"Online purchase", amountCents:2160, orderReference:"AB-1234", url:"https://shop.example", key:"shop.example|AB-1234" });
});
test("split labels work", () => {
  const value = detectReceipt("Your order is confirmed\nOrder ID\nA12345\nGrand total\n$1,234.56 USD", address);
  assert.equal(value.amountCents, 123456);
});
test("no checkout or pending payment is recorded", () => {
  assert.equal(detectReceipt(receipt.replace("Thank you for your order", "Place your order"), address), null);
  assert.equal(detectReceipt(receipt + "\nPayment pending", address), null);
  assert.equal(detectReceipt(receipt.replace("Thank you for your order", "You'll see Order confirmed after paying"), address), null);
  assert.equal(detectReceipt(receipt + "\nOrder history", address), null);
});
test("ambiguous totals, order references, currencies, malformed cents rejected", () => {
  for (const text of [receipt+"\nTotal: USD 30.00", receipt+"\nTotal: $30.00", receipt+"\nOrder ID: B9999", receipt.replace("USD $", "$"), receipt.replace("USD $", "CAD $"), receipt.replace("21.60", "21.605"), receipt.replace("21.60", "1,23.45")]) assert.equal(detectReceipt(text, address), null);
});
test("confirmation, order reference, and explicit total are all required", () => {
  for (const text of ["Order confirmed", "Order confirmed\nTotal: USD 10.00", "Order number: AB-1234\nTotal: USD 10.00", "Order confirmed\nOrder number: AB-1234\nSubtotal: USD 10.00"]) assert.equal(detectReceipt(text, address), null);
});
test("same order produces stable key despite query, case or repeat labels", () => {
  const a = detectReceipt(receipt, address);
  const b = detectReceipt(receipt.replace("AB-1234", "ab-1234")+"\nTotal: USD 21.60", "https://shop.example/done?other=token");
  assert.equal(a.key, b.key);
});
test("unsafe URLs and zero or excessive amounts are rejected", () => {
  for (const url of ["http://shop.example", "https://name:secret@shop.example", "file:///receipt", "nope"]) assert.equal(detectReceipt(receipt, url), null);
  for (const amount of ["0.00", "10000.01", "99999999999999999.99"]) assert.equal(detectReceipt(receipt.replace("21.60", amount), address), null);
});
