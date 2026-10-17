import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  parsePlaceNoteSource,
  parsePlaceNoteSubjectKind,
  parsePlaceRecommendation,
  placeNoteAuthorLabel,
  placeNoteRepAuthorText,
  placeNoteSubjectKey,
  placeRecommendationLabel,
  PLACE_NOTE_MAX_LENGTH,
} from "../src/lib/phoenix-crm/place-note-rules.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — a district manager's own Place checks tab: the comment, the visibility choice and the
 * recommendation.
 *
 * Owner, 13 October 2026: "In every district manager account, build a tab in his sidebar that shows
 * the check places only for his team and make him able to comment. And when he comes to comment, he
 * can choose the rep see the comment or the rep doesn't see the comment. He can recommend to validate,
 * or he can recommend to not validate. But the final is for the system administrator only. But don't
 * show this on the screen."
 *
 * Four of those clauses can each be broken by a one-line change that looks like a tidy-up, so each is
 * pinned here:
 *
 *   1. ONLY HIS TEAM. The four section reads narrow on the SERVER (`placeChecksSeatScope` →
 *      `.in("seat_id", …)`), and the scope helper THROWS rather than handing back `[]` — a PostgREST
 *      `.in()` on an empty array answers zero rows with no error, which would draw an empty board for
 *      a viewer who may not open it at all.
 *   2. HE DECIDES NOTHING. `canDecideValidationReviews` still gates all three decision services, and
 *      the board renders no decision control in `mode="team"`.
 *   3. THE VISIBILITY IS CHOSEN, NEVER DEFAULTED. `rep_visible` is NOT NULL with no default in the
 *      table and a required boolean on the wire, and the screen's only way to save is one of the two
 *      buttons.
 *   4. THE REP'S SIDE IS ROLE-ONLY AND SILENT. He is told which authority wrote to him and nothing
 *      else; the query filters `rep_visible`, so a note he may not read never reaches his browser; and
 *      no channel carries it.
 *
 * The services read the database and cannot be imported here, so those layers are pinned by source;
 * the wording rules are pure and are called for real.
 */

const ROOT = new URL("../", import.meta.url);

function sourceOf(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n");
}

/** JS/TSX, comments removed — a "must not appear" assertion must not read the prose explaining it. */
function read(path: string): string {
  return stripComments(sourceOf(path));
}

/** `export (async )?function name(...) { … }` — its signature to its closing brace at column 0. */
function functionBody(source: string, name: string): string {
  const match = new RegExp(`export (?:async )?function ${name}\\([\\s\\S]*?\\n\\}`).exec(source);
  assert.ok(match, `${name} is still an exported function — this test resolves it by that name`);
  return match[0];
}

// ── 1 · What the rep is told, and what he is not ────────────────────────────────────────────────

function checkRepWording(): void {
  // 🔴 A ROLE, NEVER A NAME. This is the one door the owner opened in golden rule #1 and he opened it
  // exactly this wide (2026-10-13: "it is from the system administrator, then show from the system
  // administrator. If from his manager, then show that it is from his manager").
  assert.equal(placeNoteRepAuthorText("system_admin"), "From the System Administrator");
  assert.equal(placeNoteRepAuthorText("manager"), "From your manager");
  for (const source of ["system_admin", "manager"] as const) {
    const text = placeNoteRepAuthorText(source);
    assert.ok(!/[A-Z]-\d/.test(text), `the rep's attribution carries no HR id (${text})`);
    assert.ok(!text.includes("District Manager"), "and not the seat's title either — his manager is 'your manager' to him");
  }

  // The boards, which may read everything, name the writer AND the role.
  assert.equal(placeNoteAuthorLabel("manager", "Fatma Saeed"), "Fatma Saeed · District Manager");
  assert.equal(placeNoteAuthorLabel("system_admin", "Omar Gawish"), "Omar Gawish · System Administrator");
  // A name that could not be resolved falls back to the role alone, never to an id and never to blank.
  assert.equal(placeNoteAuthorLabel("manager", null), "District Manager");

  // The two buttons carry the owner's own words for them.
  assert.equal(placeRecommendationLabel("validate"), "Recommend validate");
  assert.equal(placeRecommendationLabel("reject"), "Recommend not validate");

  // Anything unrecognised is dropped, never guessed: the value decides the one sentence a rep reads.
  assert.equal(parsePlaceNoteSource("sfe"), null);
  assert.equal(parsePlaceNoteSource(undefined), null);
  assert.equal(parsePlaceRecommendation("approve"), null);
  assert.equal(parsePlaceRecommendation("validate"), "validate");
  assert.equal(parsePlaceNoteSubjectKind("customer"), null);
  assert.equal(parsePlaceNoteSubjectKind("shared_place"), "shared_place");

  assert.equal(placeNoteSubjectKey("place", "abc"), "place:abc");
  assert.equal(placeNoteSubjectKey("shared_place", "abc"), "shared_place:abc");
  // One key space for both kinds, so a place and a venue that somehow shared an id cannot collide.
  assert.notEqual(placeNoteSubjectKey("place", "abc"), placeNoteSubjectKey("shared_place", "abc"));
}

// ── 2 · Only his team, and the scope cannot fail open ──────────────────────────────────────────

function checkTeamScope(): void {
  const access = read("src/lib/phoenix-crm/server/access.ts");

  // The tier set is the district manager, acting or not — and nobody else below the Super Admin.
  const tiers = /const TEAM_PLACE_CHECKS_TIERS = new Set\(\[([^\]]*)\]\)/.exec(access);
  assert.ok(tiers, "the team Place checks tiers are declared as one Set");
  const named = [...tiers[1].matchAll(/"([A-Z_]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(named, ["ACTING_DM", "DM"], "a district manager and an acting one, and no third tier without his word");

  const reads = functionBody(access, "readsTeamPlaceChecks");
  assert.match(reads, /TEAM_PLACE_CHECKS_TIERS\.has\(seat\.tier\)/, "it reads that set");
  assert.ok(
    !/readsPlaceVsActual|readsTeamReports/.test(reads),
    "and it is NOT the place-vs-actual predicate, which also admits the NSM and the SFE Manager — widening sight into this module is the mistake the three tiers exist to prevent",
  );

  // An acting DM's own rep seat is subtracted: his own captures are not evidence he reads about himself.
  const seats = functionBody(access, "teamPlaceChecksSeats");
  assert.match(seats, /!isLocationBlind\(viewer, seat\)/, "a seat he is blind on is not in his own board");

  // 🔴 THE SCOPE THROWS. An empty array would be served to PostgREST as `.in("seat_id", [])`, which
  // answers ZERO ROWS WITH NO ERROR — an empty board for somebody who may not open it.
  const scope = functionBody(access, "placeChecksSeatScope");
  assert.match(scope, /if \(canDecideValidationReviews\(viewer\)\) return null/, "the Super Admin reads the company");
  assert.match(scope, /if \(seats\.length === 0\) throw forbiddenError\(/, "and anybody with no team of his own is REFUSED, never served an empty list");
  assert.ok(scope.indexOf("return null") < scope.indexOf("seats.length === 0"), "the company branch is answered before the team one is measured");

  // All four section reads narrow on the server. A browser-side filter over a company-wide payload
  // would be the same screen and a disclosure of every other district.
  const reviews = read("src/lib/phoenix-crm/server/validation-reviews.ts");
  const shared = read("src/lib/phoenix-crm/server/shared-places.ts");
  for (const [name, source] of [
    ["loadValidationReviews", reviews],
    ["loadValidatedPlaces", reviews],
    ["loadReopenedCustomers", reviews],
    ["loadSharedPlaceBoard", shared],
  ] as const) {
    const body = functionBody(source, name);
    assert.match(body, /const seats = placeChecksSeatScope\(viewer\)/, `${name} resolves the seat scope`);
    // Through `seatScoped`, which is where the scope's size is checked against the `.in()` cliff —
    // never spelled inline, where nothing would check it. `tests/phoenix-crm-place-checks-in-overflow`
    // owns that bound; what matters here is that the narrowing happens in the QUERY and not after it.
    assert.match(body, /return seatScoped\(query, seats\)/, `${name} narrows the QUERY to those seats`);
  }
}

// ── 3 · He decides nothing, and his screen does not say who does ───────────────────────────────

function checkHeDecidesNothing(): void {
  const reviews = read("src/lib/phoenix-crm/server/validation-reviews.ts");
  for (const name of ["decideValidationReview", "refuseValidatedPlace", "restoreValidation"]) {
    const body = functionBody(reviews, name);
    assert.match(body, /if \(!canDecideValidationReviews\(viewer\)\) throw forbiddenError/, `${name} is still the Super Admin's alone`);
  }

  const notes = read("src/lib/phoenix-crm/server/place-notes.ts");
  for (const name of ["savePlaceNote", "savePlaceRecommendation"]) {
    const body = functionBody(notes, name);
    assert.ok(
      !/phoenix_crm_validation_reviews|status: "retired"|reopen/i.test(body),
      `${name} touches no review row, no place status and no reopening — it records an opinion`,
    );
  }

  // The board's own switch, and the three lists that honour it.
  const board = read("src/components/phoenix-crm/validation-reviews-board.tsx");
  assert.match(board, /const team = mode === "team"/, "the board derives one flag for every sentence that names a decision");
  assert.match(board, /team \? `Still being checked/, "a manager reads 'Still being checked', never 'Waiting for your decision'");
  // Every sentence that names a decision sits inside that ternary — never drawn unconditionally.
  for (const line of board.split("\n")) {
    if (!/Waiting for your decision|Decided in the last/.test(line)) continue;
    assert.match(line, /team \?|: team/, `a decision-naming sentence is drawn unconditionally: ${line.trim()}`);
  }

  for (const [path, control] of [
    ["src/components/phoenix-crm/validated-place-list.tsx", "Refuse"],
    ["src/components/phoenix-crm/shared-place-list.tsx", "Decision"],
  ] as const) {
    const list = read(path);
    assert.match(
      list,
      new RegExp(`mode === "team" \\? null : <${control} row=\\{row\\}[^>]*/>`),
      `${path} renders no ${control} control for a manager`,
    );
  }

  // The queue keeps a settled state for him, and it names nobody and carries no note.
  const queue = read("src/components/phoenix-crm/validation-review-queue.tsx");
  const settled = /function Settled\(\{ row \}: \{ row: ValidationReviewRow \}\) \{[\s\S]*?\n\}/.exec(queue);
  assert.ok(settled, "the manager's settled display is its own component");
  assert.ok(!settled[0].includes("decidedByName"), "it never names who decided");
  assert.ok(!settled[0].includes("decisionNote"), "and never carries the decision note");
  assert.ok(!settled[0].includes("Restore"), "and offers no way to take a decision back");
  assert.match(queue, /mode === "team" \? <Settled row=\{row\} \/> : <Decision row=\{row\} \/>/, "one switch, both modes, in one place");

  // 🔴 NOT A WORD ABOUT WHO DECIDES, anywhere a manager can read. The owner's instruction was
  // "don't show this on the screen", so this sweeps the strings a well-meaning edit would add. The
  // files are read with their comments stripped: their own prose quotes the very sentences this
  // forbids, which is exactly the trap `stripComments` exists for.
  for (const path of ["app/employee-portals/place-checks/page.tsx", "src/components/phoenix-crm/place-check-notes.tsx"]) {
    const source = read(path).toLowerCase();
    for (const forbidden of [
      "waiting for approval",
      "pending approval",
      "system administrator will",
      "sent to the administrator",
      "only a recommendation",
      "awaiting a decision",
    ]) {
      assert.ok(!source.includes(forbidden), `${path} never renders "${forbidden}"`);
    }
  }
}

// ── 4 · The visibility is chosen, never defaulted ──────────────────────────────────────────────

function checkVisibilityIsChosen(): void {
  const migration = stripSqlComments(sourceOf("supabase/migrations/20261013163000_phoenix_crm_place_notes.sql"));
  assert.match(migration, /rep_visible boolean not null,/, "rep_visible is NOT NULL with NO DEFAULT — a comment cannot be saved without saying which it is");
  assert.ok(!/rep_visible boolean not null default/.test(migration), "and no default was added later as a convenience");

  // The wire limit and the column's CHECK are the same number, or a comment the database refuses comes
  // back as a 500 rather than as the sentence the writer can act on.
  assert.ok(migration.includes(`length(body) <= ${PLACE_NOTE_MAX_LENGTH}`), `the table caps the body at ${PLACE_NOTE_MAX_LENGTH}, as the rules file does`);

  // Exactly one subject, with a real FK to each of the two tables it can point at.
  assert.match(migration, /place_id uuid references public\.phoenix_crm_places\(id\) on delete cascade/, "a place note has a real FK");
  assert.match(migration, /shared_place_id uuid references public\.phoenix_crm_shared_places\(id\) on delete cascade/, "and so does a venue note");
  assert.match(
    migration,
    /check \(\(place_id is not null\)::int \+ \(shared_place_id is not null\)::int = 1\)/,
    "and exactly one of the two is set",
  );

  // The rep's own index serves the visible notes only — the ones he may not read are the majority.
  assert.match(migration, /phoenix_crm_place_notes_rep_idx[\s\S]*?where rep_visible/, "his read has a partial index on rep_visible");

  // 🔴 THE TWO UNIQUE INDEXES ARE NOT PARTIAL. Postgres infers a PARTIAL index for ON CONFLICT only
  // when the inference specification repeats the predicate, and PostgREST's `on_conflict=` emits bare
  // column names — so `where place_id is not null` here would fail every recommendation save.
  const unique = [...migration.matchAll(/create unique index if not exists (phoenix_crm_place_recs_\w+)([\s\S]*?);/g)];
  assert.equal(unique.length, 2, "one unique index per subject kind");
  for (const [, name, declaration] of unique) {
    assert.ok(!/where/i.test(declaration), `${name} is NOT partial — PostgREST's upsert cannot infer a partial index`);
    assert.match(declaration, /manager_hr_id\)/, `${name} holds one recommendation per manager`);
  }

  // Service side: a missing or non-boolean choice is refused before anything is written.
  const save = functionBody(read("src/lib/phoenix-crm/server/place-notes.ts"), "savePlaceNote");
  assert.match(save, /if \(typeof body\.repVisible !== "boolean"\) throw validationError\(/, "the choice is required on the wire");
  const refused = save.indexOf('body.repVisible !== "boolean"');
  const inserted = save.indexOf(".insert(");
  assert.ok(refused > -1 && inserted > refused, "and it is refused BEFORE the insert");

  // Screen side: the two buttons are the only way to save, and neither is pre-selected.
  const box = read("src/components/phoenix-crm/place-check-notes.tsx");
  assert.match(box, /onClick=\{\(\) => void save\(true\)\}/, "one button saves it visible");
  assert.match(box, /onClick=\{\(\) => void save\(false\)\}/, "the other saves it hidden");
  assert.ok(!/repVisible = (true|false)/.test(box), "neither side is pre-chosen for him");
  assert.ok(box.includes("Visible to medical rep") && box.includes("Not visible to medical rep"), "in the owner's own words for the two buttons");
}

// ── 5 · The rep's side: filtered in the query, and silent ──────────────────────────────────────

function checkRepSideIsFilteredAndSilent(): void {
  const notes = read("src/lib/phoenix-crm/server/place-notes.ts");
  const load = functionBody(notes, "loadRepVisiblePlaceNotes");

  // 🔴 IN THE QUERY. A field a browser receives counts as shown even when React draws nothing from
  // it (audit, 2026-10-02), so a note he may not read must never be in the payload at all.
  assert.match(load, /\.eq\("rep_visible", true\)/, "the rep's read filters rep_visible in the QUERY");
  assert.ok(!/\.filter\(/.test(load.split('.eq("rep_visible", true)')[1] ?? ""), "not in a pass over the rows afterwards");
  assert.match(load, /\.eq\("seat_id", seatId\)/, "his own territory only");
  assert.match(load, /\.eq\("is_test", isTest\)/, "and his own world");
  assert.match(load, /placeNoteRepAuthorText\(source\)/, "the author is rendered through the ROLE wording, never assembled here");
  assert.ok(!/author_hr_id|loadPeopleNames|nameOf\(/.test(load), "and no name or hr id is read for him at all");

  // The row type he receives has no name field to leak.
  const repType = /export type RepPlaceNote = \{[^}]*\}/.exec(notes);
  assert.ok(repType, "RepPlaceNote is declared");
  const fields = repType[0].replace("authorText", "");
  assert.ok(!/\bname\b|hrId|authorLabel|recommend/i.test(fields), `RepPlaceNote carries no name and no recommendation: ${repType[0]}`);

  // 🔴 NOTHING IS SENT. The owner chose silence on 2026-10-13: no bell, no Telegram, no email.
  assert.ok(
    !/notifyPhoenixCrm|createSystemNotification|sendPhoenixEmail|telegram/i.test(notes),
    "place-notes.ts imports and calls no notifier at all — a bell about a place being checked is what golden rule #1 keeps off his phone",
  );
  // And the file says so where a later edit would add one, so the absence reads as a decision.
  assert.match(sourceOf("src/lib/phoenix-crm/server/place-notes.ts"), /NOTHING IS SENT/, "with the reason written beside the insert");

  // His own list carries them, and the card renders the role wording.
  const list = read("src/lib/phoenix-crm/server/list.ts");
  assert.match(list, /loadRepVisiblePlaceNotes\(seat\.seatId, isTest\)/, "the List loads them for the territory");
  assert.match(list, /notes: repNotes\.get\(customerId\) \?\? \[\]/, "and puts them on the customer's own row");
  const card = read("src/components/phoenix-crm/list-customer.tsx");
  assert.match(card, /customer\.notes\.map\(\(note\) => \(/, "the rep's customer card draws them");
  assert.match(card, /title=\{note\.authorText\}/, "headed by the ROLE that wrote it");
}

// ── 6 · The write gate, and the two routes ─────────────────────────────────────────────────────

function checkWriteGate(): void {
  const notes = read("src/lib/phoenix-crm/server/place-notes.ts");
  const subject = /async function subjectFor\([\s\S]*?\n\}/.exec(notes);
  assert.ok(subject, "the subject resolver is its own function");

  // 🔴 THE SEAT IS RE-READ FROM THE SUBJECT'S OWN ROW, never taken from the request: the screen knows
  // which team a row belongs to, and a screen is not an authority.
  assert.match(subject[0], /\.from\(table\)\.select\(columns\)\.eq\("id", id\)/, "it reads the place or the venue itself");
  assert.match(subject[0], /seatId: String\(row\.seat_id \?\? ""\)/, "and takes the seat from that row");
  assert.match(subject[0], /if \(canDecideValidationReviews\(viewer\)\) return \{ source: "system_admin", subject \}/, "the Super Admin writes as the administrator");
  assert.match(subject[0], /if \(!readsTeamPlaceChecks\(viewer\)\) throw forbiddenError/, "anybody who is not a district manager is refused");
  assert.match(
    subject[0],
    /if \(!mine\.has\(subject\.seatId\)\) throw forbiddenError\("This place belongs to another district\."\)/,
    "and a district manager only on his own seats",
  );

  for (const path of ["app/api/phoenix-crm/place-notes/route.ts", "app/api/phoenix-crm/place-notes/recommendation/route.ts"]) {
    const route = read(path);
    assert.match(route, /assertSameOriginMutation\(request\)/, `${path} is CSRF-guarded`);
    // 🔴 `approve`, NOT `update`: a District Manager holds phoenix_crm ["read", "create", "approve"]
    // and no `update` at all, so `update` would 403 the one person these routes exist for.
    assert.match(route, /assertPermission\(access, "phoenix_crm", "approve"\)/, `${path} gates on approve`);
    const gate = route.indexOf('assertPermission(access, "phoenix_crm", "approve")');
    const call = route.search(/await savePlace(Note|Recommendation)\(/);
    assert.ok(gate > -1 && call > gate, `${path} gates before it writes`);
  }

  // That permission claim is measured against the real matrix rather than trusted.
  const permissions = read("src/lib/auth/permissions.ts");
  const dm = /"District Manager": \{[\s\S]*?\n  \}/.exec(permissions);
  assert.ok(dm, "the District Manager's grants are declared");
  const crm = /phoenix_crm: \[([^\]]*)\]/.exec(dm[0]);
  assert.ok(crm, "with a phoenix_crm line");
  assert.ok(crm[1].includes('"approve"'), "which holds approve — the gate these routes use");
  assert.ok(!crm[1].includes('"update"'), "and NOT update, which is why the routes cannot ask for it");

  // Every route under app/api needs its registry declaration, or the required validate job goes red.
  const registry = read("src/lib/security/access-registry.ts");
  for (const pattern of ["/api/phoenix-crm/place-notes", "/api/phoenix-crm/place-notes/recommendation"]) {
    assert.ok(registry.includes(`pattern: "${pattern}"`), `${pattern} is declared in the access registry`);
  }
}

// ── 7 · The tab itself ─────────────────────────────────────────────────────────────────────────

function checkTheTab(): void {
  const page = read("app/employee-portals/place-checks/page.tsx");
  assert.match(page, /if \(!viewer \|\| !readsTeamPlaceChecks\(viewer\)\) redirect\("\/employee-portals"\)/, "the page gates on the same predicate as the row");
  assert.match(page, /mode="team"/, "and renders the shared board in team mode");
  assert.ok(!/canDecideValidationReviews|decideValidationReview|refuseValidatedPlace/.test(page), "it imports no decision path at all");

  // One gate, asked of the module, never a second role list in the navigation helper.
  const crmPage = read("src/lib/phoenix-crm/server/sidebar-entries.ts");
  assert.match(crmPage, /placeChecks: readsTeamPlaceChecks\(viewer\)/, "the sidebar row asks the page's own predicate");
  assert.match(
    crmPage,
    /export const NO_PHOENIX_CRM_ENTRIES: PhoenixCrmSidebarEntries = \{\s*crm: false,\s*forecast: false,\s*placeChecks: false,\s*doubleVisitRequests: false,\s*managerPlans: false,?\s*\}/,
    "and a failed lookup offers no row",
  );

  const nav = read("src/lib/employee-portal/navigation.ts");
  assert.match(nav, /showTeamPlaceChecksTab: hasTeamPlaceChecks === true/, "the flag is the module's answer");
  const flag = /showTeamPlaceChecksTab: ([^,\n]*)/.exec(nav);
  assert.ok(flag && !/resolvedRole|isDistrictManager|role ===/.test(flag[1]), "never a role test here, which would drift from the page's gate");

  const layout = read("src/components/employee-portal/employee-portal-layout.tsx");
  assert.match(layout, /showTeamPlaceChecksTab \? \[\{ href: "\/employee-portals\/place-checks", label: "Place checks"/, "the sidebar row exists");
  // The Phoenix CRM row is the sidebar's ONE standout (owner, 2026-09-30) — a second one and neither is.
  assert.equal([...layout.matchAll(/highlight: true as const/g)].length, 1, "exactly one sidebar row carries `highlight`, and it is not this one");
  const placeChecksRow = /showTeamPlaceChecksTab \? \[\{[^}]*\}\]/.exec(layout);
  assert.ok(placeChecksRow && !placeChecksRow[0].includes("highlight"), "Place checks is not highlighted");

  // The registry the command palette and the collapsed rail read.
  const registry = read("src/components/employee-portal/employee-portal-nav-registry.ts");
  assert.match(registry, /href: "\/employee-portals\/place-checks"[^}]*flags: \["showTeamPlaceChecksTab"\]/, "and the nav registry knows it");
}

// ── 8 · The device evidence he now reads, and the three walls around it ────────────────────────

function checkDeviceEvidence(): void {
  const board = read("src/lib/phoenix-crm/server/integrity-board.ts");

  // 🔴 THE READ IS IN THE EVIDENCE MODULE, by its own header's rule: anything selecting `lat`, `lon`,
  // `signals`, `device_mocked` or the labels belongs there, behind that file's audience check.
  const load = functionBody(board, "loadPlaceCheckIntegrity");
  assert.match(load, /const seats = placeChecksSeatScope\(viewer\)/, "its audience is the board's own predicate, not a second copy");
  assert.match(load, /\.from\("phoenix_crm_location_integrity"\)|"phoenix_crm_location_integrity",/, "it reads the evidence table");
  assert.match(load, /if \(allowed && !allowed\.has\(String\(row\.seat_id \?\? ""\)\)\) continue/, "and a case on another district's place is dropped on the server");
  assert.match(load, /placeNoteSubjectKey\(/, "keyed by the notes index's own key, so the two can never drift");
  assert.ok(
    !/subject_kind", "visit"|kind === "visit"/.test(load),
    "a VISIT case is about a day's movement, not about this place — the board judges places",
  );

  // Nobody else reads the table. place-notes.ts carries the result and names it nowhere.
  const notes = read("src/lib/phoenix-crm/server/place-notes.ts");
  assert.ok(!notes.includes("phoenix_crm_location_integrity"), "place-notes.ts never names the evidence table");
  assert.match(notes, /integrity: PlaceCheckIntegrityIndex/, "the index carries the loaded result");

  // 🔴 `view-types.ts` IS THE WIRE THE PHONE READS and may not reach the evidence module at all —
  // which is why the view type lives in the pure rules module instead.
  const wire = read("src/lib/phoenix-crm/view-types.ts");
  assert.ok(!wire.includes("integrity-board"), "view-types.ts never reaches server/integrity-board");
  const rules = read("src/lib/phoenix-crm/place-note-rules.ts");
  assert.match(rules, /export type PlaceCheckIntegrityView = \{/, "the shape is in the pure module");
  assert.ok(!rules.includes("integrity-board") && !rules.includes("location-integrity"), "and it names no evidence module");

  // 🔴 THE SCREEN FORMATS NOTHING. It sits in the rep's own bundle directory, so every sentence is
  // built on the server beside the evidence and the component only prints it.
  const box = read("src/components/phoenix-crm/place-check-notes.tsx");
  assert.match(box, /\{row\.deviceText\}/, "the phone's own answer arrives in words");
  assert.match(box, /\{row\.noticedText\}/, "and so does when it was noticed");
  // The sentences themselves are the server's, never this file's — `tests/phoenix-crm-blind-half.test.ts`
  // refuses a silent word in a literal anywhere under `src/components/phoenix-crm/`, and that refusal is
  // what keeps a wording change from walking into the rep's own bundle.
  for (const sentence of ["mock location", "Noticed ", "m of accuracy", "Settled by"]) {
    assert.ok(!box.includes(sentence), `the screen never writes "${sentence}" — that sentence is built beside the evidence`);
  }
  // Drawn in BOTH modes: the audience was decided once, on the server.
  const evidenceStart = box.indexOf("function Evidence(");
  assert.notEqual(evidenceStart, -1, "the evidence block is its own component");
  const evidence = box.slice(evidenceStart, box.indexOf("function Recommendations(", evidenceStart));
  assert.ok(evidence.length > 200, "and the slice really holds it");
  assert.ok(!evidence.includes("mode"), "and it has no mode branch at all");
  assert.match(box, /<Evidence cases=\{integrity\} \/>/, "the shared control draws it for both boards");

  // 🔴 AND THE REP STILL READS NONE OF IT. Nothing about a case reaches his list or his card.
  for (const path of ["src/lib/phoenix-crm/server/list.ts", "src/components/phoenix-crm/list-customer.tsx"]) {
    const source = read(path);
    assert.ok(!source.includes("loadPlaceCheckIntegrity"), `${path} loads no case`);
    assert.ok(!source.includes("phoenix_crm_location_integrity"), `${path} names no evidence table`);
    assert.ok(!/integrity-board/.test(source), `${path} never reaches the evidence module`);
  }

  // The two tables are declared in the module's own migration registry, with their policies.
  const migration = stripSqlComments(sourceOf("supabase/migrations/20261013163000_phoenix_crm_place_notes.sql"));
  for (const table of ["phoenix_crm_place_notes", "phoenix_crm_place_recommendations"]) {
    assert.match(migration, new RegExp(`create policy ${table}_service_role`), `${table} is locked to the service role`);
  }
  assert.match(migration, /notify pgrst, 'reload schema';/, "and PostgREST is told, or it answers PGRST205 about a brand-new table");
}

export function runPhoenixCrmPlaceNotesTests(): void {
  checkRepWording();
  checkTeamScope();
  checkHeDecidesNothing();
  checkVisibilityIsChosen();
  checkRepSideIsFilteredAndSilent();
  checkWriteGate();
  checkTheTab();
  checkDeviceEvidence();
}
