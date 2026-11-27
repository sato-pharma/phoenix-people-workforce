// Runs ON THE SPARE as user phoenix (installed at ~/phoenix/speed-report.mjs), weekly from the timer
// phoenix-speed-report (Sunday 09:00 Cairo, the first morning of the work week). Source:
// ~/.claude/scripts/spare-speed-report.mjs on the main laptop.
// Owner, 2026-11-23: "do spare recommendation 26" - a weekly speed report for the main pages, to catch any page that
// has become slower.
//
// WHAT IT MEASURES: REAL people on PRODUCTION, not the spare's dev server. Every browser sends its timings
// (src/components/layout/page-timing-beacon.tsx) and the web process keeps hourly summaries in page_timings - the same
// table the System Audit's "Slowest pages" tab reads. Two figures per page, each as the count-weighted MEDIAN of the
// hourly medians (since 23 Nov; the mean let one 83 s load fake a slower page):
//   LOAD  a full page load: first content painted (metric fcp, kind hard) - every browser reports it
//   TAP   a tap inside the app that reached the page: tap to page drawn (metric soft, kind soft)
// The last 7 days against the 7 before. A page is SLOWER when it has at least 30 samples in BOTH weeks and its median
// rose by 30% or more AND by at least 500 ms (load) / 150 ms (tap) - small pages and noise do not alarm.
// ONE Telegram to the owner every week (it is a report): the slower pages, the 3 that got most faster, and the 5
// busiest pages' load times. Only the page's address is sent - page_timings holds no person.
// DRY=1 prints the message and sends nothing (it still checks the bot with getMe). Log: ~/phoenix/speed-report.log
import { readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";

const P = `${homedir()}/phoenix`;
const DRY = process.env.DRY === "1";
const log = (m) => { if (DRY) console.log(m); else appendFileSync(`${P}/speed-report.log`, `${new Date().toLocaleString("sv-SE", { timeZone: "Africa/Cairo" })} ${m}\n`); };
const env = {};
for (const line of readFileSync(`${P}/phoenix-workforce/.env.local`, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}
const URL_ = (env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const TOKEN = env.TELEGRAM_BOT_TOKEN;
if (!URL_ || !KEY || !TOKEN) { log("SPEED REPORT NOT SENT: Supabase or Telegram settings missing in .env.local"); process.exit(1); }
if (!URL_.includes("ozucdzovmcqvepbozvqf")) { log("SPEED REPORT NOT SENT: .env.local does not name the production project"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "User-Agent": "phoenix-watch/1.0" };
async function sb(q) {
  const r = await fetch(`${URL_}/rest/v1/${q}`, { headers: H, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`${q.split("?")[0]}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const now = Date.now();
const cut = new Date(now - 7 * 864e5).toISOString();
const since = new Date(now - 14 * 864e5).toISOString();
const rows = [];
for (let from = 0; ; from += 1000) {
  const page = await sb(`page_timings?select=hour,path,kind,metric,count,p50_ms&hour=gte.${since}&or=(and(kind.eq.hard,metric.eq.fcp),and(kind.eq.soft,metric.eq.soft))&order=hour.asc,path.asc,device.asc&limit=1000&offset=${from}`);
  rows.push(...page);
  if (page.length < 1000) break;
  if (from > 200_000) throw new Error("page_timings read did not end");
}
// fold: path|what|week -> hourly medians with their sample counts. The week's figure is the COUNT-WEIGHTED MEDIAN of
// the hourly medians, not their mean: on 21 Nov ONE load of /admin/field-crm just after midnight took 83 s while the
// other eleven painted in 0.7-3 s, the mean read 8 s and the first report called the board 60% slower when nothing had
// changed. A median needs most of a week's loads to be slower before it moves.
const acc = new Map();
for (const r of rows) {
  const what = r.kind === "hard" ? "load" : "tap";
  const wk = r.hour >= cut ? "now" : "before";
  const k = `${r.path}|${what}|${wk}`;
  const list = acc.get(k) ?? [];
  list.push({ ms: Number(r.p50_ms), n: Number(r.count) });
  acc.set(k, list);
}
const med = (path, what, wk) => {
  const list = acc.get(`${path}|${what}|${wk}`);
  if (!list) return null;
  const n = list.reduce((s, x) => s + x.n, 0);
  if (!n) return null;
  const sorted = [...list].sort((x, y) => x.ms - y.ms);
  let seen = 0;
  for (const x of sorted) { seen += x.n; if (seen * 2 >= n) return { n, ms: Math.round(x.ms) }; }
  return { n, ms: Math.round(sorted.at(-1).ms) };
};
const paths = [...new Set(rows.map((r) => r.path))];
const pairs = [];
for (const path of paths) for (const what of ["load", "tap"]) {
  const a = med(path, what, "before"), b = med(path, what, "now");
  if (a && b && a.n >= 30 && b.n >= 30) pairs.push({ path, what, before: a.ms, now: b.ms, nBefore: a.n, nNow: b.n, pct: a.ms ? Math.round((100 * (b.ms - a.ms)) / a.ms) : 0 });
}
const slower = pairs.filter((p) => p.pct >= 30 && p.now - p.before >= (p.what === "load" ? 500 : 150)).sort((x, y) => (y.now - y.before) - (x.now - x.before));
const faster = pairs.filter((p) => p.pct <= -15).sort((x, y) => (x.now - x.before) - (y.now - y.before)).slice(0, 3);
const busiest = pairs.filter((p) => p.what === "load").sort((x, y) => y.nNow - x.nNow).slice(0, 5);
const loadsNow = [...acc].filter(([k]) => k.endsWith("|load|now")).reduce((s, [, list]) => s + list.reduce((t, x) => t + x.n, 0), 0);
const s = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
const line = (p) => `${p.path} (${p.what === "load" ? "page load" : "tap"}): ${s(p.before)} -> ${s(p.now)} (${p.pct > 0 ? "+" : ""}${p.pct}%, ${p.nNow} times)`;
const fmt = (d) => d.toLocaleDateString("en-GB", { timeZone: "Africa/Cairo", day: "numeric", month: "short" });
const msg = [
  `Weekly page speed, ${fmt(new Date(now - 7 * 864e5))} to ${fmt(new Date(now))} (real people on production, ${loadsNow} page loads):`,
  slower.length ? `${slower.length} page(s) got SLOWER:` : "No page got slower against the week before.",
  ...slower.slice(0, 10).map((p) => `- ${line(p)}`),
  ...(slower.length > 10 ? [`- and ${slower.length - 10} more (the System Audit page, Slowest pages tab)`] : []),
  ...(faster.length ? ["Faster:", ...faster.map((p) => `- ${line(p)}`)] : []),
  "Busiest pages, time to first content:",
  ...busiest.map((p) => `- ${p.path}: ${s(p.now)} (${p.nNow} loads)`),
  "Slower = the week's median is at least 30% and 0.5 s (a tap: 0.15 s) higher, with 30+ samples in both weeks - one freak load cannot trigger it.",
].join("\n");
log(`speed report: ${rows.length} hourly rows, ${pairs.length} pages compared, ${slower.length} slower, ${faster.length} faster`);
if (!pairs.length) { log("SPEED REPORT NOT SENT: no page had 30 samples in both weeks - the timings may have stopped arriving"); }

// The owner's Telegram, the way admin-telegram-mirror.ts finds him: standing admin email -> hr_id -> connected chat.
const emp = await sb("employees?select=hr_id&work_email=ilike.omar.anwar@satopharma.com&limit=1");
const hr = emp[0]?.hr_id;
if (!hr) { log("SPEED REPORT NOT SENT: the standing admin email matched no employee"); process.exit(1); }
const chats = (await sb(`telegram_connections?select=telegram_chat_id&status=eq.connected&hr_id=ilike.${encodeURIComponent(hr)}`)).map((r) => r.telegram_chat_id).filter(Boolean);
if (!chats.length) { log("SPEED REPORT NOT SENT: the owner has no connected Telegram chat"); process.exit(1); }
const text = pairs.length ? msg : `Weekly page speed: NO REPORT - no page had 30 samples in both weeks (${rows.length} hourly rows read). The page timings may have stopped arriving from browsers.`;
if (DRY) {
  console.log(`DRY RUN - would send to ${chats.length} chat(s):\n${text}`);
  const me = await fetch(`https://api.telegram.org/bot${TOKEN}/getMe`, { signal: AbortSignal.timeout(20_000) });
  console.log(me.ok ? "bot token valid (getMe)" : "bot token REJECTED");
  process.exit(0);
}
let sent = 0;
for (const c of chats) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ chat_id: String(c), text, disable_web_page_preview: "true" }), signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (r?.ok) sent += 1;
}
log(`speed report sent to Telegram: ${sent ? "yes" : "FAILED"}`);
process.exit(sent ? 0 : 1);
