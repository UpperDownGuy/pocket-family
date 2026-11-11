"use strict";
const $ = id => document.getElementById(id);
let origin = null;
let isEnabled = false;
const send = message => browser.runtime.sendMessage(message);
function status(text) { $("status").textContent = text; }
async function refresh() {
  const result = await send({ type: "status" });
  if (!result?.ok) throw new Error(result?.error || "Could not open Pocket.");
  $("login").hidden = result.signedIn;
  $("controls").hidden = !result.signedIn;
  $("identity").textContent = result.signedIn ? `Signed in as ${result.name}` : "Use your child's Pocket account.";
  $("server").value = result.serverURL || "http://127.0.0.1:8787";
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  try { const url = new URL(tab?.url); origin = url.protocol === "https:" ? url.origin : null; } catch { origin = null; }
  const { enabledOrigins = [], lastDelivery } = await browser.storage.local.get(["enabledOrigins", "lastDelivery"]);
  isEnabled = !!origin && enabledOrigins.includes(origin);
  $("site").textContent = origin ? new URL(origin).hostname : "Open an HTTPS store page in Safari.";
  $("toggle").textContent = isEnabled ? "Disable this site" : "Enable this site";
  $("toggle").disabled = !origin;
  $("rescan").disabled = !isEnabled;
  if (lastDelivery && (!lastDelivery.origin || lastDelivery.origin === origin)) status(lastDelivery.message);
}
$("login").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("login").querySelector("button"); button.disabled = true;
  try {
    const result = await send({ type:"login", serverURL:$("server").value, username:$("username").value, password:$("password").value });
    $("password").value = "";
    if (!result?.ok) throw new Error(result?.error || "Sign-in failed.");
    status("Signed in."); await refresh();
  } catch (error) { status(error.message); }
  finally { $("password").value = ""; button.disabled = false; }
});
$("toggle").addEventListener("click", async () => {
  if (!origin) return;
  try {
    if (!isEnabled && !await browser.permissions.request({ origins:[`${origin}/*`] })) { status("Safari access was not granted."); return; }
    const { enabledOrigins = [] } = await browser.storage.local.get("enabledOrigins");
    const next = isEnabled ? enabledOrigins.filter(value => value !== origin) : [...new Set([...enabledOrigins, origin])];
    await browser.storage.local.set({ enabledOrigins: next });
    if (isEnabled) await browser.permissions.remove({ origins:[`${origin}/*`] });
    status(isEnabled ? "Site disabled." : "Site enabled. Reload this page once.");
    await refresh();
  } catch (error) { status(error.message); }
});
$("rescan").addEventListener("click", async () => {
  try {
    status("Checking for a clear order confirmation…");
    const result = await send({ type:"rescan" });
    status(result?.ok ? (result.message || "Purchase saved.") : (result?.error || "Reload this page and try again."));
  }
  catch { status("Reload the page, then try again."); }
});
$("logout").addEventListener("click", async () => {
  const result = await send({ type:"logout" });
  if (!result?.ok) return status(result?.error || "Could not sign out.");
  await browser.storage.local.remove(["enabledOrigins", "lastDelivery"]);
  status("Signed out."); await refresh();
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.lastDelivery?.newValue) status(changes.lastDelivery.newValue.message);
});
refresh().catch(error => status(error.message));
