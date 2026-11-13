/**
 * Link every Phoenix CRM pharmacy to the distributor customer that is the same shop.
 *
 * Owner, 13 Nov 2026: compare every pharmacy on a rep's Phoenix CRM list by name with the distributor
 * customers (source_of_sales_customer_map) of the SAME area, then "save the exact and strong matches as
 * links". He chose two things on the same day:
 *   - save only a match whose name fits ONE shop in the area; a name several shops share waits for the rep;
 *   - link dropped pharmacies too — it is the same shop either way.
 *
 * The pharmacy's area is its rep seat's area (au_v_seat_occupancy_all, the seat live today): only a few
 * pharmacies carry a pin of their own. One shop bought through three distributors is three link rows.
 *
 * DRY RUN IS THE DEFAULT — it reads production and prints what it would write. `--apply --actor=<HR id>`
 * inserts the missing pairs into public.phoenix_crm_pharmacy_distributor_links (additive: it never
 * updates or deletes a row, so a pair a person later marks 'confirmed' is left alone).
 *
 * Usage:
 *   node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node \
 *     --experimental-loader ./tests/alias-loader.mjs scripts/phoenix-crm-pharmacy-distributor-links.ts [--apply --actor=B-10]
 */
import { normalizeCustomerName } from "@/lib/sales/customer-channel";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

const SOURCE = "name_audit_2026_11_13";
const known = new Set(["apply", "actor"]);
const args = process.argv.slice(2);
for (const entry of args) {
  const name = entry.replace(/^--/, "").split("=")[0];
  if (!entry.startsWith("--") || !known.has(name)) {
    console.error(`REFUSED — unknown argument ${entry}. Known: --apply --actor=<HR id>`);
    process.exit(2);
  }
}
const apply = args.includes("--apply");
const actor = args.find((entry) => entry.startsWith("--actor="))?.slice("--actor=".length) ?? null;
if (apply && !actor) {
  console.error("REFUSED — --apply needs --actor=<HR id> (who asked for the links).");
  process.exit(2);
}

// ---------- names ----------
const DIGITS = "٠١٢٣٤٥٦٧٨٩";
function fold(value: unknown): string {
  let out = "";
  for (const ch of normalizeCustomerName(String(value ?? ""))) {
    const digit = DIGITS.indexOf(ch);
    out += digit >= 0 ? String(digit) : ch === "ؤ" ? "و" : ch === "ئ" ? "ي" : ch;
  }
  return out.replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}
// Words that say "pharmacy" or "doctor" and nothing about WHICH one.
const GENERIC = new Set(["صيدليه", "صيدليات", "صيدلي", "صيدلا", "صيدلاني", "ص", "صي", "صيد", "د", "دكتور", "دكتوره", "الدكتور", "الدكتوره", "دكت", "اجزخانه",
  "pharmacy", "pharmacies", "pharma", "ph", "phar", "pharm", "dr", "phcy", "فرع", "ش", "م", "ا", "و", "مستشفي", "مركز"]);
function tokens(folded: string): string[] {
  return folded.split(" ").filter((t) => t && !GENERIC.has(t))
    .map((t) => (t.length > 4 && t.startsWith("ال") ? t.slice(2) : t))
    .map((t) => (t.startsWith("وال") && t.length > 5 ? t.slice(3) : t));
}
type Name = { core: string[]; key: string };
function prepare(name: unknown): Name {
  // "صيدلية منير الجديدة - المنيب": the part after a dash is a place, not the name.
  const head = String(name ?? "").split(/\s[-–—]\s|\s*[-–—]\s+|\s+[-–—]\s*/)[0];
  const core = tokens(fold(head));
  const all = tokens(fold(name));
  const used = core.length ? core : all;
  return { core: used, key: used.join(" ") };
}
function bigrams(text: string): Map<string, number> {
  const grams = new Map<string, number>();
  const padded = ` ${text} `;
  for (let i = 0; i < padded.length - 1; i++) { const g = padded.slice(i, i + 2); grams.set(g, (grams.get(g) ?? 0) + 1); }
  return grams;
}
function dice(a: Map<string, number>, b: Map<string, number>): number {
  let inter = 0, na = 0, nb = 0;
  for (const v of a.values()) na += v;
  for (const v of b.values()) nb += v;
  for (const [k, v] of a) { const w = b.get(k); if (w) inter += Math.min(v, w); }
  return na + nb === 0 ? 0 : (2 * inter) / (na + nb);
}
const tokenSimCache = new Map<string, number>();
function tokenSim(x: string, y: string): number {
  if (x === y) return 1;
  const key = x < y ? `${x}|${y}` : `${y}|${x}`;
  let v = tokenSimCache.get(key);
  if (v === undefined) {
    v = dice(bigrams(x), bigrams(y));
    if ((x.startsWith(y) || y.startsWith(x)) && Math.min(x.length, y.length) >= 3) v = Math.max(v, 0.85);
    tokenSimCache.set(key, v);
  }
  return v;
}
function tokenScore(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const side = (p: string[], q: string[]) => p.reduce((s, x) => s + Math.max(...q.map((y) => tokenSim(x, y))), 0) / p.length;
  const ab = side(a, b), ba = side(b, a);
  return a.length <= b.length ? 0.65 * ab + 0.35 * ba : 0.65 * ba + 0.35 * ab;
}
// A same-brick pin nudges; the rep's typed place never decides a link on its own, so it is left out here.
function score(crm: Name, crmGrams: Map<string, number>, crmBrick: string | null, shop: Shop): number {
  if (crm.key === shop.name.key) return 1;
  let s = 0.6 * tokenScore(crm.core, shop.name.core) + 0.4 * dice(crmGrams, shop.grams);
  if (crmBrick && shop.brick && crmBrick === shop.brick) s += 0.04;
  return Math.min(s, 0.99);
}

// ---------- read ----------
const db = getSupabaseAdmin();
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
const [pharmacies, seats, mapRows, existing] = await Promise.all([
  fetchAllRows<Row>(() => db.from("phoenix_crm_customers").select("id, seat_id, name, status, pharmacy_pin_brick_id").eq("list_type", "Pharmacy").eq("is_test", false), "id"),
  fetchAllRows<Row>(() => db.from("au_v_seat_occupancy_all").select("seat_id, area_code, effective_from, effective_to"), "seat_id"),
  fetchAllRows<Row>(() => db.from("source_of_sales_customer_map").select("id, distributor_code, customer_code, customer_name, brick_id, area_code").eq("active", true), "id"),
  fetchAllRows<Row>(() => db.from("phoenix_crm_pharmacy_distributor_links").select("crm_customer_id, distributor_code, customer_code"), "id"),
]);
const seatArea = new Map<string, { area: string | null; live: boolean; from: string }>();
for (const s of seats) {
  const from = String(s.effective_from ?? "");
  const live = (!s.effective_from || from <= today) && (!s.effective_to || String(s.effective_to) >= today);
  const seatId = String(s.seat_id);
  const cur = seatArea.get(seatId);
  if (!cur || (live && !cur.live) || (live === cur.live && from > cur.from)) seatArea.set(seatId, { area: (s.area_code as string) ?? null, live, from });
}

// One shop per area = one folded name on one brick, with every distributor that sells to it.
type Shop = { name: Name; grams: Map<string, number>; brick: string | null; rows: Row[] };
const shopsByArea = new Map<string, Map<string, Shop>>();
for (const m of mapRows) {
  if (!m.area_code || !m.customer_name) continue;
  const name = prepare(m.customer_name);
  if (!name.core.length) continue;
  const brick = (m.brick_id as string) ?? null;
  const area = shopsByArea.get(String(m.area_code)) ?? new Map<string, Shop>();
  shopsByArea.set(String(m.area_code), area);
  const groupKey = `${name.key}|${brick ?? ""}`;
  const shop = area.get(groupKey) ?? { name, grams: bigrams(name.core.join("")), brick, rows: [] };
  area.set(groupKey, shop);
  shop.rows.push(m);
}

// ---------- match ----------
type Link = { crm_customer_id: string; distributor_code: string; customer_code: string; match_band: string; name_score: number;
  crm_name: string; distributor_customer_name: string; area_code: string; source: string; linked_by_hr_id: string };
const links: Link[] = [];
const tally = { pharmacies: pharmacies.length, noArea: 0, exact: 0, strong: 0, sharedName: 0, weaker: 0 };
for (const p of pharmacies) {
  const area = seatArea.get(String(p.seat_id))?.area ?? null;
  const pool = area ? shopsByArea.get(area) : undefined;
  const crmName = String(p.name ?? "").replace(/\s*\/.{12,}$/s, "").trim() || String(p.name ?? "");
  const name = prepare(crmName);
  if (!area || !pool || !name.core.length) { tally.noArea++; continue; }
  const grams = bigrams(name.core.join(""));
  const scored: { shop: Shop; s: number }[] = [];
  for (const shop of pool.values()) {
    const s = score(name, grams, (p.pharmacy_pin_brick_id as string) ?? null, shop);
    if (s >= 0.5) scored.push({ shop, s });
  }
  scored.sort((a, b) => b.s - a.s);
  const top = scored[0];
  if (!top || top.s < 0.85) { tally.weaker++; continue; }
  // Several shops in the area fit the name equally well: the rep must say which one (owner, 13 Nov 2026).
  if (scored.some((x) => x !== top && x.s >= top.s - 0.02)) { tally.sharedName++; continue; }
  const band = top.s >= 1 ? "exact" : "strong";
  tally[band]++;
  for (const m of top.shop.rows) {
    links.push({
      crm_customer_id: String(p.id), distributor_code: String(m.distributor_code), customer_code: String(m.customer_code),
      match_band: band, name_score: Math.round(top.s * 100), crm_name: String(p.name ?? ""), distributor_customer_name: String(m.customer_name),
      area_code: area, source: SOURCE, linked_by_hr_id: actor ?? "",
    });
  }
}
const have = new Set(existing.map((e) => `${e.crm_customer_id}|${e.distributor_code}|${e.customer_code}`));
const fresh = links.filter((l) => !have.has(`${l.crm_customer_id}|${l.distributor_code}|${l.customer_code}`));
console.log({ ...tally, linkedPharmacies: tally.exact + tally.strong, linkRows: links.length, alreadySaved: links.length - fresh.length, toWrite: fresh.length });

if (!apply) {
  console.log("DRY RUN — nothing written. Add --apply --actor=<HR id> to save.");
  process.exit(0);
}
for (let i = 0; i < fresh.length; i += 500) {
  const { error } = await db.from("phoenix_crm_pharmacy_distributor_links").insert(fresh.slice(i, i + 500));
  if (error) throw error;
}
const { count, error } = await db.from("phoenix_crm_pharmacy_distributor_links").select("id", { count: "exact", head: true });
if (error) throw error;
console.log(`written ${fresh.length}; the table now holds ${count} rows`);
