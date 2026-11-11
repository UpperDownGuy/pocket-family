"use strict";
const native = message => browser.runtime.sendNativeMessage("com.example.PocketFamily", message);
const extensionOrigin = browser.runtime.getURL("");

function senderOrigin(sender) {
  try {
    if (!sender.tab || sender.frameId !== 0) return null;
    const page = new URL(sender.url);
    const tab = new URL(sender.tab.url);
    return page.protocol === "https:" && page.origin === tab.origin ? page.origin : null;
  } catch { return null; }
}

browser.runtime.onMessage.addListener(async (message, sender) => {
  if (sender.id !== browser.runtime.id || !message || typeof message.type !== "string") return { ok: false, error: "Invalid request." };
  const ui = !sender.tab && typeof sender.url === "string" && sender.url.startsWith(extensionOrigin);
  try {
    if (ui && ["status", "login", "logout"].includes(message.type)) return await native(message);
    if (ui && message.type === "rescan") {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) return await browser.tabs.sendMessage(tab.id, { type: "rescan" });
      return { ok: false, error: "Open a store page first." };
    }
    const origin = senderOrigin(sender);
    if (!origin) return { ok: false, error: "Open a secure store page." };
    const { enabledOrigins = [] } = await browser.storage.local.get("enabledOrigins");
    const enabled = enabledOrigins.includes(origin);
    if (message.type === "enabled") return { enabled };
    if (message.type !== "receipt" || !enabled) return { ok: false, error: "This site is not enabled." };
    const receipt = message.receipt;
    const host = new URL(origin).hostname;
    if (!receipt || receipt.url !== origin || receipt.merchant !== host ||
        !Number.isSafeInteger(receipt.amountCents) || receipt.amountCents < 1 || receipt.amountCents > 1000000 ||
        !/^[A-Z0-9][A-Z0-9_-]{3,63}$/.test(receipt.orderReference || "") || !/\d/.test(receipt.orderReference)) {
      return { ok: false, error: "This receipt could not be verified." };
    }
    const result = await native({ type: "purchase", receipt: {
      merchant: host, note: "Online purchase", amountCents: receipt.amountCents,
      orderReference: receipt.orderReference, url: origin
    } });
    await browser.storage.local.set({ lastDelivery: {
      origin, ok: result?.ok === true, at: new Date().toISOString(),
      message: result?.ok ? "Purchase saved." : (result?.error || "Purchase was not saved.")
    } });
    return result;
  } catch {
    const result = { ok: false, error: "Could not reach Pocket. Open the app and check your server." };
    if (message.type === "receipt") await browser.storage.local.set({ lastDelivery: { ok: false, at: new Date().toISOString(), message: result.error } });
    return result;
  }
});
