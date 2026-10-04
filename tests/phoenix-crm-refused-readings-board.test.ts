import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  attemptOutcome,
  refusalSentence,
  refusedSubjectLabel,
  stillBlocked,
  summariseByRep,
  widestReading,
  type LaterSave,
  type RefusedAttempt,
} from "../src/lib/phoenix-crm/refused-readings-rules.ts";
import {
  canReadRefusedReadings,
  loadRefusedReadingsBoard,
  readsMockAnswer,
} from "../src/lib/phoenix-crm/server/refused-readings-board.ts";
import type { PhoenixCrmViewer } from "../src/lib/phoenix-crm/server/access.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The refused-readings board (owner, 2026-10-03: "build the refused readings view for the SFE").
//
// `phoenix_crm_refused_readings` went live that evening and caught its first real case within half an
// hour — nine refusals in 67 seconds from one rep — but nothing could READ it except SQL, so the people
// who could help a stuck rep would never have seen it. This board is that reader.
//
// What it must hold to:
//   · THE SFE MANAGER AND THE SUPER ADMIN, AND NOBODY ELSE — the integrity board's audience, enforced
//     in the service (a 404, never a 403 that names it) AND on the page, behind gate one.
//   · THE MOCK-LOCATION ANSWER IS THE SUPER ADMIN'S ALONE, and not by filtering: the column is only
//     ever NAMED in the select for him, so the SFE Manager's process never holds it.
//   · HOUSEKEEPING, NOT A FLAG — it files under no accusation and carries no verdict wording.
//   · A "got through afterwards" that is STRICT: a save before the refusal proves nothing about it.
//   · FITS THE SCREEN — a fixed-layout table on desktop, cards on a phone, never a horizontal scroll.
// ─────────────────────────────────────────────────────────────────────────────

const REP = "B-158";
const OTHER = "B-300";
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const OTHER_CUSTOMER = "22222222-2222-4222-8222-222222222222";

function attempt(overrides: Partial<RefusedAttempt> & { id: string }): RefusedAttempt {
  return {
    subjectKind: "place",
    reason: "rough",
    repHrId: REP,
    customerId: CUSTOMER,
    refusedAt: "2026-10-03T18:30:29.000Z",
    accuracyMeters: 47,
    photoAccuracyMeters: 220,
    maxAccuracyMeters: 100,
    ...overrides,
  };
}

function save(overrides: Partial<LaterSave> = {}): LaterSave {
  return { subjectKind: "place", repHrId: REP, customerId: CUSTOMER, savedAt: "2026-10-03T18:45:00.000Z", ...overrides };
}

function viewer(flags: { superAdmin?: boolean; sfe?: boolean }): PhoenixCrmViewer {
  return { isSuperAdmin: flags.superAdmin === true, isSfeManager: flags.sfe === true } as unknown as PhoenixCrmViewer;
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) found.push(full.split(path.sep).join("/"));
  }
  return found;
}

export async function runPhoenixCrmRefusedReadingsBoardTests(): Promise<void> {
  // ── 1 · The sentence the SFE reads ──────────────────────────────────────────────────────────────
  {
    const place = refusalSentence({ subjectKind: "place", reason: "rough", accuracyMeters: 47, photoAccuracyMeters: 220, maxAccuracyMeters: 250 });
    assert.match(place, /pin read within 47 m/, "a place names the pin's reading");
    assert.match(place, /photo within 220 m/, "and the photo's, because the two can differ by an order of magnitude");
    assert.match(place, /both within 250 m/, "and the line it had to be inside — the one stored with the row");

    const visit = refusalSentence({ subjectKind: "visit", reason: "rough", accuracyMeters: 900, photoAccuracyMeters: null, maxAccuracyMeters: 500 });
    assert.match(visit, /within 900 m/, "a visit names its one reading");
    assert.match(visit, /within 500 m/, "and its own line");
    assert.doesNotMatch(visit, /photo/, "a visit has no photo reading to name");

    const blank = refusalSentence({ subjectKind: "place", reason: "rough", accuracyMeters: null, photoAccuracyMeters: null, maxAccuracyMeters: null });
    assert.match(blank, /not reported/, "a reading the phone never sent reads 'not reported'");
    assert.doesNotMatch(blank, /\b0 m\b/, "and is NEVER 0 m, which is a rep standing exactly on the pin");
    assert.doesNotMatch(blank, /needs/, "a refusal stored with no line says nothing about one");

    assert.match(refusalSentence({ subjectKind: "visit", reason: "no_fix", accuracyMeters: null, photoAccuracyMeters: null, maxAccuracyMeters: null }), /no usable position at all/, "no fix is its own sentence");

    assert.equal(widestReading({ accuracyMeters: 47, photoAccuracyMeters: 220 }), 220, "the widest of the two readings");
    assert.equal(widestReading({ accuracyMeters: null, photoAccuracyMeters: null }), null, "and none when none was reported");
    assert.equal(refusedSubjectLabel("place"), "Validating a place");
    assert.equal(refusedSubjectLabel("visit"), "Saving a visit");
  }

  // ── 2 · "Got through afterwards" is strict ──────────────────────────────────────────────────────
  {
    const refused = attempt({ id: "a" });
    assert.equal(attemptOutcome(refused, [save()]), "got_through", "a later save of the same kind, by the same rep, for the same customer");
    assert.equal(attemptOutcome(refused, [save({ savedAt: "2026-10-03T18:00:00.000Z" })]), "not_yet", "a save BEFORE the refusal proves nothing about it");
    assert.equal(attemptOutcome(refused, [save({ savedAt: refused.refusedAt })]), "got_through", "a save at the very same instant counts");
    assert.equal(attemptOutcome(refused, [save({ repHrId: OTHER })]), "not_yet", "another rep's save is not his");
    assert.equal(attemptOutcome(refused, [save({ customerId: OTHER_CUSTOMER })]), "not_yet", "another customer's save is not this one");
    assert.equal(attemptOutcome(refused, [save({ subjectKind: "visit" })]), "not_yet", "a visit saved is not the place that was refused");
    assert.equal(attemptOutcome(refused, [save({ repHrId: REP.toLowerCase() })]), "got_through", "HR ids are mixed case, so both sides compare upper-cased");
    assert.equal(attemptOutcome(refused, []), "not_yet", "no later save at all");
    assert.equal(attemptOutcome(attempt({ id: "b", customerId: null }), [save()]), "unknown", "a refusal tied to no customer cannot be matched, and says so");
  }

  // ── 3 · One line per rep, the blocked ones first ────────────────────────────────────────────────
  {
    // The real shape of 3 October: nine retries, the same photo, never through.
    const nine = Array.from({ length: 9 }, (_, index) =>
      attempt({ id: `n${index}`, refusedAt: `2026-10-03T18:30:${String(29 + index).padStart(2, "0")}.000Z` }),
    );
    // Another rep refused twice and through on the third.
    const through = [
      attempt({ id: "t1", repHrId: OTHER, customerId: OTHER_CUSTOMER, refusedAt: "2026-10-03T10:00:00.000Z" }),
      attempt({ id: "t2", repHrId: OTHER, customerId: OTHER_CUSTOMER, refusedAt: "2026-10-03T10:01:00.000Z" }),
    ];
    const reps = summariseByRep([...through, ...nine], [save({ repHrId: OTHER, customerId: OTHER_CUSTOMER, savedAt: "2026-10-03T10:05:00.000Z" })]);
    assert.deepEqual(reps.map((entry) => entry.repHrId), [REP, OTHER], "the rep who cannot work comes before the one who got through, though the other has fewer tries");

    const stuck = reps[0]!;
    assert.equal(stuck.attempts, 9, "nine refusals");
    assert.equal(stuck.targets, 1, "on ONE customer — nine attempts are not nine customers");
    assert.equal(stuck.gotThrough, 0);
    assert.equal(stillBlocked(stuck), 1, "so one is still blocked");
    assert.equal(stuck.widestMeters, 220, "his roughest reading is the photo's, not the pin's");
    assert.equal(stuck.places, 9);
    assert.equal(stuck.visits, 0);

    const done = reps[1]!;
    assert.equal(done.gotThrough, 1);
    assert.equal(stillBlocked(done), 0, "got through, so nothing is blocked — but he is still listed");
    assert.equal(done.attempts, 2);

    // Refused, saved, refused again: through. A later refusal must not un-do a save that landed.
    const again = summariseByRep(
      [
        attempt({ id: "x1", refusedAt: "2026-10-03T10:00:00.000Z" }),
        attempt({ id: "x2", refusedAt: "2026-10-03T12:00:00.000Z" }),
      ],
      [save({ savedAt: "2026-10-03T11:00:00.000Z" })],
    );
    assert.equal(stillBlocked(again[0]!), 0, "a target that saved after one refusal is through, not stuck on the later one");

    // A refusal before any customer was chosen is counted apart — neither stuck nor through.
    const untied = summariseByRep([attempt({ id: "u1", customerId: null }), attempt({ id: "u2", customerId: null })], [])[0]!;
    assert.equal(untied.untied, 2);
    assert.equal(untied.targets, 0, "no customer, so no target to be blocked on");
    assert.equal(stillBlocked(untied), 0, "and never reported as blocked on a guess");

    const noFix = summariseByRep([attempt({ id: "f1", reason: "no_fix", accuracyMeters: null, photoAccuracyMeters: null })], [])[0]!;
    assert.equal(noFix.noFix, 1, "no position at all is counted apart from a rough one");
    assert.equal(noFix.widestMeters, null, "and has no roughest reading to quote");
  }

  // ── 4 · The audience, in the service ────────────────────────────────────────────────────────────
  {
    assert.equal(canReadRefusedReadings(viewer({ superAdmin: true })), true);
    assert.equal(canReadRefusedReadings(viewer({ sfe: true })), true);
    assert.equal(canReadRefusedReadings(viewer({})), false, "a district manager, a rep, anybody else");
    assert.equal(readsMockAnswer(viewer({ superAdmin: true })), true);
    assert.equal(readsMockAnswer(viewer({ sfe: true })), false, "the mock-location answer is the Super Admin's alone");

    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      throw new Error("phoenix-crm-refused-readings-board: no request may leave this test");
    }) as typeof fetch;
    try {
      await assert.rejects(
        () => loadRefusedReadingsBoard(viewer({})),
        (error: unknown) => (error as { status?: number }).status === 404,
        "anybody outside the audience is refused with a 404 — a 403 that names the board IS the disclosure",
      );
      assert.equal(requests, 0, "and refused before the database is asked anything");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // ── 5 · The mock answer is never QUERIED for the SFE, and the reader never writes ───────────────
  {
    const board = stripComments(read("src/lib/phoenix-crm/server/refused-readings-board.ts"));
    assert.ok(
      board.includes('${mock ? ", device_mocked" : ""}'),
      "device_mocked is named in the select ONLY under the Super Admin's flag — for anyone else it is never asked of the database",
    );
    assert.equal((board.match(/device_mocked/g) ?? []).length, 3, "and appears nowhere else in the service but that select and its read-back");
    assert.ok(board.includes("if (mock) {"), "the read-back is behind the same flag");
    assert.doesNotMatch(board, /\.(?:insert|upsert|update|delete)\(/, "a reader: nothing here writes, replaces or removes a refusal");
    assert.ok(board.includes('.eq("is_test", false)'), "the Super Admin's own trial entries are never on the worklist");
    assert.ok(board.includes("notFoundError"), "refuses with a 404");
    assert.doesNotMatch(board, /forbiddenError/, "never a 403");
    const loader = board.slice(board.indexOf("export async function loadRefusedReadingsBoard("));
    assert.ok(
      loader.indexOf("canReadRefusedReadings(viewer)") !== -1 && loader.indexOf("canReadRefusedReadings(viewer)") < loader.indexOf("getSupabaseAdmin()"),
      "the audience is checked before the loader builds a database client",
    );
  }

  // ── 6 · Only the recorder and this reader name the table ────────────────────────────────────────
  {
    const namers: string[] = [];
    for (const dir of ["src", "app"]) {
      for (const file of walk(dir)) {
        if (stripComments(read(file)).includes("phoenix_crm_refused_readings")) namers.push(file);
      }
    }
    assert.deepEqual(
      namers.sort(),
      ["src/lib/phoenix-crm/server/refused-readings-board.ts", "src/lib/phoenix-crm/server/refused-readings.ts"],
      "the recorder writes it and the board reads it — no rep-facing screen, payload or report names it",
    );
    // And nothing a rep's bundle imports reaches the board.
    const importers: string[] = [];
    for (const file of walk("src")) {
      if (/refused-readings-board/.test(stripComments(read(file))) && !file.endsWith("server/refused-readings-board.ts")) importers.push(file);
    }
    assert.deepEqual(importers, [], "no file in src imports the board — only its own admin page does");
  }

  // ── 7 · The page: gate one, the audience, and the shape ─────────────────────────────────────────
  {
    const page = read("app/(admin)/admin/phoenix-crm/refused-readings/page.tsx");
    const code = stripComments(page);
    const gate = code.indexOf('canAccess(access, "phoenix_crm", "read")');
    assert.ok(gate !== -1 && gate < code.indexOf("resolvePhoenixCrmViewer("), "gate one — the per-account module lock — comes before the organogram");
    assert.ok(code.includes("canReadRefusedReadings(viewer)"), "the page keeps the same predicate as the service");
    assert.ok(code.includes("redirect("), "a redirect, never a message that explains the page");
    assert.ok(code.includes("readsMockAnswer(viewer)"), "the mock-location line is drawn only on the strength of the service's own predicate");
    assert.doesNotMatch(code, /<(?:button|form|input)\b|onClick|fetch\(|"use server"/, "nothing on this page acts");

    assert.equal((code.match(/table-fixed/g) ?? []).length, 2, "both tables are fixed-layout");
    assert.equal((code.match(/<colgroup>/g) ?? []).length, 2, "each with its colgroup");
    assert.equal((code.match(/hidden lg:block/g) ?? []).length, 2, "each desktop table is hidden on a phone");
    assert.equal((code.match(/lg:hidden/g) ?? []).length, 2, "and each has its phone cards beside it");
    assert.doesNotMatch(code, /overflow-x|min-w-\[|rounded/, "no horizontal scroll, no fixed floor, and square edges");
    assert.equal((code.match(/<Readings entry=\{entry\} showMock=\{showMock\} \/>/g) ?? []).length, 2, "the refusal's facts come from one component, so the table and the card cannot print different ones");
    assert.equal((code.match(/<RepSummary entry=\{entry\} \/>/g) ?? []).length, 2, "and so does a rep's line");
    assert.match(code, /Africa\/Cairo/, "times are Cairo local");
    assert.doesNotMatch(page, /…|\.\.\.\s*<|\.\.\.["`]/, "no text is cut with an ellipsis");

    // Housekeeping, never an accusation: the words that belong to the integrity board are not used here.
    assert.doesNotMatch(code, /\b(?:violation|fraud|cheat|caught|suspicio|fake|spoof)/i, "a refusal is the system saying no to a phone, not a finding about a person");
  }

  // ── 8 · The card, and its band ──────────────────────────────────────────────────────────────────
  {
    const navigation = read("src/config/system-navigation.ts");
    const at = navigation.indexOf('href: "/admin/phoenix-crm/refused-readings"');
    assert.ok(at !== -1, "the navigation draws a card for the board");
    const card = navigation.slice(at, navigation.indexOf("\n  },", at));
    assert.match(card, /roles: \["Super Admin", "SFE Manager"\]/, "for exactly the two readers");
    assert.match(card, /permissions: \[\{ resource: "phoenix_crm", action: "read" \}\]/, "behind the module's read permission");
    assert.match(card, /icon: MapPinOff/);
    assert.ok(
      navigation.includes('          "/admin/phoenix-crm/refused-readings",'),
      "and it is in the CRM Data Quality band, or it would be appended to the first band under a heading nobody chose",
    );
  }
}
