import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  attemptOutcome,
  parseBlockedPermission,
  parseRefusedReason,
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
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

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
    blockedPermission: null,
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
    const place = refusalSentence({ subjectKind: "place", reason: "rough", accuracyMeters: 47, photoAccuracyMeters: 220, maxAccuracyMeters: 250, blockedPermission: null });
    assert.match(place, /pin read within 47 m/, "a place names the pin's reading");
    assert.match(place, /photo within 220 m/, "and the photo's, because the two can differ by an order of magnitude");
    assert.match(place, /both within 250 m/, "and the line it had to be inside — the one stored with the row");

    const visit = refusalSentence({ subjectKind: "visit", reason: "rough", accuracyMeters: 900, photoAccuracyMeters: null, maxAccuracyMeters: 500, blockedPermission: null });
    assert.match(visit, /within 900 m/, "a visit names its one reading");
    assert.match(visit, /within 500 m/, "and its own line");
    assert.doesNotMatch(visit, /photo/, "a visit has no photo reading to name");

    const blank = refusalSentence({ subjectKind: "place", reason: "rough", accuracyMeters: null, photoAccuracyMeters: null, maxAccuracyMeters: null, blockedPermission: null });
    assert.match(blank, /not reported/, "a reading the phone never sent reads 'not reported'");
    assert.doesNotMatch(blank, /\b0 m\b/, "and is NEVER 0 m, which is a rep standing exactly on the pin");
    assert.doesNotMatch(blank, /needs/, "a refusal stored with no line says nothing about one");

    assert.match(refusalSentence({ subjectKind: "visit", reason: "no_fix", accuracyMeters: null, photoAccuracyMeters: null, maxAccuracyMeters: null, blockedPermission: null }), /no usable position at all/, "no fix is its own sentence");

    // off_listing is NOT a position problem: both readings were precise, and the ACCOUNT is what did
    // not match (google-place-rules.ts). Printing an accuracy radius here would read as a phone fault.
    const offListing = refusalSentence({ subjectKind: "place", reason: "off_listing", accuracyMeters: 11, photoAccuracyMeters: 14, maxAccuracyMeters: 250, blockedPermission: null });
    assert.match(offListing, /Google Maps pin/, "it names the pin the save was measured against");
    assert.match(offListing, /moved/, "and says the account may have moved, which is the usual reason");
    assert.doesNotMatch(offListing, /\b11 m\b|\b14 m\b|too rough/, "never the accuracy radius, and never 'too rough'");
    assert.match(offListing, /second refusal[\s\S]*Super Admin/, "and it says what happens next, so the SFE knows it is not a dead end");

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
    // Phoenix CRM performance audit, 2026-10-16: the fifty-id chunks are read a few at a time, and
    // read BACK in chunk order with the same two failure rules — a failed customer chunk stops the
    // names there, a failed saves chunk is skipped — so the board prints what it printed before.
    assert.equal(
      (board.match(/mapWithConcurrency\(chunkStarts\([a-zA-Z]+\.length\), CHUNK_READS_AT_ONCE,/g) ?? []).length,
      2,
      "both chunked reads — the customers' names and the later saves — go a few at a time",
    );
    assert.ok(board.includes("if (customerError) break;"), "a failed name chunk still ends the names there, as the one-at-a-time walk did");
    assert.ok(board.includes("if (visits.error || places.error) continue;"), "and a failed saves chunk is still skipped, never fatal");
    assert.match(
      loader,
      /await Promise\.all\(\[\s*mapWithConcurrency\(chunkStarts\(customerIds\.length\)[\s\S]*?loadPeopleNames\([\s\S]*?loadLaterSaves\(attempts\),\s*\]\)/,
      "the customers' names, the reps' names and the later saves are asked at once — none waits for another",
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

  // ── 9 · The photo the phone sent (owner, 2026-10-04: "show the refused photo on the refused-readings page") ──
  {
    const GOOD = "SEAT-CNS-REP-D11/2026/10/place/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg";
    const VISIT = "SEAT-CNS-REP-D11/2026/10/visit/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg";
    const rows = [
      { id: "r1", subject_kind: "place", reason: "rough", rep_hr_id: REP, customer_id: CUSTOMER, refused_at: "2026-10-03T18:31:37.000Z", photo_path: GOOD },
      { id: "r2", subject_kind: "visit", reason: "rough", rep_hr_id: REP, customer_id: CUSTOMER, refused_at: "2026-10-03T18:31:00.000Z", photo_path: VISIT },
      // A row from before 3 October: no pointer was kept.
      { id: "r3", subject_kind: "place", reason: "rough", rep_hr_id: REP, customer_id: CUSTOMER, refused_at: "2026-10-03T18:30:00.000Z", photo_path: null },
      // Never a thing the board should hand to a signer: a test photo, and anything that is not a slot.
      { id: "r4", subject_kind: "place", reason: "rough", rep_hr_id: REP, customer_id: CUSTOMER, refused_at: "2026-10-03T18:29:00.000Z", photo_path: `test/${GOOD}` },
      { id: "r5", subject_kind: "place", reason: "rough", rep_hr_id: REP, customer_id: CUSTOMER, refused_at: "2026-10-03T18:28:00.000Z", photo_path: "../../etc/passwd" },
      { id: "r6", subject_kind: "place", reason: "rough", rep_hr_id: REP, customer_id: CUSTOMER, refused_at: "2026-10-03T18:27:00.000Z", photo_path: "" },
    ];

    async function load(who: PhoenixCrmViewer) {
      const original = globalThis.fetch;
      // The admin client is built from these, and the suite may run with the real ones in its
      // environment — so a sentinel pair stands in, and the stub below answers every request: nothing
      // here can reach a database. Same pair `vacancy-close-manager-hr-id-canonical.test.ts` uses.
      const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
      const selects: string[] = [];
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        const table = url.pathname.split("/").pop() ?? "";
        if (table === "phoenix_crm_refused_readings") {
          selects.push(url.searchParams.get("select") ?? "");
          return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (table === "employees") {
          return new Response(JSON.stringify([{ hr_id: REP, full_name: "Test Rep", nickname: null }]), { status: 200, headers: { "content-type": "application/json" } });
        }
        // Customers, later visits, later places: nothing came of it, which is all this section needs.
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      try {
        return { board: await loadRefusedReadingsBoard(who), selects };
      } finally {
        globalThis.fetch = original;
        if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
        else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
        if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
      }
    }

    const sfe = await load(viewer({ sfe: true }));
    const byId = new Map(sfe.board.latest.map((entry) => [entry.id, entry.photoPath]));
    assert.equal(byId.get("r1"), GOOD, "a place refusal carries the pointer to the photo the phone sent");
    assert.equal(byId.get("r2"), VISIT, "so does a visit refusal");
    assert.equal(byId.get("r3"), null, "a row that kept no pointer has no photo, and says so rather than guessing one");
    assert.equal(byId.get("r4"), null, "a test photo is never handed to the signer from this board");
    assert.equal(byId.get("r5"), null, "and a stored value that is not the shape of a slot is no photo at all");
    assert.equal(byId.get("r6"), null, "an empty string is none either");
    assert.match(sfe.selects[0] ?? "", /\bphoto_path\b/, "the photo pointer is asked of the database for the SFE Manager");
    assert.doesNotMatch(sfe.selects[0] ?? "", /device_mocked/, "while the mock-location answer still is not");

    const owner = await load(viewer({ superAdmin: true }));
    assert.match(owner.selects[0] ?? "", /\bphoto_path\b/, "and for the Super Admin: the two readers see the same picture");
    assert.match(owner.selects[0] ?? "", /\bdevice_mocked\b/, "who alone also asks for the phone's mock-location answer");
    assert.equal(owner.board.latest.find((entry) => entry.id === "r1")?.photoPath, GOOD);

    // The page draws it through the SCOPED photo route and never signs a URL of its own.
    const code = stripComments(read("app/(admin)/admin/phoenix-crm/refused-readings/page.tsx"));
    assert.match(code, /import \{ CrmPhotoThumb \} from "@\/components\/phoenix-crm\/photo"/, "the page uses the module's own thumbnail, which signs through /api/phoenix-crm/photos/sign");
    assert.doesNotMatch(code, /createSignedUrl|storage\.from|getSupabaseAdmin|<img\b/, "the page never opens the bucket and never draws a bare image");
    assert.equal((code.match(/<SentPhoto entry=\{entry\} size="h-\d+ w-\d+" \/>/g) ?? []).length, 2, "the photo comes from one component, so the table cell and the phone card cannot disagree");
    assert.ok(code.includes("path={entry.photoPath}"), "and it is handed the pointer, nothing signed");
    assert.match(code, /className=\{size\} lazy path=/, "lazy — a worklist of a hundred must not fetch every picture, twice, on open");
    assert.ok(code.includes("None kept"), "a row with no photo says so in words instead of drawing a broken tile");
    assert.equal((code.match(/<th className="px-3 py-3">Photo<\/th>/g) ?? []).length, 1, "the table has its Photo column");

    // The shared thumbnail passes `lazy` down to the one `<img>`, and by default nothing changes for the other surfaces.
    const thumb = stripComments(read("src/components/phoenix-crm/photo.tsx"));
    assert.ok(thumb.includes("lazy={lazy}"), "the module thumbnail hands `lazy` to the zoomable photo");
    const zoom = stripComments(read("src/components/ui/zoomable-photo.tsx"));
    assert.ok(zoom.includes('loading={lazy ? "lazy" : undefined}'), "and it becomes the browser's own loading=lazy — and only when asked, so every other surface loads as before");
  }

  // ── 10 · 🔴 A PERMISSION THE BROWSER BLOCKED REACHES THE BOARD AT ALL ───────────────────────────
  // Owner, 2026-10-13: "record a browser-blocked permission so it reaches the refused-readings board."
  //
  // Every reason before this one is a SERVER refusal: a reading arrived and a door turned it away. A
  // permission the browser blocks produces no reading, reaches no door, and reached no row — so the
  // board was blind to the one refusal nobody can diagnose from the outside. Norhan Gamal's iPhone
  // answered PERMISSION_DENIED five times across 10 and 12 October 2026 and this table held ZERO rows
  // for her seat; the only trace was the touch trail (since retired), which kept a message only if the rep pressed
  // it, and which carried 42 location and 30 camera messages from four reps over 4-12 October.
  {
    const blockedLocation = refusalSentence({ subjectKind: "place", reason: "blocked", accuracyMeters: null, photoAccuracyMeters: null, maxAccuracyMeters: null, blockedPermission: "location" });
    assert.match(blockedLocation, /blocked the location/, "it says the browser blocked the LOCATION, which is the switch the rep has to find");
    assert.match(blockedLocation, /never reached Phoenix/, "and that nothing was sent, so nobody looks for a reading that cannot exist");
    assert.doesNotMatch(blockedLocation, /too rough|not reported|\d+ m\b/, "never a radius and never 'not reported': there was no reading at all, which is not a missing one");

    const blockedCamera = refusalSentence({ subjectKind: "place", reason: "blocked", accuracyMeters: null, photoAccuracyMeters: null, maxAccuracyMeters: null, blockedPermission: "camera" });
    assert.match(blockedCamera, /blocked the camera/, "the camera is its own sentence");
    assert.notEqual(blockedCamera, blockedLocation, "🔴 and the two permissions never read the same — the rep is looking for one switch, not either of two");

    assert.equal(parseBlockedPermission("location"), "location");
    assert.equal(parseBlockedPermission("camera"), "camera");
    assert.equal(parseBlockedPermission("microphone"), null, "only the two permissions a capture needs");
    assert.equal(parseBlockedPermission(null), null);
    assert.equal(parseBlockedPermission(7), null, "and nothing that is not a string");

    // ── The reason is read EXHAUSTIVELY, which is also the repair of a live defect ────────────────
    // 🔴 THE READER ASKED ONE QUESTION AND ASSUMED THE REST: `row.reason === "no_fix" ? "no_fix" :
    // "rough"`. From 5 October every off_listing row on the board therefore printed "the position was
    // too rough" — the one thing that refusal is NOT, both its readings being precise. Two of
    // 13 October's refusals were telling the SFE that about reps standing within 5 m.
    // 🔴 COMMENTS STRIPPED FIRST. The file's own ROLLBACK header quotes the PREVIOUS three-value
    // CHECK verbatim, so an unstripped read matches the rollback and asks the board to recognise a
    // list the database no longer has — which is this test passing on the wrong line.
    // 🔴 THE NEWEST MIGRATION THAT RE-ADDS THE CHECK IS THE ONE THE DATABASE HOLDS — each one drops
    // and recreates it — so the test finds it rather than naming a file that a later widening (the
    // timetable scanner's two reasons, 2026-10-17) silently makes stale.
    const reasonCheckFile = readdirSync(path.join(process.cwd(), "supabase/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .filter((name) => stripSqlComments(read(`supabase/migrations/${name}`)).includes("add constraint phoenix_crm_refused_readings_reason_check"))
      .pop();
    assert.ok(reasonCheckFile, "a migration still defines the reason CHECK");
    const reasonCheck = /check \(reason = any \(array\[([^\]]+)\]\)\)/.exec(stripSqlComments(read(`supabase/migrations/${reasonCheckFile}`)));
    assert.ok(reasonCheck, "the migration's reason CHECK is still readable, so this test can ask the DATABASE what the reasons are");
    const allowed = [...reasonCheck[1]!.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1]!);
    assert.deepEqual(
      [...allowed].sort(),
      ["blocked", "far_from_place", "no_fix", "off_listing", "rough", "signboard_no_plate", "signboard_unreadable", "timetable_missing", "timetable_unreadable"],
      "nine reasons (far_from_place joined 2026-10-20), and the migration is where that list lives",
    );
    const sentences = new Map<string, string>();
    for (const reason of allowed) {
      assert.equal(parseRefusedReason(reason), reason, `🔴 the reader must recognise '${reason}' — a value the database allows and this function does not know is printed as "too rough"`);
      sentences.set(
        reason,
        refusalSentence({ subjectKind: "place", reason: parseRefusedReason(reason), accuracyMeters: 11, photoAccuracyMeters: 14, maxAccuracyMeters: 250, blockedPermission: reason === "blocked" ? "location" : null }),
      );
    }
    assert.equal(new Set(sentences.values()).size, allowed.length, "and every reason reads as itself: one sentence per reason");
    assert.doesNotMatch(sentences.get("off_listing")!, /too rough/, "🔴 the off_listing regression: it must never read as a rough position again");
    assert.doesNotMatch(sentences.get("blocked")!, /too rough/, "nor the blocked one");
    // The timetable scanner's two (owner, 2026-10-17): a PHOTOGRAPH refused, never a position.
    for (const reason of ["timetable_unreadable", "timetable_missing"] as const) {
      assert.doesNotMatch(sentences.get(reason)!, /too rough|\d+ m\b/, `${reason} is about the photograph of the timetable, never a radius`);
      assert.match(sentences.get(reason)!, /timetable/, `${reason} names the timetable`);
    }
    // The signboard scanner's two (2026-10-18): the same — a photograph of the nameplate refused.
    for (const reason of ["signboard_unreadable", "signboard_no_plate"] as const) {
      assert.doesNotMatch(sentences.get(reason)!, /too rough|\d+ m\b/, `${reason} is about the photograph of the signboard, never a radius`);
      assert.match(sentences.get(reason)!, /nameplate|signboard/, `${reason} names the signboard`);
    }
    assert.equal(parseRefusedReason("something_new"), "rough", "an unrecognised value still returns a reason, because the type admits nothing else — the loop above is what keeps that branch unreachable");

    // The coercion itself is gone from the reader, with comments stripped so the comment explaining
    // the repair cannot be what satisfies this.
    const reader = stripComments(read("src/lib/phoenix-crm/server/refused-readings-board.ts"));
    assert.doesNotMatch(reader, /row\.reason === "no_fix"/, "🔴 the two-way coercion is gone from the reader, not merely commented");
    assert.ok(reader.includes("parseRefusedReason(row.reason)"), "and the exhaustive parse is what reads it");

    // ── And it arrives through the real reader, for both audiences ────────────────────────────────
    const blockedRows = [
      { id: "b1", subject_kind: "place", reason: "blocked", blocked_permission: "location", rep_hr_id: REP, customer_id: null, refused_at: "2026-10-13T08:59:01.000Z", accuracy_meters: null, photo_accuracy_meters: null, max_accuracy_meters: null, photo_path: null, device_mocked: null },
      { id: "b2", subject_kind: "place", reason: "blocked", blocked_permission: "camera", rep_hr_id: REP, customer_id: null, refused_at: "2026-10-13T09:10:15.000Z", accuracy_meters: null, photo_accuracy_meters: null, max_accuracy_meters: null, photo_path: null, device_mocked: null },
      { id: "o1", subject_kind: "place", reason: "off_listing", blocked_permission: null, rep_hr_id: REP, customer_id: CUSTOMER, refused_at: "2026-10-13T07:00:00.000Z", accuracy_meters: 5, photo_accuracy_meters: 4, max_accuracy_meters: 100, photo_path: null, device_mocked: null },
    ];
    async function loadBlocked(who: PhoenixCrmViewer) {
      const original = globalThis.fetch;
      const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
      const selects: string[] = [];
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        const table = url.pathname.split("/").pop() ?? "";
        if (table === "phoenix_crm_refused_readings") {
          selects.push(url.searchParams.get("select") ?? "");
          return new Response(JSON.stringify(blockedRows), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (table === "employees") {
          return new Response(JSON.stringify([{ hr_id: REP, full_name: "Test Rep", nickname: null }]), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      try {
        return { board: await loadRefusedReadingsBoard(who), selects };
      } finally {
        globalThis.fetch = original;
        if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
        else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
        if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
      }
    }

    for (const who of [viewer({ sfe: true }), viewer({ superAdmin: true })]) {
      const { board, selects } = await loadBlocked(who);
      assert.match(selects[0] ?? "", /\bblocked_permission\b/, "the permission is asked of the database for BOTH readers — it is the difference between a switch and a wide reading, and the SFE is who acts on the switch");
      const byId = new Map(board.latest.map((entry) => [entry.id, entry]));
      assert.equal(byId.get("b1")?.reason, "blocked", "a blocked row reads as blocked, not as rough");
      assert.equal(byId.get("b1")?.blockedPermission, "location");
      assert.equal(byId.get("b2")?.blockedPermission, "camera", "and the camera's row names the camera");
      assert.match(refusalSentence(byId.get("b2")!), /blocked the camera/, "so the board prints the permission the browser actually blocked");
      assert.equal(byId.get("b1")?.outcome, "unknown", "it is tied to no customer — a blocked switch is a fact about the PHONE, identical for every customer on the list");
      assert.equal(byId.get("o1")?.reason, "off_listing", "🔴 and the off_listing row arrives as itself through the real reader, which is what was broken");
      assert.doesNotMatch(refusalSentence(byId.get("o1")!), /too rough/, "so a rep standing 5 m away is no longer told his position was too rough");
      assert.equal(board.total, 3, "all three refusals are on the board");
    }
  }
}
