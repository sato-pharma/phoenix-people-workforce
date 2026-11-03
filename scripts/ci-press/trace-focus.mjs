// The double-visit panel's database requests for one manager, grouped by table. Only reads: any write but an RPC is refused and named.
const realFetch = globalThis.fetch;
let trace = [];
let origin = performance.now();
const refused = [];
globalThis.fetch = async (input, init) => {
  const raw = typeof input === "string" ? input : input.url ?? String(input);
  const url = new URL(raw);
  const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
  const isRest = url.pathname.startsWith("/rest/v1/");
  const label = url.pathname.replace("/rest/v1/", "");
  if (!["GET", "HEAD"].includes(method) && isRest && !label.startsWith("rpc/")) {
    refused.push(`${method} ${label}`);
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }
  const start = performance.now();
  const res = await realFetch(input, init);
  const body = await res.clone().text().catch(() => "");
  let rows = null;
  try { const parsed = JSON.parse(body); if (Array.isArray(parsed)) rows = parsed.length; } catch { /* not a list */ }
  trace.push({ label, start: Math.round(start - origin), ms: Math.round(performance.now() - start), bytes: body.length, rows, lookup: /select=visit_date(&|$|%2C?)/.test(url.search) });
  return res;
};

const { createAccessContext, parseRoleStrict } = await import("@/lib/auth/permissions");
const { getDoubleVisitPortalFocus } = await import("@/lib/double-visit-analytics/service");

const hrId = process.argv[2] ?? "B-116";
const role = process.argv[3] ?? "District Manager";
const access = createAccessContext({ hrId, loginId: hrId, role: parseRoleStrict(role), source: "dev-header", testPersona: false });

for (const pass of ["first", "second"]) {
  trace = [];
  origin = performance.now();
  const focus = await getDoubleVisitPortalFocus(access);
  const total = Math.round(performance.now() - origin);
  const byLabel = new Map();
  for (const t of trace) {
    const key = t.lookup ? `${t.label} (day lookup)` : t.label;
    const entry = byLabel.get(key) ?? { requests: 0, bytes: 0, rows: 0, firstAt: t.start, lastEnd: 0, slowest: 0 };
    entry.requests += 1;
    entry.bytes += t.bytes;
    entry.rows += t.rows ?? 0;
    entry.lastEnd = Math.max(entry.lastEnd, t.start + t.ms);
    entry.slowest = Math.max(entry.slowest, t.ms);
    byLabel.set(key, entry);
  }
  console.log(`=== ${pass} pass ${hrId}: ${total} ms, ${trace.length} requests, ${Math.round(trace.reduce((s, t) => s + t.bytes, 0) / 1024)} KB`);
  for (const [key, e] of [...byLabel].sort((a, b) => a[1].firstAt - b[1].firstAt)) {
    console.log(`  ${key.padEnd(44)} ${String(e.requests).padStart(3)} req ${String(e.rows).padStart(6)} rows ${String(Math.round(e.bytes / 1024)).padStart(6)} KB  ${e.firstAt}-${e.lastEnd} ms  slowest ${e.slowest}`);
  }
  if (focus) console.log(`  answer: trend months ${focus.trend.length}, sum ${focus.trend.reduce((s, p) => s + p.count, 0)}, roster ${focus.scope?.rosterSize ?? 0}, covered ${focus.scope?.coveredCount ?? 0}, probation ${focus.probation.length}`);
}
console.log("refused writes:", refused.length ? [...new Set(refused)].join(" | ") : "none");
process.exit(0);
