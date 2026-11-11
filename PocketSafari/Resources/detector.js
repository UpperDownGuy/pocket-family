(function (root) {
  "use strict";
  const confirmed = /^(?:thank you for your (?:order|purchase)|your order (?:is|has been) confirmed|order (?:confirmed|placed)|purchase complete|payment successful)(?:[!.,].*)?$/im;
  const pending = /\b(?:payment (?:pending|failed|declined)|order (?:pending|cancelled|canceled)|complete your (?:order|purchase)|place your order)\b/i;
  const history = /^(?:order history|past orders|previous orders|your orders|my orders)\b/im;
  const reference = /^(?:order|confirmation)\s*(?:number|no\.?|id|reference|#)\s*[:#]?\s*([a-z0-9][a-z0-9_-]{3,63})\s*$/i;
  const total = /^(?:order total|grand total|total paid|amount paid|total)\s*:?\s*((?:USD\s*\$?|US\$)\s*[\d,]+\.\d{2}|\$?[\d,]+\.\d{2}\s*USD)\s*$/i;

  function detectReceipt(text, address) {
    if (typeof text !== "string" || text.length > 150000) return null;
    let url;
    try { url = new URL(address); } catch { return null; }
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const lines = text.replace(/\u00a0/g, " ").split(/\r?\n/).map(v => v.trim()).filter(Boolean);
    const normalized = lines.join("\n");
    if (!confirmed.test(normalized) || pending.test(normalized) || history.test(normalized)) return null;
    const references = new Set();
    const amounts = new Set();
    for (let index = 0; index < lines.length; index++) {
      // Labels and values often occupy adjacent block elements.
      const candidates = [lines[index], `${lines[index]} ${lines[index + 1] || ""}`, `${lines[index]} ${lines[index + 1] || ""} ${lines[index + 2] || ""}`];
      if (/^(?:order total|grand total|total paid|amount paid|total)\s*(?::|$|[A-Z$0-9])/i.test(lines[index]) &&
          candidates.some(line => /\d/.test(line)) && !candidates.some(line => total.test(line))) return null;
      for (const line of candidates) {
        const ref = line.match(reference);
        if (ref && /\d/.test(ref[1])) references.add(ref[1].toUpperCase());
        const match = line.match(total);
        if (!match) continue;
        const raw = match[1].replace(/USD|US\$|\$|\s/gi, "");
        if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}$/.test(raw)) return null;
        const [whole, cents] = raw.replace(/,/g, "").split(".");
        const amount = Number(whole) * 100 + Number(cents);
        if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000) return null;
        amounts.add(amount);
      }
    }
    if (references.size !== 1 || amounts.size !== 1) return null;
    const orderReference = [...references][0];
    return {
      merchant: url.hostname,
      note: "Online purchase",
      amountCents: [...amounts][0],
      orderReference,
      // No query, receipt token, fragment, or browsing path leaves the browser.
      url: url.origin,
      key: `${url.hostname.toLowerCase()}|${orderReference}`
    };
  }
  root.PocketReceipt = { detectReceipt };
  if (typeof module !== "undefined") module.exports = { detectReceipt };
})(typeof globalThis !== "undefined" ? globalThis : this);
