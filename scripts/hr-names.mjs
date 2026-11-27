#!/usr/bin/env node
// HR ID -> real name, read LIVE from PRODUCTION's employees table (owner, 27 Nov 2026: "train yourself
// on all HRIDs and names ... so you never" — a session wrote an invented name for AA, who is the CEO).
//
//   node ~/.claude/scripts/hr-names.mjs AA B-10 CN-0013     the named people
//   node ~/.claude/scripts/hr-names.mjs --all               every employee (active first)
//   node ~/.claude/scripts/hr-names.mjs --find gawish       name search (English or Arabic)
//
// Read-only. Refuses to run unless .env.local names the production project, so it can never answer
// from staging. Prints HR ID, full name, job title, employment status and manager's HR ID + name.
import { readFileSync } from "node:fs";

const PRIMARY = "F:/Phoenix Workforce/phoenix-workforce";
const PROD_REF = "ozucdzovmcqvepbozvqf";

const env = {};
for (const line of readFileSync(`${PRIMARY}/.env.local`, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || !KEY) { console.error("hr-names: Supabase settings missing in .env.local"); process.exit(2); }
if (!BASE.includes(PROD_REF)) { console.error(`hr-names: REFUSED — .env.local does not name production (${PROD_REF})`); process.exit(2); }

const args = process.argv.slice(2);
const all = args.includes("--all");
const findIdx = args.indexOf("--find");
const needle = findIdx >= 0 ? args[findIdx + 1] : null;
const ids = args.filter((a, i) => !a.startsWith("--") && !(findIdx >= 0 && i === findIdx + 1));
if (!all && !needle && ids.length === 0) {
  console.error("usage: hr-names.mjs <HR ID...> | --all | --find <words>");
  process.exit(2);
}

async function fetchAll() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(
      `${BASE}/rest/v1/employees?select=hr_id,full_name,name_ar,job_title,employment_status,manager_hr_id&order=hr_id`,
      { headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${from}-${from + 999}` } },
    );
    if (!res.ok) { console.error(`hr-names: production answered ${res.status}`); process.exit(3); }
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

const key = (v) => String(v ?? "").trim().toUpperCase();
const rows = await fetchAll();
const byId = new Map(rows.map((r) => [key(r.hr_id), r]));

let picked;
if (all) picked = [...rows].sort((a, b) => (a.employment_status === "active" ? 0 : 1) - (b.employment_status === "active" ? 0 : 1));
else if (needle) {
  const n = needle.toLowerCase();
  picked = rows.filter((r) => `${r.full_name ?? ""} ${r.name_ar ?? ""}`.toLowerCase().includes(n));
} else picked = ids.map((id) => byId.get(key(id)) ?? { hr_id: id, missing: true });

console.log(`production ${PROD_REF} · ${rows.length} employees read · ${new Date().toLocaleString("en-GB", { timeZone: "Africa/Cairo" })} Cairo`);
for (const r of picked) {
  if (r.missing) { console.log(`${r.hr_id}\tNOT AN EMPLOYEE ON PRODUCTION — do not name it`); continue; }
  const mgr = r.manager_hr_id ? byId.get(key(r.manager_hr_id)) : null;
  console.log(
    `${r.hr_id}\t${r.full_name ?? "(no name)"}\t${r.job_title ?? ""}\t${r.employment_status ?? ""}` +
      (mgr ? `\tmanager ${mgr.hr_id} ${mgr.full_name}` : ""),
  );
}
