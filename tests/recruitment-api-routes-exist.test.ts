import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Every `/api/recruitment/...` this module calls must have a route behind it.
 *
 * ── THE BUG THAT MADE THIS ──────────────────────────────────────────────────────────────────────
 *
 * The requisition screen carried an "Application link" button that returned 404 on every press, on a
 * live screen, with four open requisitions on file.
 *
 * It was not a feature nobody finished. `670adc127` ("Phase 4a public application funnel") added the
 * button AND `POST /api/recruitment/requisitions/[id]/posting` AND the `recruitment_job_postings`
 * table. `f8ea71fc9` ("re-platform onto ats_ tables") deleted the route and the table — the whole
 * `recruitment_` generation moved to `ats_` — and left the button behind, pointing at nothing.
 *
 * Nothing caught it. A deleted route breaks no import, fails no type check and reads no differently
 * from a route in another folder; the only symptom is a 404 a recruiter sees and an engineer does
 * not. It sat there through every CI run since.
 *
 * ── WHY A SWEEP AND NOT A PIN ───────────────────────────────────────────────────────────────────
 *
 * Pinning that one button stays absent would guard the instance and miss the class. The failure is
 * "a route was removed and its caller was not", and the next re-platform can produce it again in a
 * different folder. This walks every call in the module and asks the route tree, so it catches the
 * next one without anybody thinking to look. When it was written there were 42 distinct calls and
 * exactly one orphan.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────────────────────────
 *
 * It does not check the METHOD. A route file that exports only GET still satisfies a POST here, and
 * proving otherwise would mean parsing exports and matching them to call sites — much more machinery
 * for a much rarer mistake. A missing FILE is the failure that actually happened, twice removed from
 * anybody noticing, and that is what this answers.
 */
export function runRecruitmentApiRoutesExistTests() {
  const sourceFilesUnder = (root: string) => {
    const found: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".next") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry)) found.push(full);
      }
    };
    walk(root);
    return found;
  };

  /**
   * Does a route file exist for this path?
   *
   * An interpolated segment (`${requisition.id}`) is matched against whatever `[param]` folder sits
   * at that level, because that is exactly what Next.js does. A literal segment must match a real
   * folder — and falls back to the dynamic one, since `/api/x/abc` is legitimately served by
   * `app/api/x/[id]/route.ts`.
   */
  const routeExists = (apiPath: string): boolean => {
    const segments = apiPath.replace(/^\/api\//, "").split("/").filter(Boolean);
    let dir = join("app", "api");
    for (const segment of segments) {
      if (!existsSync(dir)) return false;
      const dynamic = readdirSync(dir).filter(
        (entry) => entry.startsWith("[") && statSync(join(dir, entry)).isDirectory(),
      );
      const literal = segment.includes("${") ? null : join(dir, segment);
      const next =
        literal && existsSync(literal) ? literal : dynamic.length > 0 ? join(dir, dynamic[0]) : null;
      if (!next) return false;
      dir = next;
    }
    return existsSync(join(dir, "route.ts")) || existsSync(join(dir, "route.tsx"));
  };

  // The interview calendar's screens call through `calendarApi()` (it carries a copy link's token on
  // every request), which puts ONE base in front of a short path: `api.get("/bookings")`. So the base
  // is a prefix, not a call — and each short path is a call, checked here like any other.
  const calendarHelper = join("src", "components", "recruitment", "interview-calendar", "calendar-api.ts");
  const calendarBase = /export const INTERVIEW_CALENDAR_API = "(\/api\/recruitment\/[^"]+)";/.exec(readFileSync(calendarHelper, "utf8"))?.[1];
  assert.ok(calendarBase, `${calendarHelper} no longer declares INTERVIEW_CALENDAR_API, so the calendar's calls went unchecked`);
  let calendarCalls = 0;

  const calls = new Map<string, string>();
  for (const file of [
    ...sourceFilesUnder(join("src", "components", "recruitment")),
    ...sourceFilesUnder(join("src", "lib", "recruitment")),
  ]) {
    const text = readFileSync(file, "utf8");
    const where = file.split(sep).join("/");
    // Every interpolation collapses to one placeholder, so `${a.b}` and `${c}` are the same shape.
    const record = (raw: string) => {
      const path = raw.replace(/\$\{[^}]*\}/g, "${}");
      if (!calls.has(path)) calls.set(path, where);
    };
    for (const match of text.matchAll(/["'`](\/api\/recruitment\/[^"'`\s?]+)/g)) {
      if (file === calendarHelper && match[1] === calendarBase) continue;
      record(match[1]);
    }
    for (const match of text.matchAll(/\bapi\.(?:get|post|postForm|patch|del|href|fetch)\(\s*["'`](\/[^"'`\s?]+)/g)) {
      calendarCalls += 1;
      record(`${calendarBase}${match[1]}`);
    }
  }
  assert.ok(calendarCalls >= 10, `only ${calendarCalls} interview-calendar calls were found; the scan has stopped seeing them`);

  // A POSITIVE CONTROL. If the scan ever finds nothing — a moved folder, a changed call style — every
  // assertion below passes vacuously and the guard silently stops guarding.
  assert.ok(
    calls.size >= 20,
    `only ${calls.size} /api/recruitment calls were found; the scan has stopped seeing this module ` +
      "and would pass no matter how many routes were missing",
  );

  const orphans = [...calls.entries()]
    .filter(([path]) => !routeExists(path))
    .map(([path, file]) => `${path}   called from ${file}`)
    .sort();

  assert.deepEqual(
    orphans,
    [],
    "these calls have no route file behind them, so every press returns 404 — the symptom a recruiter " +
      `sees and an engineer does not:\n${orphans.join("\n")}`,
  );

  // And the specific one this file was written for stays gone. Its route and table were both deleted
  // in the ats_ re-platform, and the capability lives on as tracked WhatsApp/email adverts instead —
  // so a rebuild would resurrect a design that was deliberately retired.
  const workspace = readFileSync(join("src", "components", "recruitment", "recruitment-workspace.tsx"), "utf8");
  assert.doesNotMatch(
    workspace,
    /requisitions\/\$\{[^}]*\}\/posting/,
    "the Application link button must not come back without its route — applications now arrive " +
      "through buildApplyLink and the PX- channel codes, not a hosted application page",
  );
}
