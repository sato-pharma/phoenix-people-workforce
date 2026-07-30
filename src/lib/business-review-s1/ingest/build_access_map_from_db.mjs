/**
 * S1 Business Review — builds the ACCESS MAPPING workbook straight from the live
 * employee master, so the owner confirms rather than types.
 *
 * READ-ONLY. Issues only SELECTs against production (the ref in .env.local, asserted
 * below). Writes nothing to the database.
 *
 * Authoritative sources, in the order PR #1479 established:
 *   - au_v_org_tree  → the seat map. "Which areas may this manager see?" is answered by
 *     the org tree and NEVER by a region label; six live areas sit in an operational
 *     region different from their geographic one.
 *   - app_auth_users → the role Phoenix actually gates on (not employees.job_title,
 *     which spells things differently: "Sfe Manager", "Regional Sales Manager").
 *   - employees      → display names only.
 *
 * Two different points in time are deliberately kept apart:
 *   - S1 PERFORMANCE (who owned an area Jan–Jun) comes from the sales workbooks and is
 *     already baked into data/*-s1.json. It must not be rewritten from today's org.
 *   - ACCESS (who may open the module today) comes from the live org tree. A seat that
 *     was vacant during S1 can be filled now, and vice versa — that is not a conflict,
 *     and collapsing the two would either leak data or hide a manager's own numbers.
 *
 * Area-name reality: the S1 workbooks use an older, looser geography (129 areas) than
 * today's canonical area codes (~100 seats). Only pure spelling/spacing differences are
 * aliased here. Genuine many-to-one splits and true ambiguities are NOT guessed — they
 * land on a CONFIRM sheet with candidates, because this file is a permission boundary.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import ExcelJS from "exceljs";

const ROOT = "F:/Phoenix Workforce/_wt-s1-review";
const DATA = path.join(ROOT, "src/lib/business-review-s1/data");
const OUT = "C:/Users/satoh/Downloads/Phoenix S1 Business Review - ACCESS MAPPING (confirm me).xlsx";
const PROD_REF = "ozucdzovmcqvepbozvqf";

// ---- env (never printed) ----
const env = readFileSync(path.join(ROOT, ".env.local"), "latin1");
const pick = (k) => (env.match(new RegExp(`^${k}=\\s*(.+)$`, "m"))?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
const url = pick("NEXT_PUBLIC_SUPABASE_URL");
const key = pick("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) throw new Error("missing Supabase env in .env.local");
const ref = url.split("//")[1].split(".")[0];
if (ref !== PROD_REF) throw new Error(`refusing to run: expected production ${PROD_REF}, got ${ref}`);
const db = createClient(url, key, { auth: { persistSession: false } });

const LINES = [
  { key: "pedia", label: "Pedia", code: "pedia" },
  { key: "cns", label: "CNS", code: "cns" },
  { key: "anti", label: "Anti-Infective", code: "anti_infective" },
];
const ds = Object.fromEntries(
  LINES.map((l) => [l.key, JSON.parse(readFileSync(path.join(DATA, `${l.key}-s1.json`), "utf8"))]),
);

const ngeo = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
/** Canonicalise an area/area name down to what both worlds agree on. Only spelling,
 *  spacing and the Gharbia/Sohag/Assiut numbering noise — nothing semantic. */
function canon(s) {
  let x = ngeo(s)
    .replace(/assuit/g, "assiut")
    .replace(/\bsohag\s*(\d)/g, "sohag $1")
    .replace(/\bqena\s*(\d)/g, "qena $1")
    .replace(/\bminia\s*(\d)/g, "minia $1")
    .replace(/gharbia\s*\d*\s*\(/g, "gharbia (")
    .replace(/kafr el-?sheikh\s*\d*/g, "kafr el-sheikh")
    .replace(/october\s*-\s*zayed/g, "october - zayed")
    .replace(/\bmenofia\b/g, "menoufia")
    .replace(/[\s-]+/g, " ")
    .trim();
  return x;
}

const rows = (r) => { if (r.error) throw new Error(r.error.message); return r.data ?? []; };

const tree = rows(await db.from("au_v_org_tree")
  .select("line_code,seat_tier,seat_id,parent_seat_id,region_code,area_code,area_name,occupant_hr_id,is_vacant,path")
  .in("seat_tier", ["RSM", "DM", "REP"]));
const emps = rows(await db.from("employees").select("hr_id,full_name,job_title,employment_status,line_id"));
const auth = rows(await db.from("app_auth_users").select("hr_id,role,is_active"));
const lineRows = rows(await db.from("lines").select("id,name"));
const lineNameById = new Map(lineRows.map((l) => [l.id, l.name]));

const nameOf = new Map(emps.map((e) => [String(e.hr_id).trim().toUpperCase(), e.full_name]));
const jobOf = new Map(emps.map((e) => [String(e.hr_id).trim().toUpperCase(), e.job_title]));
const statusOf = new Map(emps.map((e) => [String(e.hr_id).trim().toUpperCase(), e.employment_status]));
const lineOf = new Map(emps.map((e) => [String(e.hr_id).trim().toUpperCase(), lineNameById.get(e.line_id) ?? ""]));
const roleOf = new Map(auth.map((a) => [String(a.hr_id).trim().toUpperCase(), a]));
const up = (s) => String(s ?? "").trim().toUpperCase();

// ---------- REP seats: canon(area) -> seat, per line ----------
const repSeats = new Map();  // `${lineKey}|${canon}` -> seat row
const repByLine = new Map(LINES.map((l) => [l.key, []]));
for (const t of tree.filter((r) => r.seat_tier === "REP")) {
  const line = LINES.find((l) => l.code === t.line_code);
  if (!line) continue;
  repSeats.set(`${line.key}|${canon(t.area_name)}`, t);
  repByLine.get(line.key).push(t);
}
// ---------- DM / RSM seats ----------
const dmSeats = tree.filter((r) => r.seat_tier === "DM");
const rsmSeats = tree.filter((r) => r.seat_tier === "RSM");
const dmByRegion = new Map();  // `${lineKey}|${region_code}` -> seat
for (const t of dmSeats) {
  const line = LINES.find((l) => l.code === t.line_code);
  if (line) dmByRegion.set(`${line.key}|${t.region_code}`, t);
}
// RSM subtree -> the DM seats beneath it (authoritative RM scope)
const rsmScope = new Map();
for (const r of rsmSeats) {
  const kids = dmSeats.filter((d) => d.line_code === r.line_code && String(d.path ?? "").startsWith(String(r.path ?? "###")));
  const fallback = dmSeats.filter((d) => d.line_code === r.line_code && d.parent_seat_id === r.seat_id);
  rsmScope.set(r.seat_id, (kids.length ? kids : fallback));
}

// ---------- match every S1 area to today's rep seat ----------
const repRows = [], confirmRows = [];
for (const l of LINES) {
  for (const a of [...ds[l.key].areas].sort((x, y) => (x.region + x.area).localeCompare(y.region + y.area))) {
    const seat = repSeats.get(`${l.key}|${canon(a.area)}`);
    if (seat) {
      const hr = up(seat.occupant_hr_id);
      repRows.push({
        line: l.label, area: a.area, dmS1: a.dm, regionS1: a.region,
        s1Vacant: a.vacant, seat: seat.seat_id, areaCode: seat.area_code,
        repHr: seat.occupant_hr_id ?? "", repName: hr ? (nameOf.get(hr) ?? "") : "",
        seatVacantToday: !!seat.is_vacant,
        note: seat.is_vacant ? "seat vacant today" : "from org tree (authoritative)",
      });
    } else {
      // candidates: same line, sharing a leading token — offered, never auto-applied
      const tok = canon(a.area).split(" ")[0];
      const cands = repByLine.get(l.key).filter((s) => canon(s.area_name).startsWith(tok)).map((s) => s.area_name);
      confirmRows.push({
        line: l.label, area: a.area, dmS1: a.dm, regionS1: a.region,
        s1Vacant: a.vacant,
        reason: cands.length ? "no exact seat — candidates offered, not applied" : "no rep seat exists in today's org tree",
        candidates: cands.join(" | "),
      });
      repRows.push({
        line: l.label, area: a.area, dmS1: a.dm, regionS1: a.region,
        s1Vacant: a.vacant, seat: "", areaCode: "", repHr: "", repName: "",
        seatVacantToday: null,
        note: cands.length ? `NEEDS CONFIRM — candidates: ${cands.join(" | ")}` : "NEEDS CONFIRM — no seat in today's org tree",
      });
    }
  }
}

// ---------- MANAGERS: who may open the module today ----------
const ALL_CO = new Set(["Super Admin", "CEO", "SFE Manager", "Marketing Manager"]);
const WHOLE_LINE = new Set(["National Sales Manager", "Group Product Manager", "Product Manager"]);
const mgr = [];
for (const [hrU, a] of roleOf) {
  const role = a.role;
  const isDM = role === "District Manager", isRM = role === "Regional Manager";
  if (!ALL_CO.has(role) && !WHOLE_LINE.has(role) && !isDM && !isRM) continue;
  const status = statusOf.get(hrU) ?? "";
  const activeNow = a.is_active === true && status === "active";
  let scope = "", seats = "", lineLbl = "", note = "";
  if (ALL_CO.has(role)) { scope = "All company"; }
  else if (WHOLE_LINE.has(role)) {
    // A "Whole line" scope is meaningless without naming the line, so resolve it from
    // employees.line_id -> lines.name (employees.line_name is NULL for everyone).
    scope = "Whole line";
    lineLbl = lineOf.get(hrU) ?? "";
    if (!lineLbl) note = "no line on their employee record — cannot scope a whole-line role without it";
  }
  else if (isDM) {
    scope = "Own DM team";
    const s = dmSeats.find((d) => up(d.occupant_hr_id) === hrU);
    if (s) { seats = s.seat_id; lineLbl = LINES.find((l) => l.code === s.line_code)?.label ?? ""; }
    else note = "holds the District Manager role but occupies no DM seat in today's org tree";
  } else if (isRM) {
    scope = "Listed DM seats";
    const r = rsmSeats.find((x) => up(x.occupant_hr_id) === hrU);
    if (r) {
      lineLbl = LINES.find((l) => l.code === r.line_code)?.label ?? "";
      seats = (rsmScope.get(r.seat_id) ?? []).map((d) => nameOf.get(up(d.occupant_hr_id)) ?? `${d.seat_id} (vacant)`).join("; ");
      note = "scope = DM seats under their RSM node (org tree), not a region label — per PR #1479";
    } else note = "holds the Regional Manager role but occupies no RSM seat in today's org tree";
  }
  if (!activeNow) { scope = "(no access)"; note = `INACTIVE — app is_active=${a.is_active}, employment=${status || "unknown"}`; }
  mgr.push({
    hr: a.hr_id, name: nameOf.get(hrU) ?? "", appRole: role, jobTitle: jobOf.get(hrU) ?? "",
    line: lineLbl, scope, seats, status, note,
  });
}
mgr.sort((a, b) => (a.scope + a.line + a.name).localeCompare(b.scope + b.line + b.name));

// ================= workbook =================
const ORANGE = "FFC2410C", SLATE = "FF0F172A", SOFT = "FFE2E8F0";
const GREEN = "FFECFDF5", WARM = "FFFFF7ED", COOL = "FFF8FAFC";
const wb = new ExcelJS.Workbook();
wb.creator = "Phoenix Workforce";
wb.created = new Date();
const box = { top: { style: "thin", color: { argb: SOFT } }, left: { style: "thin", color: { argb: SOFT } }, bottom: { style: "thin", color: { argb: SOFT } }, right: { style: "thin", color: { argb: SOFT } } };

function sheet(name, title, sub, cols) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 3 }] });
  ws.mergeCells(1, 1, 1, cols.length);
  const t = ws.getCell(1, 1);
  t.value = title; t.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ORANGE } };
  t.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 14 };
  t.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(1).height = 28;
  ws.mergeCells(2, 1, 2, cols.length);
  const s = ws.getCell(2, 1);
  s.value = sub; s.font = { italic: true, color: { argb: "FF475569" }, size: 9 };
  s.alignment = { horizontal: "center" };
  const h = ws.addRow(cols.map((c) => c.h));
  h.height = 30;
  h.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: SLATE } };
    c.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 9 };
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    c.border = box;
  });
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.w; });
  return ws;
}
function put(ws, vals, fills, wrap = []) {
  const r = ws.addRow(vals);
  r.eachCell((c, i) => {
    c.font = { size: 10, color: { argb: SLATE } };
    c.alignment = { vertical: "middle", wrapText: wrap.includes(i) };
    c.border = box;
    const f = fills(i);
    if (f) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: f } };
  });
  return r;
}

// --- MANAGERS ---
let ws = sheet("MANAGERS", "MANAGERS — who may open the S1 Business Review today",
  "Pulled from app_auth_users (the role Phoenix gates on) + au_v_org_tree. Green = resolved from live data. Please confirm, and correct anything wrong.",
  [{ h: "HR ID", w: 11 }, { h: "Name", w: 34 }, { h: "App role (gating)", w: 22 }, { h: "Job title", w: 22 },
   { h: "Line", w: 15 }, { h: "ACCESS SCOPE", w: 18 }, { h: "DM seats / seat", w: 40 },
   { h: "Employment", w: 13 }, { h: "Note", w: 52 }]);
for (const m of mgr) {
  const ok = m.scope && m.scope !== "(no access)";
  put(ws, [m.hr, m.name, m.appRole, m.jobTitle, m.line, m.scope, m.seats, m.status, m.note],
    (i) => (i === 6 || i === 7 ? (ok ? GREEN : WARM) : COOL), [7, 9]);
}
ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: ws.rowCount, column: 9 } };

// --- REPS ---
ws = sheet("REPS", "REPS — today's rep behind each S1 area",
  "Rep identity is TODAY's org tree (for access). The S1 columns are the Jan–Jun owner (for performance) and are intentionally left as-is.",
  [{ h: "Line", w: 15 }, { h: "S1 area", w: 30 }, { h: "S1 DM (Jan–Jun)", w: 22 }, { h: "S1 region", w: 12 },
   { h: "S1 vacant?", w: 10 }, { h: "Area code", w: 10 }, { h: "REP NAME (today)", w: 34 },
   { h: "REP HR ID", w: 12 }, { h: "Seat vacant today?", w: 12 }, { h: "Source / action", w: 54 }]);
let matched = 0, needConfirm = 0, seatVacant = 0;
for (const r of repRows) {
  const has = !!r.repName;
  if (r.seat) matched++; else needConfirm++;
  if (r.seatVacantToday) seatVacant++;
  put(ws, [r.line, r.area, r.dmS1, r.regionS1, r.s1Vacant ? "VACANT" : "active",
           r.areaCode, r.repName, r.repHr,
           r.seatVacantToday === null ? "" : (r.seatVacantToday ? "VACANT" : "filled"), r.note],
    (i) => (i === 7 || i === 8 ? (has ? GREEN : WARM) : COOL), [10]);
}
ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: ws.rowCount, column: 10 } };

// --- CONFIRM ---
ws = sheet("CONFIRM THESE", "AREAS I COULD NOT MAP SAFELY — your call",
  "The S1 workbooks use an older geography than today's area codes. These did not match exactly, so nothing was applied. Candidates are suggestions only.",
  [{ h: "Line", w: 15 }, { h: "S1 area", w: 30 }, { h: "S1 DM", w: 22 }, { h: "S1 region", w: 12 },
   { h: "S1 vacant?", w: 10 }, { h: "Why", w: 44 }, { h: "Candidate seats in today's org tree", w: 60 }]);
for (const c of confirmRows) {
  put(ws, [c.line, c.area, c.dmS1, c.regionS1, c.s1Vacant ? "VACANT" : "active", c.reason, c.candidates],
    (i) => (i === 7 ? WARM : COOL), [6, 7]);
}
ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: ws.rowCount, column: 7 } };

// --- ROLE GAPS: someone holds a manager seat but their login role won't grant access ---
// Access is gated on app_auth_users.role, not on the org seat or the job title. A DM who
// is registered as "Employee" therefore gets nothing, which looks like a bug to them.
const gaps = [];
for (const t of [...rsmSeats, ...dmSeats]) {
  const hrU = up(t.occupant_hr_id);
  if (!hrU) continue;
  const a = roleOf.get(hrU);
  const expected = t.seat_tier === "RSM" ? "Regional Manager" : "District Manager";
  if (!a || a.role !== expected || a.is_active !== true) {
    gaps.push({
      line: LINES.find((l) => l.code === t.line_code)?.label ?? t.line_code,
      seat: t.seat_id, tier: t.seat_tier, hr: t.occupant_hr_id,
      name: nameOf.get(hrU) ?? "", job: jobOf.get(hrU) ?? "",
      appRole: a?.role ?? "(no Phoenix login row)", active: String(a?.is_active ?? ""),
      expected,
      note: !a ? "no app_auth_users row — cannot be granted access at all"
        : a.role !== expected ? `login role is "${a.role}" but the seat is ${t.seat_tier} — they will NOT get ${expected} access`
        : "login row is inactive",
    });
  }
}
if (gaps.length) {
  ws = sheet("ROLE GAPS", "SEAT HOLDERS WHOSE LOGIN ROLE WON'T GRANT ACCESS — your call",
    "Access is gated on app_auth_users.role, not the org seat or job title. These people hold a manager seat but would get nothing.",
    [{ h: "Line", w: 15 }, { h: "Seat", w: 22 }, { h: "Tier", w: 7 }, { h: "HR ID", w: 11 },
     { h: "Name", w: 32 }, { h: "Job title", w: 22 }, { h: "Login role", w: 22 },
     { h: "Login active", w: 12 }, { h: "Expected role", w: 20 }, { h: "What this means", w: 62 }]);
  for (const g of gaps) {
    put(ws, [g.line, g.seat, g.tier, g.hr, g.name, g.job, g.appRole, g.active, g.expected, g.note],
      (i) => (i === 7 ? WARM : COOL), [10]);
  }
}

// --- DM SEATS ---
ws = sheet("DM SEATS TODAY", "DM & RSM SEATS — today's occupancy from the org tree",
  "This is the authoritative answer to 'which areas may this manager see'. Region codes are context only.",
  [{ h: "Line", w: 15 }, { h: "Tier", w: 8 }, { h: "Seat ID", w: 24 }, { h: "Region code", w: 12 },
   { h: "Occupant", w: 34 }, { h: "HR ID", w: 11 }, { h: "Vacant?", w: 10 }]);
for (const t of [...rsmSeats, ...dmSeats].sort((a, b) => (a.line_code + a.seat_tier + (a.region_code ?? "")).localeCompare(b.line_code + b.seat_tier + (b.region_code ?? "")))) {
  const line = LINES.find((l) => l.code === t.line_code)?.label ?? t.line_code;
  put(ws, [line, t.seat_tier, t.seat_id, t.region_code ?? "", nameOf.get(up(t.occupant_hr_id)) ?? "", t.occupant_hr_id ?? "", t.is_vacant ? "VACANT" : "filled"],
    () => COOL);
}

// ================= access-map.json (consumed by the portal scope resolver) =================
// The S1 datasets are keyed by DM display name and area name; the portal knows only an
// HR_ID. This file is the bridge, and it is built from the seat map rather than by matching
// names — per PR #1479 the seat map is the authoritative answer to "which areas may this
// manager see", and three separate defects in this build came from name-matching.
//
// `unmappedAreas` is emitted deliberately. An area the portal cannot resolve must be
// reported to the viewer, not silently omitted: PR #1486 documents the same class of bug
// (a scope that resolved too narrowly showed 0.0% achievement with no error and no empty
// state). The page surfaces this count instead of quietly showing a short list.
// `viewers` precomputes the whole access decision per HR_ID at ingest time. Two reasons:
// the module stays isolated (the portal page needs no read of employees/app_auth_users at
// request time), and the decision becomes auditable — the owner can read exactly who gets
// what in this file and in the workbook, rather than inferring it from code. The runtime
// resolver still cross-checks the baked role against the live session role and fails closed
// on any disagreement, so a stale map can only ever grant less, never more.
const LINE_BY_DBNAME = { Pedia: "pedia", CNS: "cns", "Anti Infective": "anti", "Anti-Infective": "anti" };
const accessMap = { generatedAt: new Date().toISOString(), sourceRef: PROD_REF, lines: {}, viewers: {}, roleGaps: gaps };
for (const m of mgr) {
  const hrU = up(m.hr);
  if (!hrU || m.scope === "(no access)") continue;
  const entry = { hrId: m.hr, name: m.name, role: m.appRole, scope: null, line: null, dmSeatId: null, rsmSeatId: null, note: m.note };
  if (m.scope === "All company") entry.scope = "company";
  else if (m.scope === "Whole line") {
    const lk = LINE_BY_DBNAME[m.line];
    if (!lk) continue;                       // no resolvable line -> no access, never company-wide
    entry.scope = "line"; entry.line = lk;
  } else if (m.scope === "Own DM team") {
    const s = dmSeats.find((d) => up(d.occupant_hr_id) === hrU);
    if (!s) continue;
    entry.scope = "ownDm"; entry.dmSeatId = s.seat_id;
    entry.line = LINES.find((l) => l.code === s.line_code)?.key ?? null;
    if (!entry.line) continue;
  } else if (m.scope === "Listed DM seats") {
    const r = rsmSeats.find((x) => up(x.occupant_hr_id) === hrU);
    if (!r) continue;
    entry.scope = "dmSeats"; entry.rsmSeatId = r.seat_id;
    entry.line = LINES.find((l) => l.code === r.line_code)?.key ?? null;
    entry.dmSeatIds = (rsmScope.get(r.seat_id) ?? []).map((d) => d.seat_id);
    if (!entry.line || !entry.dmSeatIds.length) continue;
  } else continue;
  accessMap.viewers[hrU] = entry;
}
for (const l of LINES) {
  const dmsForLine = dmSeats.filter((d) => d.line_code === l.code).map((d) => ({
    seatId: d.seat_id, regionCode: d.region_code ?? null,
    hrId: d.occupant_hr_id ?? null, name: nameOf.get(up(d.occupant_hr_id)) ?? null,
    isVacant: !!d.is_vacant,
  }));
  const rsmForLine = rsmSeats.filter((r) => r.line_code === l.code).map((r) => ({
    seatId: r.seat_id, hrId: r.occupant_hr_id ?? null,
    name: nameOf.get(up(r.occupant_hr_id)) ?? null,
    dmSeatIds: (rsmScope.get(r.seat_id) ?? []).map((d) => d.seat_id),
  }));
  const areas = {};
  const unmapped = [];
  for (const r of repRows.filter((x) => x.line === l.label)) {
    if (!r.seat) { unmapped.push(r.area); continue; }
    const repSeat = repByLine.get(l.key).find((s) => s.seat_id === r.seat);
    // A rep seat's owning DM seat: same line + same region_code. line_area_map is the
    // stricter source but region is sufficient here because every rep seat in the tree
    // hangs off exactly one DM seat within its region.
    const owningDm = dmsForLine.find((d) => d.regionCode === repSeat?.region_code);
    areas[r.area] = {
      seatId: r.seat, areaCode: r.areaCode || null,
      repHrId: r.repHr || null, repName: r.repName || null,
      seatVacantToday: r.seatVacantToday === null ? null : !!r.seatVacantToday,
      dmSeatId: owningDm?.seatId ?? null, dmHrId: owningDm?.hrId ?? null,
      s1Dm: r.dmS1, s1Region: r.regionS1,
    };
  }
  accessMap.lines[l.key] = { label: l.label, lineCode: l.code, dmSeats: dmsForLine, rsmSeats: rsmForLine, areas, unmappedAreas: unmapped };
}
writeFileSync(path.join(DATA, "access-map.json"), JSON.stringify(accessMap, null, 1), "utf8");

await wb.xlsx.writeFile(OUT);
console.log("========= ACCESS MAPPING (from live employee master) =========");
console.log(`MANAGERS   : ${mgr.length} rows | ${mgr.filter((m) => m.scope !== "(no access)").length} get access, ${mgr.filter((m) => m.scope === "(no access)").length} blocked as inactive`);
console.log(`REPS       : ${repRows.length} areas | ${matched} mapped to a seat | ${needConfirm} need confirming | ${seatVacant} seats vacant today`);
console.log(`CONFIRM    : ${confirmRows.length} areas listed for your call`);
console.log(`ROLE GAPS  : ${gaps.length} seat holders whose login role won't grant access`);
for (const g of gaps) console.log(`             ${g.hr} ${g.name} — ${g.note}`);
console.log("WROTE", OUT);
