// Read-only watcher for the rep tablets' FIRST location fix and for PHX-TAB-0008 reconnecting.
// Uses ONLY the device-search endpoint (proven to work): the check-in position (d.info.location) is the
// source that always arrives and does NOT depend on the deviceinfo-plugin field bug. No writes, no creds printed.
// Run:  railway run --service phoenix-people-workforce -- node C:/Users/satoh/.claude/scripts/hw-rep-tablet-location-watch.mjs
import { createHash } from "node:crypto";

const base = (process.env.HEADWIND_MDM_BASE_URL || "").replace(/\/+$/, "");
const cf = process.env.HEADWIND_MDM_ACCESS_CLIENT_ID
  ? { "CF-Access-Client-Id": process.env.HEADWIND_MDM_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": process.env.HEADWIND_MDM_ACCESS_CLIENT_SECRET }
  : {};
const cairo = (ms) => (ms ? new Date(Number(ms)).toLocaleString("en-GB", { timeZone: "Africa/Cairo" }) : null);
// 22 Oct 2026 16:02:45 Cairo — PHX-TAB-0008's last contact before the watch began.
const TAB0008_BASELINE = 1792674165378;

if (!base || !process.env.HEADWIND_MDM_LOGIN || !process.env.HEADWIND_MDM_PASSWORD) {
  console.log("VERDICT: ERROR missing-headwind-env");
  process.exit(2);
}
const lr = await fetch(base + "/rest/public/jwt/login", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...cf },
  body: JSON.stringify({ login: process.env.HEADWIND_MDM_LOGIN, password: createHash("md5").update(process.env.HEADWIND_MDM_PASSWORD).digest("hex").toUpperCase() }),
});
const token = (await lr.json().catch(() => ({}))).id_token;
if (!token) {
  console.log("VERDICT: ERROR login-http-" + lr.status);
  process.exit(3);
}
const auth = { Authorization: "Bearer " + token, "Content-Type": "application/json", ...cf };
const sr = await fetch(base + "/rest/private/devices/search", { method: "POST", headers: auth, body: JSON.stringify({ pageNum: 1, pageSize: 1000, value: "" }) });
if (!sr.ok) {
  console.log("VERDICT: ERROR search-http-" + sr.status);
  process.exit(4);
}
const page = (await sr.json()).data ?? {};
const items = page.devices?.items ?? page.items ?? page.devices ?? [];
const by = (n) => items.find((d) => String(d.number).includes(n));

const report = (d) => {
  const info = d.info || {};
  const loc = info.location || null;
  // 🔴 No launcher version here: the server's top-level launcherVersion is the TARGET, not what the
  // tablet runs — it read 6.48 for PHX-TAB-0008, which went silent before 6.48 existed (1 Nov 2026).
  return {
    number: d.number,
    lastContact: cairo(d.lastUpdate),
    battery: info.batteryLevel ?? null,
    location: loc ? { lat: loc.lat, lon: loc.lon, at: cairo(loc.ts) } : null,
  };
};

const t7 = by("0007");
const t8 = by("0008");
const lines = [];
let newsFor0007 = false;
let newsFor0008 = false;

if (t7) {
  const r7 = report(t7);
  if (r7.location) {
    newsFor0007 = true;
    lines.push(`0007 (Gannatullah) HAS A LOCATION FIX: ${JSON.stringify(r7)}`);
  } else {
    lines.push(`0007 (Gannatullah) online, still NO location fix: lastContact=${r7.lastContact} battery=${r7.battery}`);
  }
} else {
  lines.push("0007 not found on the server");
}

if (t8) {
  const r8 = report(t8);
  if (Number(t8.lastUpdate || 0) > TAB0008_BASELINE) {
    newsFor0008 = true;
    lines.push(`0008 (Ahmed) RECONNECTED: ${JSON.stringify(r8)}`);
  } else {
    lines.push(`0008 (Ahmed) still SILENT since ${r8.lastContact}`);
  }
} else {
  lines.push("0008 not found on the server");
}

// Each event is reported ONCE: a small state file remembers what was already told, so a fix that is still
// there next hour is not news again. Both told → DONE, and the task deletes itself.
const { readFileSync, writeFileSync } = await import("node:fs");
const STATE = new URL("./hw-rep-tablet-location-watch.state.json", import.meta.url);
let state = { told0007: false, told0008: false };
try {
  state = { ...state, ...JSON.parse(readFileSync(STATE, "utf8")) };
} catch {}
const new0007 = newsFor0007 && !state.told0007;
const new0008 = newsFor0008 && !state.told0008;
const next = { told0007: state.told0007 || newsFor0007, told0008: state.told0008 || newsFor0008 };
writeFileSync(STATE, JSON.stringify(next));

const verdict = next.told0007 && next.told0008 && (new0007 || new0008) ? "DONE" : new0007 || new0008 ? "NEWS" : next.told0007 && next.told0008 ? "DONE" : "QUIET";
console.log(`VERDICT: ${verdict} @ ${cairo(Date.now())}`);
for (const l of lines) console.log("  " + l);
console.log(`new this run: 0007=${new0007} 0008=${new0008} | already told: 0007=${state.told0007} 0008=${state.told0008}`);
