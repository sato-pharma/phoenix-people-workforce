// Portal home open times on production, one Cairo morning, read from Railway's HTTP rows.
// Usage: node measure.mjs 2026-11-07 [2026-11-04@08:30 ...]   (run from the Phoenix primary folder; @HH:MM moves the Cairo start)
// An open is a GET of /employee-portals that sent 30,000 bytes or more (Railway's path has no query string,
// so an RSC fetch cannot be told apart by path). Window 08:00-10:48 Cairo, cut at the first release inside it.
import { execFileSync } from "node:child_process";

const RAILWAY = "C:/Users/satoh/AppData/Roaming/npm/node_modules/@railway/cli/bin/railway.exe";
const SCOPE = ["-p", "Phoenix-HR-Workforce", "-e", "production"];
const CAIRO_OFFSET_H = 2; // Egypt has no summer time in November.
const SLICE_MIN = 20;
const MAX_ROWS = 5000;

const railway = (args) =>
  execFileSync(RAILWAY, [...args, ...SCOPE], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 120_000 });
const cairo = (ms) =>
  new Date(ms).toLocaleString("en-GB", { timeZone: "Africa/Cairo", weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);
const median = (sorted) => {
  if (!sorted.length) return null;
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};
const s = (ms) => (ms == null ? "n/a" : (ms / 1000).toFixed(2) + " s");

const deployments = JSON.parse(railway(["deployment", "list", "-s", "phoenix-people-workforce", "--json", "--limit", "300"]))
  .map((d) => ({ id: d.id, status: d.status, at: Date.parse(d.createdAt), commit: (d.meta?.commitHash || "").slice(0, 9) }))
  .filter((d) => !["FAILED", "CRASHED", "SKIPPED"].includes(d.status))
  .sort((a, b) => a.at - b.at);

for (const arg of process.argv.slice(2)) {
  const [day, from = "08:00"] = arg.split("@");
  const [hh, mm] = from.split(":").map(Number);
  const start = Date.parse(`${day}T${String(hh - CAIRO_OFFSET_H).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);
  let end = Date.parse(`${day}T${String(10 - CAIRO_OFFSET_H).padStart(2, "0")}:48:00Z`);
  const serving = deployments.filter((d) => d.at <= start).at(-1);
  const release = deployments.find((d) => d.at > start && d.at < end);
  if (release) end = release.at;
  if (!serving) {
    console.log(`${day}: no release found serving at 08:00 Cairo, NOT measured`);
    continue;
  }

  const rows = [];
  let capped = false;
  for (let t = start; t < end; t += SLICE_MIN * 60_000) {
    const until = Math.min(end, t + SLICE_MIN * 60_000);
    const out = railway(["logs", "-s", "phoenix-people-workforce", "--http", "--json", "--since", new Date(t).toISOString(), "--until", new Date(until).toISOString(), "-n", String(MAX_ROWS), serving.id]);
    const slice = out.split(/\r?\n/).filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    if (slice.length >= MAX_ROWS) capped = true;
    rows.push(...slice.filter((r) => { const at = Date.parse(r.timestamp); return at >= start && at < end; }));
  }

  const status = (r) => Number(r.httpStatus ?? r.status);
  const ms = (r) => Number(r.totalDuration);
  const opens = rows.filter((r) => r.method === "GET" && r.path === "/employee-portals" && Number(r.txBytes) >= 30_000);
  const times = opens.map(ms).filter(Number.isFinite).sort((a, b) => a - b);
  const control = (path) => median(rows.filter((r) => r.path === path && status(r) < 500).map(ms).filter(Number.isFinite).sort((a, b) => a - b));
  const over3 = times.filter((t) => t > 3000).length;

  console.log(
    `${day} (${cairo(start)} to ${cairo(end)}${release ? `, cut at release ${release.commit}` : ""}; release ${serving.commit})\n` +
      `  opens ${times.length} | median ${s(median(times))} | slowest tenth ${s(pct(times, 90))} | over 3 s ${times.length ? Math.round((100 * over3) / times.length) : 0}% | worst ${s(times.at(-1))} | 5xx on the home ${opens.filter((r) => status(r) >= 500).length}\n` +
      `  control: sign-in pulse median ${control("/api/auth/pulse")} ms, visits read median ${control("/api/phoenix-crm/visits")} ms, all rows ${rows.length}, all 5xx ${rows.filter((r) => status(r) >= 500).length}` +
      (capped ? "\n  WARNING: a 20-minute slice hit the 5,000-row cap, so rows are missing" : ""),
  );
}
