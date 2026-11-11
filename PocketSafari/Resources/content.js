(() => {
  "use strict";
  let busy = false;
  let lastSent = "";
  let timer;
  let enabled = false;

  function receiptText() {
    // Read visible, non-editable text only. Never inspect autofill, forms,
    // payment fields, card details, cookies, or network requests.
    const skip = "input,textarea,select,form,script,style,noscript,[contenteditable],[hidden],[aria-hidden='true']";
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const lines = [];
    let length = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || parent.closest(skip)) continue;
      let excluded = false;
      for (let item = parent; item && item !== document.body; item = item.parentElement) {
        if (/(?:^|[-_\s])(card|payment|billing|address|contact|email|phone)(?:$|[-_\s])/i.test(`${item.id} ${item.className}`)) { excluded = true; break; }
      }
      if (excluded || !parent.getClientRects().length) continue;
      const style = getComputedStyle(parent);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const value = node.textContent.trim();
      if (value) { lines.push(value); length += value.length; }
      if (length > 150000) return "";
    }
    return lines.join("\n");
  }

  async function scan() {
    if (busy || !enabled || document.visibilityState !== "visible" || !document.body) return { ok: false, error: "Enable this site and keep the page open." };
    busy = true;
    try {
      const candidate = PocketReceipt.detectReceipt(receiptText(), location.href);
      if (!candidate) return { ok: false, error: "No clear USD order confirmation found. Record this purchase in Pocket." };
      if (candidate.key === lastSent) return { ok: true, message: "Purchase already saved." };
      const result = await browser.runtime.sendMessage({ type: "receipt", receipt: candidate });
      if (result?.ok) lastSent = candidate.key;
      return result;
    } catch { return { ok: false, error: "Could not reach Pocket." }; }
    finally { busy = false; }
  }

  function schedule() { clearTimeout(timer); timer = setTimeout(scan, 800); }
  async function refreshEnabled() {
    try {
      const result = await browser.runtime.sendMessage({ type: "enabled" });
      enabled = result?.enabled === true;
      if (enabled) schedule();
    } catch { enabled = false; }
  }
  browser.runtime.onMessage.addListener(async message => {
    if (message.type === "rescan") {
      await refreshEnabled();
      clearTimeout(timer);
      return await scan();
    }
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.enabledOrigins) refreshEnabled();
  });
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  document.addEventListener("visibilitychange", schedule);
  refreshEnabled();
})();
