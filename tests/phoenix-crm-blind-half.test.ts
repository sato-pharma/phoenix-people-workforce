import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — GOLDEN RULE #1, the BLIND half, made mechanical.
 *
 * Owner, 2026-09-26: "never make the medical rep feel that the system is here to catch him, make
 * everything silent to him … never informed of any violation or any other thing. But every violation
 * is then recorded in the admin and the SFE account."
 *
 * ## Why this file replaces the block it replaces
 *
 * The blindness was pinned by a HARD-CODED LIST OF SIX FILES inside
 * `tests/phoenix-crm-location-integrity.test.ts`. That list cannot grow by itself, so the seventh
 * rep-facing screen anyone writes is born unchecked — and the module is about to gain several (a
 * Today screen, a manager screen, more of the mobile app). A rule whose guard has to be remembered
 * is a rule with a deadline.
 *
 * Here the surface is DERIVED: every file under the rep-facing roots is swept, whatever its name and
 * whenever it was added. The four registries below are the only thing a later step edits, in one
 * place, and the file-count floors mean a moved or renamed directory fails loudly instead of quietly
 * sweeping nothing and reporting green.
 *
 * ## The boundary this encodes
 *
 * Not "information about him" — WHOSE WORK IT IS. His plan, his day, his targets and an approval he
 * raised himself are his and stay visible. Anything that judges his honesty is never his, and he
 * must not learn that the judging exists. That is why the refusals below must be 404 and not 403: a
 * message reading "the location integrity board is the Super Admin's" IS the disclosure.
 */

const ROOT = new URL("../", import.meta.url);

/** Every rep-facing file, derived — the point of this test. */
const REP_FACING_ROOTS: ReadonlyArray<{ dir: string; floor: number }> = [
  { dir: "src/components/phoenix-crm", floor: 20 },
  { dir: "mobile/src/features/crm", floor: 5 },
  { dir: "mobile/src/components/crm", floor: 4 },
  { dir: "mobile/src/lib/crm", floor: 8 },
  { dir: "app/employee-portals/field-crm", floor: 1 },
];

/**
 * The pure rule modules a rep's bundle pulls in. `src/lib/phoenix-crm/server/**` is excluded — it is
 * the server, and it is where the evidence is SUPPOSED to live — and so is the one pure module that
 * exists to describe the checks themselves.
 */
const REP_FACING_PURE_EXCLUDED = new Set([
  "location-integrity.ts",
  // Same reason, for the photo half (2026-09-27): a module whose whole job is to describe the checks
  // cannot also be forbidden from naming them. Neither file is reachable from the rep's bundle —
  // check 2 below is what proves that, by refusing the import anywhere a rep can see.
  "duplicate-photos.ts",
  // And the behaviour rules (2026-09-27), for the same reason: a module that names the checks
  // cannot also be forbidden from naming them. Check 2 is what proves no rep-facing file imports it.
  "behaviour-integrity.ts",
  // And the weekly scan's pure half (2026-10-07). It composes the board's OWN flags into the message
  // the Super Admin and the SFE Manager read, so it necessarily says "flagged" and "integrity" — in
  // text only they will ever see. It is the fourth and last file with this justification, and it is
  // only safe because "fraud-scan" is on SILENT_MODULES below: check 2 refuses the import from every
  // rep-facing file, so the exclusion is a statement about WHO reads the words, not a hole.
  "fraud-scan-rules.ts",
  // The Visit report generator's two pure halves (2026-10-15): its field catalogue and its dashboard name
  // the evidence fields ("Far from the place", the position flag) for the Super Admin and the SFE Manager
  // who build the report. Neither is imported by a rep-facing file — check 2 refuses that — so the
  // exclusion is a statement about WHO reads the words.
  "visit-report-dashboard.ts",
  "visit-report-fields.ts",
]);

/**
 * Words that must never reach the rep's eyes, checked against strings and JSX TEXT.
 *
 * Text, not raw source: `deviceMocked` is a payload key the phone must forward or the evidence never
 * reaches the server, and forwarding is fine. Putting it into words is not.
 *
 * `flagged` joined on 2026-09-26, with the owner's polite sign. The two "AM flagged / PM flagged"
 * tiles and the sentence "the visit is saved with this flag" left the rep's app that day: a COUNT of
 * flags is the scoreboard he must never be shown of himself, and the word is how it creeps back.
 */
const SILENT_WORDS: ReadonlyArray<RegExp> = [
  /\bintegrity\b/i,
  /\bflagg?ed\b/i,
  /\bmock\b/i,
  /fake\s*gps/i,
  /\bspoof/i,
  /\bfraud\b/i,
  /\bcheat/i,
  /app that changes the location/i,
];

/**
 * The two tabs inside the shared component tree that a rep is NEVER served.
 *
 * `overview.ts` decides `tabs.team` and `tabs.settings` server-side — team needs manager seats or a
 * company basis, settings is the Super Admin's — and `phoenix-crm-app.tsx` renders only the tabs the
 * server allowed. They are excluded from the WORD check alone, because a manager's own queue may say
 * "nothing flagged" and the Super Admin's settings screen has to explain what the threshold does.
 *
 * Everything else still applies to them: neither may import a silent module or name a silent table.
 * Keep this list at two. A third entry is a sign that a rep-facing screen is being argued into an
 * exception, which is exactly how the rule dies.
 */
const NEVER_SERVED_TO_A_REP = new Set([
  "src/components/phoenix-crm/team-tab.tsx",
  "src/components/phoenix-crm/settings-tab.tsx",
]);

/**
 * Columns that exist only to be judged. A rep-facing type naming one is the defect.
 *
 * Both joined on 2026-09-26 with the visit's silent stopwatch: `dwell_seconds` is server-derived from
 * the visit's own captured_at and the phone never sends it; `form_open_seconds` is what the phone
 * counted and IS sent, which is why the check below draws the line at the READ rather than at the
 * file — see it for the whole rule.
 */
const SILENT_COLUMNS: ReadonlyArray<string> = [
  "dwell_seconds",
  "form_open_seconds",
  // A1 (2026-09-27). The owner ruled that an offline visit COUNTS normally and that the fact it came
  // in offline is "visible to his manager and on the board" — so these three are a manager's fact,
  // not an integrity secret, and the line they must not cross is the REP's own visit rows.
  "capture_source",
  "offline_seconds",
  "synced_at",
  // Capture provenance (2026-10-12). `fix_taken_at` and `device_install_id` are SENT by the phone, so
  // they are here for the same reason `form_open_seconds` is: the line is the READ, never the file.
  // `fix_age_seconds` and `app_revision` are derived and read on the SERVER and the phone never names
  // them at all — they are listed so a later change cannot start answering them back to a rep.
  "fix_taken_at",
  "fix_age_seconds",
  "device_install_id",
  "app_revision",
  // How long the phone held a save for want of signal (2026-11-03). Filed after the save, read by the travel
  // check and the Visit report, and never answered back to a rep.
  "queued_seconds",
];

/** Tables only the blind readers may touch. */
const SILENT_TABLES: ReadonlyArray<string> = [
  "phoenix_crm_location_integrity",
  "phoenix_crm_photo_fingerprints",
  "phoenix_crm_behaviour_integrity",
  // When the phone took the position it sent, and which browser install sent it (2026-10-12). Written
  // after the save and read by nothing a rep can reach.
  "phoenix_crm_visit_capture_provenance",
];

/** Modules only the blind readers may import. */
const SILENT_MODULES: ReadonlyArray<string> = [
  "location-integrity",
  "integrity-board",
  "duplicate-photos",
  "photo-dupes",
  "behaviour-integrity",
  "phoenix-crm/server/behaviour",
  // Both halves of the weekly scan (2026-10-07): the rules module above and the sender beside it. Its
  // audience is the board's own two roles, so a rep-facing file reaching either is the defect.
  "fraud-scan",
];

/**
 * The only files allowed to read a silent table. Every one of them is also asserted to gate on the
 * board's audience and to refuse with a 404.
 */
const BLIND_READERS: ReadonlyArray<string> = [
  "src/lib/phoenix-crm/server/location-integrity.ts",
  "src/lib/phoenix-crm/server/integrity-board.ts",
  "src/lib/phoenix-crm/server/photo-dupes.ts",
  "src/lib/phoenix-crm/server/behaviour.ts",
  "app/(admin)/admin/phoenix-crm/integrity/page.tsx",
  // The capture-provenance writer (2026-10-12). It is a declared reader because it NAMES the table —
  // check 5 searches the text, and the write is what keeps that check from going vacuous. It is not
  // held to check 6's audience rules, which are specific to the board: this file answers nobody at
  // all, which is a stronger position than gating a read.
  "src/lib/phoenix-crm/server/capture-provenance.ts",
  // The Visit report loader (2026-10-15). It reads capture provenance for the "how was it saved" field,
  // but only inside a loader the Super Admin and the SFE Manager alone can reach (`canReadVisitReport`,
  // page and both routes, pinned in tests/phoenix-crm-visit-report.test.ts), and the mock-location
  // evidence is shaped out of the payload for the SFE Manager before it leaves the server.
  "src/lib/phoenix-crm/server/visit-report.ts",
  // The stored-signboard re-judge (2026-10-18). After it confirms a plate under the owner's spelling
  // rulings it looks up which OPEN signboard cases sit on those places, so the script can list them for
  // the Super Admin to decide — it reads ids and flags only, settles nothing, and answers nobody: its
  // one caller is `scripts/phoenix-crm-reread-signboards.mjs`, and check 4 keeps every rep route away.
  "src/lib/phoenix-crm/server/signboard-sweep.ts",
  // The far-visit safeguards (owner, 2026-11-10). Inside a rep's own validation they read capture provenance
  // for visit IDS only, to LEAVE OUT a save the phone held for want of signal as a travel anchor (it arrived
  // late, so its time is not when he stood there). That can only make the impossible-location refusal rarer;
  // nothing read reaches a payload, and the rep reads the same "location has not settled" sentence either way.
  "src/lib/phoenix-crm/server/far-visit-safeguards.ts",
];

/**
 * The judges that must never be able to cost a rep his visit.
 *
 * 🔴 The photo sweep is deliberately NOT here, and that is not an omission. This list is for judges
 * that run INSIDE a rep's own save, where throwing would turn a working visit into a failure for a
 * rep standing in front of a doctor. The sweep runs at night, as the system, from a cron with a
 * dead-man's switch — and there it must be allowed to throw, or a night that never ran would report
 * a silent success. What keeps it away from a rep is check 4 below, which refuses the import from
 * every route his app can call; the invariant is the same and it is proved in a different place.
 */
const SILENT_RUNNERS: ReadonlyArray<string> = [
  "src/lib/phoenix-crm/server/location-integrity.ts",
  // The capture-provenance writer belongs here and the photo sweep does not, by exactly the test the
  // note above states: this one runs INSIDE a rep's own save, one line after the judgement, so a throw
  // here would turn a saved visit into a failed one for a rep standing in front of a doctor.
  "src/lib/phoenix-crm/server/capture-provenance.ts",
];

function read(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8");
}

function exists(path: string): boolean {
  try {
    statSync(fileURLToPath(new URL(path, ROOT)));
    return true;
  } catch {
    return false;
  }
}

/** Every `.ts`/`.tsx` under a directory, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(fileURLToPath(new URL(relative, ROOT)), { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (/\.tsx?$/.test(entry.name)) out.push(next);
    }
  };
  walk(dir);
  return out;
}

/** The pure Phoenix CRM rule modules, which a rep's bundle can reach. */
function purePhoenixCrmFiles(): string[] {
  const dir = "src/lib/phoenix-crm";
  return readdirSync(fileURLToPath(new URL(dir, ROOT)), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !REP_FACING_PURE_EXCLUDED.has(entry.name))
    .map((entry) => `${dir}/${entry.name}`);
}

/** Every string literal in a source, comments already blanked. */
function literalsOf(source: string): string[] {
  return stripComments(source).match(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g) ?? [];
}

/**
 * The text between JSX tags — `<p>Integrity</p>`.
 *
 * The old guard read string literals only, so a word typed straight into the markup slipped past it
 * entirely. Braces are excluded so an interpolation is not mistaken for prose.
 */
function jsxTextOf(source: string): string[] {
  return [...stripComments(source).matchAll(/>([^<>{}]+)</g)]
    .map((match) => match[1] ?? "")
    .filter((text) => /[A-Za-z]{3}/.test(text));
}

export function runPhoenixCrmBlindHalfTests(): void {
  const repFacing: string[] = [];
  for (const { dir, floor } of REP_FACING_ROOTS) {
    assert.ok(exists(dir), `${dir} must exist — a moved rep-facing root would sweep nothing and read green`);
    const found = filesUnder(dir);
    assert.ok(
      found.length >= floor,
      `${dir} holds ${found.length} files, below the floor of ${floor}. Either the directory moved or the sweep is looking at nothing.`,
    );
    repFacing.push(...found);
  }
  repFacing.push(...purePhoenixCrmFiles());

  // The exclusion list must name real files, or a rename turns it into a silent hole.
  for (const path of NEVER_SERVED_TO_A_REP) {
    assert.ok(repFacing.includes(path), `${path} is excluded from the word check but is not in the sweep — the exclusion has gone stale`);
  }

  const problems: string[] = [];

  // ── 1 · No silent word reaches a rep, in a string OR in the markup ──────────────────────────────
  for (const path of repFacing) {
    if (NEVER_SERVED_TO_A_REP.has(path)) continue;
    const source = read(path);
    for (const text of [...literalsOf(source), ...jsxTextOf(source)]) {
      for (const word of SILENT_WORDS) {
        if (word.test(text)) problems.push(`${path} says ${word} to a rep: ${text.trim().slice(0, 80)}`);
      }
    }
  }

  // ── 2 · No rep-facing file imports a silent module or names a silent table ──────────────────────
  //
  // Comments are blanked first. Prose explaining WHY a field is carried but never shown necessarily
  // names the thing it is not showing — `entry-rules.ts` says in capitals that `deviceMocked` is
  // recorded for the board and refused to nobody, which is exactly the note that must stay. What may
  // not survive is an import or a real reference.
  for (const path of repFacing) {
    const code = stripComments(read(path));
    for (const silentModule of SILENT_MODULES) {
      if (code.includes(silentModule)) problems.push(`${path} must not reach ${silentModule}`);
    }
    for (const table of SILENT_TABLES) {
      if (code.includes(table)) problems.push(`${path} must not name ${table}`);
    }
  }

  // ── 3 · No silent column reaches a rep-facing type or READ ──────────────────────────────────────
  //
  // 🔴 The line is the READ, not the file — widened 2026-09-26 with `form_open_seconds`, which the
  // phone has to SEND or the signal never exists at all. A blanket "this name appears nowhere in
  // visits.ts" banned the write along with the read, which would have left the only way to record it
  // being to hide it somewhere worse. So the three rep-facing surfaces are checked by name:
  //
  //   * VISIT_COLUMNS   — what is selected back out of the table
  //   * VisitRow        — the shape every rep-facing screen reads
  //   * mapVisitRow     — the one place a row becomes that shape
  //
  // and the write is PINNED rather than merely allowed: every occurrence in the file must lie inside
  // saveVisit. A second mention anywhere else is the defect this catches.
  {
    const visits = read("src/lib/phoenix-crm/server/visits.ts");
    const region = (start: string, end: string) => {
      const from = visits.indexOf(start);
      const to = from < 0 ? -1 : visits.indexOf(end, from);
      return from < 0 || to < 0 ? null : visits.slice(from, to);
    };
    const NL = String.fromCharCode(10);
    const readPaths: Array<[string, string | null]> = [
      ["VISIT_COLUMNS", region("const VISIT_COLUMNS", `;${NL}`)],
      ["VisitRow", region("export type VisitRow = {", `${NL}};`)],
      ["mapVisitRow", region("function mapVisitRow(", `${NL}}`)],
    ];
    const writeFrom = visits.indexOf("export async function saveVisit");
    if (writeFrom < 0) problems.push("visits.ts no longer exports saveVisit — this check has lost its anchor");

    for (const column of SILENT_COLUMNS) {
      const camel = column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      for (const [name, text] of readPaths) {
        if (text === null) problems.push(`the blind-half check can no longer find ${name} in visits.ts`);
        else if (text.includes(column) || text.includes(camel)) problems.push(`${name} must not carry ${column} — it is the rep's own screen`);
      }
      for (const match of [...visits.matchAll(new RegExp(column, "g"))]) {
        if (writeFrom >= 0 && match.index !== undefined && match.index < writeFrom) {
          problems.push(`visits.ts names ${column} outside saveVisit — a silent column is written there and read nowhere`);
        }
      }
    }
  }

  // ── 4 · No silent table is reachable from a route the rep's app can call ────────────────────────
  for (const path of filesUnder("app/api/phoenix-crm")) {
    const code = stripComments(read(path));
    for (const table of SILENT_TABLES) {
      if (code.includes(table)) problems.push(`${path} is a rep-callable route and must not read ${table}`);
    }
    for (const silentModule of SILENT_MODULES) {
      if (code.includes(silentModule)) problems.push(`${path} is a rep-callable route and must not reach ${silentModule}`);
    }
  }

  // ── 5 · Every reader of the evidence is declared, and there IS one ──────────────────────────────
  {
    const declared = new Set(BLIND_READERS);
    const searched = [...filesUnder("src/lib/phoenix-crm/server"), ...filesUnder("app/(admin)/admin/phoenix-crm")];
    for (const table of SILENT_TABLES) {
      const readers = searched.filter((path) => read(path).includes(table));
      // Anti-vacuity: if nothing reads it, this whole assertion has stopped meaning anything.
      if (readers.length === 0) problems.push(`nothing reads ${table} any more — this test has gone vacuous`);
      for (const path of readers) {
        if (!declared.has(path)) problems.push(`${path} reads ${table} but is not a declared blind reader`);
      }
    }
  }

  // ── 6 · The board's audience is one predicate, and the refusal is a 404 ─────────────────────────
  {
    const board = read("src/lib/phoenix-crm/server/integrity-board.ts");
    if (!board.includes("canReadIntegrityBoard")) problems.push("the board must gate on canReadIntegrityBoard");
    if (!board.includes("isSuperAdmin")) problems.push("the board's audience must name the Super Admin");
    if (!board.includes("isSfeManager")) problems.push("the board's audience must name the SFE Manager (owner, 2026-09-26)");
    // 🔴 BUT NOT FOR EVERYTHING ON IT (owner, 2026-10-02 — he picked the recommended answer: "mock-location
    // evidence is the Super Admin's only; the SFE Manager keeps the photo-duplicate and behaviour
    // cases"). The position detector's cases and the phone's own mock answer are never QUERIED for the
    // SFE — a screen that hid them would leave them one network tab away. Pinned on the query itself.
    if (!/export function readsPositionCases\(viewer: PhoenixCrmViewer\): boolean \{\s*return viewer\.isSuperAdmin;\s*\}/.test(board)) {
      problems.push("the position cases must be the Super Admin's alone, in one predicate: readsPositionCases");
    }
    // 🔴 The narrowing is an ALLOW-LIST since 2026-10-09, not `.eq("source", "photo")`: that spelling
    // meant "everything but the position cases" only while `photo` was the only other detector, and
    // `signboard` proved it was not — it filed five cases nobody had decided an audience for. Three
    // halves are pinned, because the rule needs all three: the narrowing stays on the QUERY (never a
    // filter after the read), the windowed copy narrows the same way, and the list itself still holds
    // nothing but the detectors he decided the SFE may read.
    if (!/if \(!positions\) query = query\.in\("source", SFE_SOURCES\);/.test(board)) {
      problems.push("for anyone else the board must QUERY the allow-listed cases only, never filter GPS cases out afterwards");
    }
    if (!/if \(!options\.includeGps\) query = query\.in\("source", SFE_SOURCES\);/.test(board)) {
      problems.push("the windowed read must narrow by the same allow-list, on the query");
    }
    if (!/const SFE_SOURCES: IntegritySource\[\] = \["photo"\];/.test(board)) {
      problems.push("SFE_SOURCES must stay the decided list — position cases are the Super Admin's alone (owner, 2026-10-02) and so are signboard cases (owner, 2026-10-09)");
    }
    if (!/deviceMocked: positions && /.test(board)) problems.push("the phone's mock-location answer must be the Super Admin's alone");
    // A 403 that names the board tells the person asking that the board exists and what it watches.
    if (board.includes("forbiddenError")) {
      problems.push("the board must refuse with notFoundError, never forbiddenError — a 403 naming it IS the disclosure");
    }
    if (!board.includes("notFoundError")) problems.push("the board must refuse with notFoundError");

    const page = read("app/(admin)/admin/phoenix-crm/integrity/page.tsx");
    if (!page.includes("canReadIntegrityBoard")) problems.push("the board page must gate on the same predicate as the service");
    if (!page.includes("redirect(")) problems.push("the board page must redirect, never render an explanation");
  }

  // ── 7 · No silent judgement can cost a rep his visit ────────────────────────────────────────────
  for (const path of SILENT_RUNNERS) {
    const source = read(path);
    if (!source.includes("Promise<void>")) problems.push(`${path} must return nothing — a judge that throws is a judge that refuses a visit`);
    if (!source.includes("catch")) problems.push(`${path} must swallow its own failures`);
  }

  // ── 8 · No refusal the rep can trigger names a check ────────────────────────────────────────────
  {
    const refusals = stripComments(read("src/lib/phoenix-crm/server/db.ts"));
    for (const text of literalsOf(refusals)) {
      for (const word of SILENT_WORDS) {
        if (word.test(text)) problems.push(`a refusal message names a check: ${text.trim().slice(0, 80)}`);
      }
    }
  }

  // ── 9 · The evidence stays out of every rep-facing API response shape ───────────────────────────
  {
    const viewTypes = read("src/lib/phoenix-crm/view-types.ts");
    for (const silentModule of SILENT_MODULES) {
      if (viewTypes.includes(silentModule)) problems.push(`view-types.ts must not re-export ${silentModule} — it is the wire the phone reads`);
    }
  }

  // ── 10 · The Team endpoint answers a rep too, so his own off-plan visits leave it blind ─────────
  // A rep's scope holds his OWN territory, so GET /api/phoenix-crm/team returns his own waiting off-plan
  // visits. Found 2026-10-02: no rep screen showed their location flag, but the raw answer carried it.
  // Since the owner's ruling of 2026-10-02 (a manager reads the distance only) the flag goes through
  // `offPlanLocationFlag` and `locationSight`, whose `none` level is `isLocationBlind` — so both halves
  // are pinned: the call fails blind for a seat it cannot place, and `none` answers null.
  {
    const team = read("src/lib/phoenix-crm/server/team.ts");
    if (!/locationFlag: offPlanLocationFlag\(seat \? locationSight\(viewer, seat\) : "none", view\.locationFlag\),/.test(team)) {
      problems.push("server/team.ts must clear an off-plan visit's locationFlag for a location-blind viewer, failing blind");
    }
    const shapers = read("src/lib/phoenix-crm/server/blind-payloads.ts");
    if (!/export function offPlanLocationFlag\(sight: LocationSight, flag: string \| null\): string \| null \{\s*if \(sight === "none"\) return null;/.test(shapers)) {
      problems.push("offPlanLocationFlag must answer null at the `none` level — the rep's own off-plan visit carries no flag");
    }
    const access = read("src/lib/phoenix-crm/server/access.ts");
    if (!/return isLocationBlind\(viewer, seat\) \? "none" : "distance";/.test(access)) {
      problems.push("locationSight's `none` level must be isLocationBlind");
    }
  }

  assert.deepEqual(problems, [], `\n  ${problems.join("\n  ")}\n`);

  console.log(`phoenix-crm blind half: OK (${repFacing.length} rep-facing files swept)`);
}
