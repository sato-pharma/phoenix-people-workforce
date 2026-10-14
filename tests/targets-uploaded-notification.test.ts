import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { TOKEN_REGISTRY } from "../src/lib/email-templates/token-registry.ts";
import type { ResolvedTargetRow } from "../src/lib/sales/monthly-targets.ts";
import {
  buildTargetTeams,
  managersAbove,
  periodEndDate,
  periodsLabel,
  pickAreaMapRow,
  resolveTeamRecipients,
  teamFingerprint,
  type TargetAreaMapRow,
  type TargetDirectory,
  type TargetPerson,
  type TargetSeat,
} from "../src/lib/sales/targets-uploaded-teams.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * A TARGETS UPLOAD TELLS EACH TEAM ITS TARGET IS ON PHOENIX, COPIED UP ITS CHAIN, WITH NO FIGURE.
 *
 * Owner, 2026-10-14: when the team targets are uploaded, every rep receives an email, with their
 * manager, their NSM and their RSM (where there is one) copied. Owner, 2026-10-15: it shows no
 * number — "your target for Oct, Nov, Dec 2026 is now on Phoenix".
 *
 * THREE THINGS CARRY THE FEATURE AND ALL OF THEM FAIL QUIETLY.
 *
 * 1. THE TEAM. Reps are grouped by the District Manager seat they report to. A grouping bug does
 *    not throw; it mails a rep in one region the targets of another, or splits one team into
 *    singletons so the table he was promised is a table of one. The fixture has two teams on one
 *    line and a Pedia chain with an RSM, and asserts who is in which.
 * 2. THE CHAIN. The Cc is the DM, then the RSM where one exists, then the NSM, resolved from the
 *    seat tree. CNS has no RSM seat at all, so "if applicable" is a real branch.
 * 3. THE TRIGGER. The email belongs to a COMMITTED upload only. The same route also answers a dry
 *    run, and the save route takes grid edits; mailing the team for either is a wrong email to the
 *    company with nothing red anywhere, so the call sites are pinned.
 */

const ROUTE_SOURCE = readFileSync(fileURLToPath(new URL("../app/api/sales/targets/upload/route.ts", import.meta.url)), "utf8");
const SAVE_ROUTE_SOURCE = readFileSync(fileURLToPath(new URL("../app/api/sales/targets/save/route.ts", import.meta.url)), "utf8");
const NOTIFIER_SOURCE = readFileSync(fileURLToPath(new URL("../src/lib/sales/targets-uploaded-notification.ts", import.meta.url)), "utf8");
const SERVICE_SOURCE = readFileSync(fileURLToPath(new URL("../src/lib/email-templates/service.ts", import.meta.url)), "utf8");
const RENDER_CORE_SOURCE = readFileSync(fileURLToPath(new URL("../src/lib/email-templates/render-core.ts", import.meta.url)), "utf8");

function code(source: string): string {
  return stripComments(source);
}

function seat(seatId: string, tier: string, parentSeatId: string | null, occupantHrId: string | null): TargetSeat {
  return { seatId, parentSeatId, tier, occupantHrId };
}

function person(hrId: string, name: string, email: string | null = `${name.toLowerCase().replace(/\s+/g, ".")}@satopharma.com`, active = true): TargetPerson {
  return { hrId, name, email, active };
}

function mapRow(lineCode: string, areaCode: string, areaName: string, dmSeatId: string | null, repSeatId: string | null, effectiveFrom: string | null = "2026-01-01", effectiveTo: string | null = null): TargetAreaMapRow {
  return { lineCode, areaCode, areaName, dmSeatId, repSeatId, effectiveFrom, effectiveTo };
}

function target(period: string, lineCode: string, areaCode: string, productCode: string, units: number | null, value: number | null): ResolvedTargetRow {
  return { period, line_code: lineCode, area_code: areaCode, product_code: productCode, target_units: units, target_value: value };
}

/**
 * CNS: NSM -> two DMs. Team A (Cairo DM) holds Omar and Esraa; team B (Alex DM) holds Mona.
 * Pedia: NSM -> RSM -> DM -> a rep, so the "if applicable" branch is exercised.
 * Giza has a rep seat with nobody in it.
 */
function fixture(): TargetDirectory {
  return {
    seats: [
      seat("CEO", "CEO", null, "B-1"),
      seat("NSM-CNS", "NSM", "CEO", "B-20"),
      seat("DM-CAIRO", "DM", "NSM-CNS", "B-30"),
      seat("DM-ALEX", "DM", "NSM-CNS", "B-31"),
      seat("REP-OMAR", "REP", "DM-CAIRO", "B-100"),
      seat("REP-ESRAA", "REP", "DM-CAIRO", "B-101"),
      seat("REP-GIZA", "REP", "DM-CAIRO", null),
      seat("REP-MONA", "REP", "DM-ALEX", "B-102"),
      seat("NSM-PEDIA", "NSM", "CEO", "B-21"),
      seat("RSM-PEDIA", "RSM", "NSM-PEDIA", "B-22"),
      seat("DM-PEDIA", "DM", "RSM-PEDIA", "B-32"),
      seat("REP-PEDIA", "REP", "DM-PEDIA", "B-103"),
    ],
    areaMap: [
      mapRow("cns", "ZZ1", "Nasr City", "DM-CAIRO", "REP-OMAR"),
      mapRow("cns", "ZZ2", "Heliopolis", "DM-CAIRO", "REP-ESRAA"),
      mapRow("cns", "ZZ3", "Giza", "DM-CAIRO", "REP-GIZA"),
      mapRow("cns", "ZZ4", "Alexandria", "DM-ALEX", "REP-MONA"),
      mapRow("pedia", "ZZ5", "Tanta", "DM-PEDIA", "REP-PEDIA"),
    ],
    people: [
      person("B-10", "Omar Anwar"),
      person("B-20", "Nadia Nsm"),
      person("B-21", "Nabil Nsm"),
      person("B-22", "Rania Rsm"),
      person("B-30", "Dina Dm"),
      person("B-31", "Dawood Dm"),
      person("B-32", "Dalia Dm"),
      person("B-100", "Omar"),
      person("B-101", "Esraa"),
      person("B-102", "Mona"),
      person("B-103", "Peter"),
    ],
    productNames: new Map([
      ["LA001", "Lacto Advanced"],
      ["TE001", "Tebofortin"],
    ]),
  };
}

export function runTargetsUploadedNotificationTests() {
  const directory = fixture();

  // ── 1. Teams: one per District Manager seat, and nobody sees another team's targets ──────────
  const october = [
    target("2026-10", "cns", "ZZ1", "LA001", 500, 50000),
    target("2026-10", "cns", "ZZ2", "LA001", 600, 60000),
    target("2026-10", "cns", "ZZ4", "LA001", 700, 70000),
    target("2026-10", "pedia", "ZZ5", "TE001", 80, 8000),
  ];
  const built = buildTargetTeams({ rows: october, directory });
  assert.equal(built.unplaced.length, 0);
  assert.equal(built.teams.length, 3, "two CNS teams (Cairo, Alex) and one Pedia team");

  const cairo = built.teams.find((team) => team.managerSeatId === "DM-CAIRO");
  assert.ok(cairo, "the Cairo team exists");
  assert.deepEqual(
    cairo.rows.map((row) => [row.repName, row.productName, row.units, row.value]),
    [
      ["Esraa", "Lacto Advanced", 600, 60000],
      ["Omar", "Lacto Advanced", 500, 50000],
    ],
    "his own example: Omar 500 Lacto and Esraa 600 Lacto are ONE team and ONE table",
  );
  const alex = built.teams.find((team) => team.managerSeatId === "DM-ALEX");
  assert.ok(alex);
  assert.deepEqual(alex.rows.map((row) => row.repName), ["Mona"]);
  assert.ok(
    !alex.rows.some((row) => row.repName === "Omar" || row.repName === "Esraa"),
    "a rep in another team is never shown the Cairo team's targets",
  );

  // ── 2. The chain: DM, then RSM where one exists, then NSM ────────────────────────────────────
  assert.deepEqual(cairo.managerHrIds, ["B-30", "B-20"], "CNS has no RSM seat: DM then NSM only");
  const pedia = built.teams.find((team) => team.lineCode === "pedia");
  assert.ok(pedia);
  assert.deepEqual(pedia.managerHrIds, ["B-32", "B-22", "B-21"], "Pedia: DM, RSM, NSM — the RSM is copied where the line has one");
  assert.deepEqual(
    managersAbove("DM-PEDIA", new Map(directory.seats.map((s) => [s.seatId, s] as const))).map((s) => s.tier),
    ["RSM", "NSM"],
  );
  const loop = new Map<string, TargetSeat>([["A", seat("A", "DM", "B", null)], ["B", seat("B", "DM", "A", null)]]);
  assert.deepEqual(managersAbove("A", loop), [], "a malformed parent loop terminates instead of hanging");

  // ── 3. Recipients: reps in To, the chain in Cc, the list the owner excluded honoured ─────────
  const recipients = resolveTeamRecipients(cairo, directory.people);
  assert.deepEqual(recipients.to.map((r) => r.name).sort(), ["Esraa", "Omar"]);
  assert.deepEqual(
    recipients.cc.map((r) => r.name),
    ["Dina Dm", "Nadia Nsm", "Omar Anwar"],
    "the chain is copied, and Omar Anwar (B-10) is named on every team's email (owner, 2026-10-14)",
  );
  assert.ok(!recipients.to.some((r) => recipients.cc.some((c) => c.hrId === r.hrId)), "nobody is both To and Cc");

  const inactive = resolveTeamRecipients(cairo, directory.people.map((p) => (p.hrId === "B-100" ? { ...p, active: false } : p)));
  assert.deepEqual(inactive.to.map((r) => r.name), ["Esraa"]);
  assert.ok(inactive.warnings.some((w) => /Omar is not active/.test(w)), "a skipped leaver is named in the warnings");
  const noEmail = resolveTeamRecipients(cairo, directory.people.map((p) => (p.hrId === "B-101" ? { ...p, email: null } : p)));
  assert.deepEqual(noEmail.to.map((r) => r.name), ["Omar"]);

  const excluded = resolveTeamRecipients(
    { ...cairo, repHrIds: ["B-156", "B-100"] },
    [...directory.people, person("B-156", "On Leave")],
  );
  assert.ok(!excluded.to.some((r) => r.hrId === "B-156"), "the shared sales exclusion list applies to a rep exactly as to a manager");

  const repsAllUnreachable = resolveTeamRecipients(
    cairo,
    directory.people.map((p) => (["B-100", "B-101"].includes(p.hrId) ? { ...p, email: null } : p)),
  );
  assert.deepEqual(
    repsAllUnreachable.to.map((r) => r.name),
    ["Dina Dm", "Nadia Nsm"],
    "a team whose reps have no address still reaches its managers, as the To",
  );
  assert.deepEqual(repsAllUnreachable.cc.map((r) => r.name), ["Omar Anwar"], "the named Cc survives the fallback");

  const pediaRecipients = resolveTeamRecipients(pedia, directory.people);
  assert.deepEqual(pediaRecipients.cc.map((r) => r.name), ["Dalia Dm", "Rania Rsm", "Nabil Nsm", "Omar Anwar"]);

  // ── 4. A vacant rep seat is shown, never mailed ──────────────────────────────────────────────
  const withVacant = buildTargetTeams({ rows: [target("2026-10", "cns", "ZZ3", "LA001", 400, 40000)], directory });
  assert.equal(withVacant.teams[0]!.rows[0]!.repName, "Vacant seat");
  assert.deepEqual(withVacant.teams[0]!.repHrIds, []);

  // ── 5. A row no organogram row names reaches nobody, and is counted ──────────────────────────
  const stray = buildTargetTeams({ rows: [target("2026-10", "cns", "NOPE", "LA001", 1, 1)], directory });
  assert.equal(stray.teams.length, 0);
  assert.equal(stray.unplaced.length, 1);

  // ── 6. The months are worded the way the owner wrote them, and a quarter is ONE email ───────
  const quarter = buildTargetTeams({
    rows: [
      target("2026-10", "cns", "ZZ1", "LA001", 500, 50000),
      target("2026-11", "cns", "ZZ1", "LA001", 510, 51000),
      target("2026-12", "cns", "ZZ1", "LA001", 520, 52000),
    ],
    directory,
  });
  assert.equal(quarter.teams.length, 1, "a quarter file is ONE email per team, never three");
  assert.deepEqual(quarter.teams[0]!.periods, ["2026-10", "2026-11", "2026-12"]);
  assert.equal(periodsLabel(quarter.teams[0]!.periods), "Oct, Nov, Dec 2026");
  assert.equal(periodsLabel(["2026-10"]), "Oct 2026");
  assert.equal(periodsLabel(["2026-12", "2026-11", "2027-01"]), "Nov, Dec 2026, Jan 2027", "a file crossing a year names each year once");
  assert.equal(periodsLabel(["2026-10", "2026-10"]), "Oct 2026", "a month named twice is said once");
  assert.equal(periodsLabel([]), "");

  // ── 7. The email shows NO figure — not a table, not a total (owner, 2026-10-15) ──────────────
  assert.ok(!SERVICE_SOURCE.includes("{{targetsTable}}"), "the template must carry no targets table");
  assert.ok(!TOKEN_REGISTRY.some((entry) => String(entry.token) === "targetsTable"), "the table token is gone");
  assert.ok(!/targetsTable/.test(RENDER_CORE_SOURCE), "the table's text projection is gone");
  const template = SERVICE_SOURCE.slice(SERVICE_SOURCE.indexOf("  targets_uploaded: {\n    bodyHtml"));
  const templateBlock = template.slice(0, template.indexOf("\n  },"));
  assert.ok(templateBlock.length > 100, "the targets_uploaded template default must be found");
  assert.match(templateBlock, /Your target for <strong>\{\{periodLabel\}\}<\/strong> is now on Phoenix Workforce\./);
  assert.ok(!/\{\{summary\}\}/.test(templateBlock), "no team total either");
  assert.ok(!/\d/.test(templateBlock), "the template wording holds no digit at all");

  // ── 8. The same file uploaded twice is one email; a changed number is a new one ──────────────
  const again = buildTargetTeams({ rows: october, directory }).teams.find((team) => team.managerSeatId === "DM-CAIRO")!;
  assert.equal(teamFingerprint(again), teamFingerprint(cairo));
  const changed = buildTargetTeams({ rows: [target("2026-10", "cns", "ZZ1", "LA001", 550, 55000), october[1]!], directory })
    .teams.find((team) => team.managerSeatId === "DM-CAIRO")!;
  assert.notEqual(teamFingerprint(changed), teamFingerprint(cairo));

  // ── 9. Which area-map row is in force ────────────────────────────────────────────────────────
  const moved = [
    mapRow("cns", "ZZ1", "Old", "DM-ALEX", "REP-MONA", "2026-01-01", "2026-10-01"),
    mapRow("cns", "ZZ1", "New", "DM-CAIRO", "REP-OMAR", "2026-10-01", null),
  ];
  assert.equal(pickAreaMapRow(moved, "2026-09")!.areaName, "Old", "a September target is routed to the seat that held the area in September");
  assert.equal(pickAreaMapRow(moved, "2026-10")!.areaName, "New");
  assert.equal(pickAreaMapRow(moved, "2027-03")!.areaName, "New", "a future month takes the open row");
  assert.equal(pickAreaMapRow([moved[0]!], "2027-03")!.areaName, "Old", "with no open row the only row is used rather than dropping the target");
  assert.equal(pickAreaMapRow([], "2026-10"), null);
  assert.equal(periodEndDate("2026-02"), "2026-02-28");
  assert.equal(periodEndDate("2028-02"), "2028-02-29");

  // ── 10. The trigger: a COMMITTED upload only ─────────────────────────────────────────────────
  const route = code(ROUTE_SOURCE);
  const commitStart = route.indexOf("await upsertMonthlyTargets");
  const previewReturn = route.indexOf('mode: "preview"');
  const notifyCall = route.indexOf("notifyTargetsUploaded(");
  assert.ok(commitStart > 0 && previewReturn > 0 && notifyCall > 0, "the upload route must call upsertMonthlyTargets and notifyTargetsUploaded");
  assert.ok(notifyCall > commitStart, "the email is sent AFTER the rows are stored, never before");
  assert.ok(notifyCall > previewReturn, "the dry-run branch returns before the notifier is reachable");
  assert.match(route, /if \(upserted > 0 && valid\.length > 0\)/, "nothing is mailed for an empty save");
  assert.ok(!code(SAVE_ROUTE_SOURCE).includes("notifyTargetsUploaded"), "an on-screen grid edit must not mail the team");
  assert.match(route, /notifyTargetsUploaded\(\{ rows: valid \}\)\.catch\(/, "best-effort: a failed email never fails a stored upload");

  // ── 11. The sender is template-driven, routed by us, and deduped ─────────────────────────────
  const notifier = code(NOTIFIER_SOURCE);
  assert.ok(!/renderPhoenixDataGrid|targetsTable|summary/.test(notifier), "the sender supplies no table, no total and no summary");
  assert.match(notifier, /subject = `\$\{line\} — your target for \$\{label\} is now on Phoenix`/, "the subject says what the owner asked and holds no figure");
  assert.match(notifier, /templateKey: "targets_uploaded"/);
  assert.match(notifier, /replaceRecipients: true/, "routing is decided by the organogram, not by recipient rules");
  assert.match(notifier, /idempotencyKey: `targets-uploaded:/);
  assert.ok(!/\bsendPhoenixEmail\s*\(/.test(notifier));

  // ── 12. The template is registered end to end ────────────────────────────────────────────────
  assert.match(SERVICE_SOURCE, /TARGETS_UPLOADED: "targets_uploaded"/);
  assert.ok(!/targetsTable/.test(SERVICE_SOURCE), "no table context field is left in the template service");
}
