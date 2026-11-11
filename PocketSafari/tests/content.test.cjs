const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { detectReceipt } = require("../Resources/detector.js");

function contentEnvironment(lines, enabled = true) {
  let onMessage;
  let walked = 0;
  const sent = [];
  const body = {};
  const nodes = lines.map(line => {
    const spec = typeof line === "string" ? { text: line } : line;
    const parent = {
      id: spec.sensitive ? "payment-card" : "", className: "", parentElement: body,
      closest: () => spec.form ? {} : null,
      getClientRects: () => spec.hidden ? [] : [{}]
    };
    return {
      parentElement: parent,
      get textContent() {
        if (spec.sensitive || spec.form || spec.hidden) throw new Error("Sensitive or hidden text was read");
        return spec.text;
      }
    };
  });
  const document = {
    body, documentElement: {}, visibilityState: "visible", addEventListener() {},
    createTreeWalker() {
      walked++; let index = -1;
      return { nextNode() { return ++index < nodes.length; }, get currentNode() { return nodes[index]; } };
    }
  };
  const browser = {
    runtime: {
      onMessage: { addListener: fn => onMessage = fn },
      sendMessage: async message => {
        if (message.type === "enabled") return { enabled };
        sent.push(message); return { ok: true };
      }
    }, storage: { onChanged: { addListener() {} } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../Resources/content.js"), "utf8"), {
    browser, document, PocketReceipt: { detectReceipt }, NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver: class { observe() {} },
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    location: { href: "https://shop.example/confirmation" },
    setTimeout: () => 1, clearTimeout() {}
  });
  return { scan: () => onMessage({ type: "rescan" }), sent, get walked() { return walked; } };
}

test("DOM capture ignores form, payment, and hidden text before reading values", async () => {
  const env = contentEnvironment([
    "Order confirmed", "Order number:", "ABC-1234", "Total:", "USD $12.50",
    { text: "4111111111111111", form: true },
    { text: "Card ending 1234", sensitive: true },
    { text: "Private hidden content", hidden: true }
  ]);
  assert.equal((await env.scan()).ok, true);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].receipt.amountCents, 1250);
  assert.equal(JSON.stringify(env.sent).includes("4111"), false);
  assert.equal((await env.scan()).ok, true);
  assert.equal(env.sent.length, 1);
});

test("disabled website does not read its DOM", async () => {
  const env = contentEnvironment(["Order confirmed", "Order ID: ABC123", "Total: USD 12.50"], false);
  assert.equal((await env.scan()).ok, false);
  assert.equal(env.walked, 0);
  assert.equal(env.sent.length, 0);
});

test("checkout page and ambiguous receipt produce visible manual-entry fallback", async () => {
  for (const lines of [
    ["Checkout", "Order ID: ABC123", "Total: USD 12.50", "Place your order"],
    ["Order confirmed", "Order ID: ABC123", "Total: $12.50"],
    ["Order history", "Order confirmed", "Order ID: ABC123", "Total: USD 12.50"]
  ]) {
    const env = contentEnvironment(lines);
    const result = await env.scan();
    assert.equal(result.ok, false);
    assert.match(result.error, /Record this purchase/);
    assert.equal(env.sent.length, 0);
  }
});
