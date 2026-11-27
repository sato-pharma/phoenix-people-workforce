// Single-shot watcher for PHX-TAB-0008: has it checked in since the baseline, and if so what GPS fix?
// Read-only against the live Headwind server. Prints a clear verdict line. No credentials printed.
// Run inside Railway env:  railway run --service phoenix-people-workforce -- node <this file>
import { createHash } from "node:crypto";

const base = (process.env.HEADWIND_MDM_BASE_URL || "").replace(/\/+$/, "");
const cf = process.env.HEADWIND_MDM_ACCESS_CLIENT_ID
  ? { "CF-Access-Client-Id": process.env.HEADWIND_MDM_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": process.env.HEADWIND_MDM_ACCESS_CLIENT_SECRET }
  : {};
const BASELINE = 1792674165378; // 22 Oct 2026 16:02:45 Cairo — last contact before the watch began
const cairo = (ms) => (ms ? new Date(Number(ms)).toLocaleString("en-GB", { timeZone: "Africa/Cairo" }) : null);

if (!base || !process.env.HEADWIND_MDM_LOGIN || !process.env.HEADWIND_MDM_PASSWORD) {
  console.log("VERDICT: ERROR missing-headwind-env");
  process.exit(2);
}
const lr = await fetch(base + "/rest/public/jwt/login", {
  method: "POST", headers: { "Content-Type": "application/json", ...cf },
  body: JSON.stringify({ login: process.env.HEADWIND_MDM_LOGIN, password: createHash("md5").update(process.env.HEADWIND_MDM_PASSWORD).digest("hex").toUpperCase() }),
});
const lj = await lr.json().catch(() => ({}));
const token = lj.id_token || lj.token || lj?.data?.token;
if (!token) { console.log("VERDICT: ERROR login-http-" + lr.status); process.exit(3); }
const auth = { "Authorization": "Bearer " + token, "Content-Type": "application/json", ...cf };

const sr = await fetch(base + "/rest/private/devices/search", {
  method: "POST", headers: auth, body: JSON.stringify({ pageNum: 1, pageSize: 1000, value: "0008" }),
});
const sj = await sr.json();
const page = sj.data ?? sj;
const items = Array.isArray(page.devices?.items) ? page.devices.items : Array.isArray(page.items) ? page.items : Array.isArray(page.devices) ? page.devices : [];
const d = items.find((x) => String(x.number).includes("0008"));
if (!d) { console.log("VERDICT: ERROR device-0008-not-found"); process.exit(4); }

const last = Number(d.lastUpdate || 0);
const info = d.info || {};
const launcher = (info.applications || []).find((a) => String(a.pkg).includes("launcher"));
const ver = launcher ? launcher.version : "unknown";

if (last <= BASELINE) {
  console.log(`VERDICT: SILENT lastContact=${cairo(last)} launcher=${ver}`);
  process.exit(0);
}

// It has checked in — read its GPS.
const pr = await fetch(base + "/rest/plugins/deviceinfo/deviceinfo/private/search/dynamic", {
  method: "POST", headers: auth,
  body: JSON.stringify({ deviceFilter: d.number, pageNum: 1, pageSize: 10, sortValue: "createTime" }),
});
const pj = await pr.json().catch(() => ({}));
const recs = pj.data?.items || pj.items || pj.data || [];
const fixes = (Array.isArray(recs) ? recs : []).filter((r) => typeof r.gpsLat === "number" && typeof r.gpsLon === "number");
const checkinLoc = info.location || null;

console.log(`VERDICT: CHECKED_IN lastContact=${cairo(last)} launcher=${ver}`);
console.log(`checkinLocation=${JSON.stringify(checkinLoc)}`);
console.log(`gpsFixes=${fixes.length}`);
for (const r of fixes.slice(0, 5)) {
  console.log(`  @${cairo(r.latestUpdateTime || r.createTime)} lat=${r.gpsLat} lon=${r.gpsLon}`);
}
