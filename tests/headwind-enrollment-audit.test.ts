/**
 * The Headwind enrollment code audit (9 Nov 2026) — the QR a new rep tablet scans.
 *
 * Two findings drove it. F1: one saved code served three sets of rules, so a tablet enrolled from the
 * page landed on whichever line that one code belonged to and never got its own line app. F2: a pasted
 * code was checked for its hosts only, so an http address (a redirect a tablet will not follow), a
 * fixed device number (every tablet claiming one number), another line's code, or a dead download link
 * (a first run that stalls before the hardware report) were all saved and shown as good.
 *
 * Each section is exported on its own so a break-test can show that section's own assertion firing.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  checkHeadwindAgentDownload,
  enrollmentConfigurationId,
  HeadwindEnrollmentError,
  parseHeadwindEnrollmentTemplate,
  pickEnrollmentRow,
  planHeadwindEnrollmentCards,
  type HeadwindEnrollmentRow,
} from "../src/lib/devices/headwind/enrollment.ts";
import { stripComments } from "./support/comment-strip.ts";

function source(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}

const EXTRAS = "android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE";
const DOWNLOAD = "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION";

const PEDIA = "Rep tablets — Pedia";
const ANTI_INFECTIVE = "Rep tablets — Anti Infective";

function code(overrides: { extras?: Record<string, unknown>; download?: string } = {}): Record<string, unknown> {
  return {
    [EXTRAS]: {
      "com.hmdm.BASE_URL": "https://mdm.satopharma.com",
      "com.hmdm.CONFIG": PEDIA,
      "com.hmdm.SERVER_PROJECT": "",
      ...overrides.extras,
    },
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME": "com.hmdm.launcher/.AdminReceiver",
    [DOWNLOAD]: overrides.download ?? "https://mdm.satopharma.com/files/hmdm-6.48-os.apk",
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM": "gJD2YwtOiWJHkSMkkIfLRlj-quNqG1fb6v100QmzM9w=",
  };
}

function refuses(raw: unknown, pattern: RegExp, because: string, expected?: string) {
  assert.throws(
    () => parseHeadwindEnrollmentTemplate(JSON.stringify(raw), { configurationName: expected }),
    (error: unknown) => error instanceof HeadwindEnrollmentError && pattern.test(error.message),
    because,
  );
}

/** F2 — an http agent link is a redirect, and a tablet will not follow one (§8.18). */
export function runPlainHttpDownloadRefusedTest() {
  refuses(
    code({ download: "http://mdm.satopharma.com/files/hmdm-6.48-os.apk" }),
    /agent download link in this code \(mdm\.satopharma\.com\/files\/hmdm-6\.48-os\.apk\) is not https:\/\/.*does not follow a redirect/,
    "F2: an http:// agent download link is refused, naming the link and the redirect",
  );
}

/** F2 — an http server address loses every report a tablet sends. */
export function runPlainHttpServerRefusedTest() {
  refuses(
    code({ extras: { "com.hmdm.BASE_URL": "http://mdm.satopharma.com" } }),
    /server address in this code \(mdm\.satopharma\.com\) is not https:\/\//,
    "F2: an http:// server address is refused",
  );
}

/** F2 — a fixed device number makes every tablet that scans the code claim that one number. */
export function runFixedDeviceNumberRefusedTest() {
  refuses(
    code({ extras: { "com.hmdm.DEVICE_ID": "PHX-TAB-0010" } }),
    /made for one device number \(com\.hmdm\.DEVICE_ID\)/,
    "F2: a code carrying com.hmdm.DEVICE_ID is refused",
  );
  refuses(
    code({ extras: { "com.hmdm.DEVICE_ID": 10 } }),
    /made for one device number/,
    "F2: a numeric device number is refused the same way",
  );
  // An empty one claims nothing, so it is not a reason to refuse an otherwise good code.
  assert.doesNotThrow(
    () => parseHeadwindEnrollmentTemplate(JSON.stringify(code({ extras: { "com.hmdm.DEVICE_ID": "" } }))),
    "an empty device number claims no number",
  );
}

/** F1/F2 — a code naming another set of rules is refused for this one. */
export function runWrongConfigurationRefusedTest() {
  refuses(
    code(),
    /This code is for "Rep tablets — Pedia", not "Rep tablets — Anti Infective"/,
    "F1: the Pedia code cannot be saved as the Anti-Infective code",
    ANTI_INFECTIVE,
  );
  assert.equal(
    parseHeadwindEnrollmentTemplate(JSON.stringify(code()), { configurationName: PEDIA }).facts.configurationName,
    PEDIA,
    "the Pedia code saves as the Pedia code",
  );
  // A code that names no set of rules is not a contradiction; the page says "No rules named".
  const unnamed = code();
  delete (unnamed[EXTRAS] as Record<string, unknown>)["com.hmdm.CONFIG"];
  assert.doesNotThrow(
    () => parseHeadwindEnrollmentTemplate(JSON.stringify(unnamed), { configurationName: ANTI_INFECTIVE }),
    "a code that names no rules is not refused for naming the wrong ones",
  );
}

/** F2 — the link's path is shown beside its host, and its query never travels. */
export function runDownloadPathShownTest() {
  const parsed = parseHeadwindEnrollmentTemplate(
    JSON.stringify(code({ download: "https://mdm.satopharma.com/files/hmdm-6.48-os.apk?token=s3cret" })),
  );
  assert.equal(parsed.facts.downloadHost, "mdm.satopharma.com");
  assert.equal(parsed.facts.downloadPath, "/files/hmdm-6.48-os.apk", "F2: the facts carry the link's path");
  assert.doesNotMatch(JSON.stringify(parsed.facts), /s3cret/, "and never its query, which can carry a token");
  assert.equal(
    parsed.downloadUrl,
    "https://mdm.satopharma.com/files/hmdm-6.48-os.apk?token=s3cret",
    "the check is handed the whole link",
  );
}

type StubAnswer = number | Error;

function stubFetch(answers: StubAnswer[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queue = [...answers];
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    calls.push({ init, url: String(input) });
    const answer = queue.shift();
    if (answer === undefined) throw new Error("stub fetch ran out of answers");
    if (answer instanceof Error) throw answer;
    return { body: null, ok: answer >= 200 && answer < 300, status: answer } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchImpl };
}

const LINK = "https://mdm.satopharma.com/files/hmdm-6.48-os.apk?token=s3cret";

async function linkRefused(answers: StubAnswer[], pattern: RegExp, because: string) {
  const stub = stubFetch(answers);
  await assert.rejects(
    checkHeadwindAgentDownload(LINK, stub.fetch),
    (error: unknown) =>
      error instanceof HeadwindEnrollmentError && pattern.test(error.message) && !/s3cret/.test(error.message),
    because,
  );
  return stub;
}

/** F2 — the link is checked with a HEAD that does NOT follow redirects, and only 200 passes. */
export async function runDownloadHeadIsManualTest() {
  const stub = stubFetch([200]);
  await checkHeadwindAgentDownload(LINK, stub.fetch);
  assert.equal(stub.calls.length, 1, "a 200 to the HEAD is the whole check");
  assert.equal(stub.calls[0].init.method, "HEAD");
  assert.equal(stub.calls[0].init.redirect, "manual", "F2: the check never follows a redirect, as a tablet never does");
  assert.ok(stub.calls[0].init.signal instanceof AbortSignal, "and it has a deadline");
}

/** F2 — a redirect is a dead link to a tablet. */
export async function runDownloadRedirectRefusedTest() {
  await linkRefused([301], /answers 301, a redirect\. A tablet does not follow a redirect/, "F2: a 301 link is refused");
  await linkRefused([302], /answers 302, a redirect/, "and a 302");
}

/** F2 — a missing file stalls the first run before the hardware report. */
export async function runDownloadMissingRefusedTest() {
  await linkRefused([404], /answers 404 instead of the file/, "F2: a 404 link is refused");
  await linkRefused([204], /answers 204 instead of the file/, "F2: only exactly 200 passes the HEAD, not any 2xx");
  await linkRefused(
    [Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })],
    /could not be reached from Phoenix: ENOTFOUND/,
    "F2: an unreachable host is refused in words, not passed",
  );
}

/** F2 — a host that refuses HEAD is asked for one byte instead. */
export async function runDownloadRangeFallbackTest() {
  const stub = stubFetch([405, 206]);
  await checkHeadwindAgentDownload(LINK, stub.fetch);
  assert.equal(stub.calls.length, 2, "F2: a refused HEAD falls back to a one-byte GET");
  assert.equal(stub.calls[1].init.method, "GET");
  assert.deepEqual(stub.calls[1].init.headers, { range: "bytes=0-0" }, "asking for one byte only");
  assert.equal(stub.calls[1].init.redirect, "manual", "and still not following a redirect");
  await linkRefused([405, 301], /answers 301, a redirect/, "a redirect behind the fallback is still refused");
}

/** F1 — the route's configuration must be a real positive id, in words when it is not. */
export function runConfigurationIdTest() {
  assert.equal(enrollmentConfigurationId(4), 4);
  assert.equal(enrollmentConfigurationId("5"), 5);
  for (const bad of [undefined, null, 0, -3, 1.5, "abc", "", "4; drop", [], {}]) {
    assert.throws(
      () => enrollmentConfigurationId(bad),
      (error: unknown) => error instanceof HeadwindEnrollmentError && /Choose which set of tablet rules/.test(error.message),
      `F1: ${JSON.stringify(bad)} is not a set of rules`,
    );
  }
}

function row(overrides: Partial<HeadwindEnrollmentRow> & { id: number }): HeadwindEnrollmentRow {
  return {
    configuration_id: null,
    configuration_name: null,
    qr_payload: JSON.stringify(code({ extras: { "com.hmdm.CONFIG": "Rep tablets" } })),
    template_name: null,
    updated_at: "2026-10-11T08:00:00Z",
    updated_by: "B-10",
    ...overrides,
  };
}

const SERVER = [
  { id: 1, name: "Managed Launcher" },
  { id: 3, name: "Rep tablets" },
  { id: 4, name: ANTI_INFECTIVE },
  { id: 5, name: PEDIA },
];

/** F1 — one card per set of rules, each with its own code; the old single code only where it belongs. */
export function runOneCodePerConfigurationTest() {
  const legacy = row({ id: 1 });
  const pedia = row({ configuration_id: 5, id: 2, qr_payload: JSON.stringify(code()) });
  const plan = planHeadwindEnrollmentCards(SERVER, [legacy, pedia]);

  assert.deepEqual(
    plan.cards.map((card) => [card.configurationId, card.configurationName, card.row?.id ?? null, card.legacy]),
    [
      [3, "Rep tablets", 1, true],
      [4, ANTI_INFECTIVE, null, false],
      [5, PEDIA, 2, false],
    ],
    "F1: a card for each copy of Rep tablets, none for the other rules, and each holds only its own code",
  );
  assert.equal(plan.unassigned, null, "the old code went on the card of the rules it names");

  // 🔴 THE FINDING ITSELF: the one old code is never offered for another line's rules.
  assert.equal(pickEnrollmentRow({ id: 4, name: ANTI_INFECTIVE }, [legacy, pedia]), null, "F1: the Anti-Infective rules do not borrow the old Rep tablets code");
  assert.equal(pickEnrollmentRow({ id: 5, name: PEDIA }, [legacy, pedia])?.row.id, 2, "and Pedia reads its own row");

  // The old code is superseded once its rules have their own, and set aside when it names none.
  const own3 = row({ configuration_id: 3, id: 3 });
  assert.equal(planHeadwindEnrollmentCards(SERVER, [legacy, own3]).cards[0].row?.id, 3, "a set's own code beats the old one");
  assert.equal(planHeadwindEnrollmentCards(SERVER, [legacy, own3]).unassigned, null, "and the superseded old one is not shown twice");
  const nameless = row({ id: 1, qr_payload: JSON.stringify(code({ extras: { "com.hmdm.CONFIG": "Reps" } })) });
  const set = planHeadwindEnrollmentCards(SERVER, [nameless]);
  assert.equal(set.unassigned?.id, 1, "an old code naming no rules on the server is set aside, not guessed onto a card");
  assert.ok(set.cards.every((card) => card.row === null), "and no card carries it");

  // A code whose rules left the server is still named, never shown as a number, and never offered.
  const gone = planHeadwindEnrollmentCards(SERVER, [row({ configuration_id: 9, configuration_name: "Rep tablets — CNS", id: 4 })]);
  const cns = gone.cards.find((card) => card.configurationId === 9);
  assert.equal(cns?.onServer, false, "a code for rules no longer on the server is marked so");
  assert.equal(cns?.configurationName, "Rep tablets — CNS", "and named by the name it was saved under");
}

/** F1/F2 — save and reveal are aimed at one set of rules, checked, and audited without the code. */
export function runSaveAndRevealSourceTest() {
  const lib = stripComments(source("src/lib/devices/headwind/enrollment.ts"));
  const body = (name: string) => {
    const start = lib.indexOf(`export async function ${name}`);
    assert.ok(start >= 0, `${name} exists`);
    const next = lib.indexOf("\nexport ", start + 10);
    return lib.slice(start, next === -1 ? undefined : next);
  };

  const save = body("saveHeadwindEnrollmentTemplate");
  assert.match(save, /parseHeadwindEnrollmentTemplate\(input\.raw, \{\s*configurationName: configuration\.name,?\s*\}\)/, "F1: a code is parsed against the rules it is saved for");
  assert.ok(
    save.indexOf("checkHeadwindAgentDownload(") > 0 && save.indexOf("checkHeadwindAgentDownload(") < save.indexOf(".upsert("),
    "F2: the download link is checked BEFORE the code is saved",
  );
  assert.match(save, /\{ onConflict: "configuration_id" \}/, "F1: one saved code per set of rules");
  assert.match(save, /configuration_id: configuration\.id/, "and the row says which set");
  assert.doesNotMatch(lib, /\.eq\("id", 1\)/, "F1: nothing reads the single fleet-wide row by its id any more");

  const reveal = body("revealHeadwindEnrollmentQr");
  assert.match(reveal, /pickEnrollmentRow\(configuration,/, "F1: a reveal reads only that set's code");
  assert.match(reveal, /parseHeadwindEnrollmentTemplate\(picked\.row\.qr_payload, \{ configurationName: configuration\.name \}\)/, "F2: the stored code is re-checked before it is shown");
  const check = reveal.indexOf("checkHeadwindAgentDownload(");
  const audit = reveal.indexOf("writeRequiredAuditLog(");
  const handed = reveal.lastIndexOf("return {");
  assert.ok(check > 0 && check < audit && audit < handed, "F2: link checked, then the look audited, then the code handed back");

  for (const block of lib.match(/newValues: \{[^}]*\}/g) ?? []) {
    assert.doesNotMatch(block, /payload|qr_payload|raw|downloadUrl/, "no audit row carries the code or the whole link");
  }
  assert.match(reveal, /newValues: \{[^}]*configurationId: configuration\.id/, "F1: the look is audited per set of rules");
  assert.match(save, /newValues: \{[^}]*configurationId: configuration\.id/, "and so is the save");
  assert.match(save, /entityId: `headwind-enrollment-template:\$\{configuration\.id\}`/, "each set's audit trail is its own");

  // A failed read of the rules or the codes is never turned into "no code saved".
  const state = body("getHeadwindEnrollmentState");
  assert.doesNotMatch(state, /catch/, "the page load does not swallow a failed read into an empty answer");
}

/** The route: CSRF, then the caller, then the permission, then the body — and the body is checked. */
export function runRouteOrderTest() {
  const route = stripComments(source("app/api/devices/headwind/enrollment/route.ts"));
  const post = route.slice(route.indexOf("export async function POST"));
  const at = (needle: string) => post.indexOf(needle);
  assert.ok(
    at("assertSameOriginMutation(request)") < at("resolveAccessContext(request)") &&
      at("resolveAccessContext(request)") < at('assertPermission(access, "company_devices", "approve")') &&
      at('assertPermission(access, "company_devices", "approve")') < at("request.json()"),
    "CSRF, then who is asking, then the permission, before the body is read",
  );
  assert.match(post, /body && typeof body === "object" && !Array\.isArray\(body\)/, "a null or list body is refused in words, not a 500");
  assert.ok(at("enrollmentConfigurationId(payload.configurationId)") < at("payload.show === true"), "F1: both the reveal and the save name their set of rules");
  assert.match(post, /revealHeadwindEnrollmentQr\(configurationId, actor\)/);
  assert.match(post, /saveHeadwindEnrollmentTemplate\(\{ configurationId, raw, templateName \}, actor\)/);
}

/** F1 — the table holds one code per set of rules, the old row kept, access unchanged. */
export function runMigrationTest() {
  const name = "supabase/migrations/20261109030405_headwind_enrollment_code_per_configuration.sql";
  const sql = source(name).replace(/--[^\n]*/g, "");
  assert.match(sql, /add column if not exists configuration_id integer;/, "F1: each code names its set of rules");
  assert.match(sql, /add constraint headwind_enrollment_template_configuration_id_key unique \(configuration_id\);/, "and each set has one code");
  assert.match(sql, /drop constraint if exists headwind_enrollment_template_id_check;/, "the one-row rule is lifted");
  assert.match(sql, /nextval\('public\.headwind_enrollment_template_id_seq'\)/, "new rows take ids that never collide with the old row");
  assert.match(sql, /grant usage, select on sequence public\.headwind_enrollment_template_id_seq to service_role;/, "the server can insert");
  assert.match(sql, /enable row level security;/);
  assert.match(sql, /revoke all on public\.headwind_enrollment_template from anon, authenticated;/, "the browser roles still cannot reach a code");
  assert.doesNotMatch(sql, /\b(delete from|truncate|drop table|update public\.)/i, "the old row is kept as it is");
}

/** F1 — the page shows one card per set of rules, by name, each revealed and saved for its own set. */
export function runPageCardsTest() {
  const ui = stripComments(source("src/components/devices/headwind-enrollment.tsx"));
  assert.match(ui, /state\?\.cards\.map\(\(card\) => \(\s*<EnrollmentCodeCard card=\{card\} key=\{card\.configurationId\}/, "F1: one card per set of rules");
  assert.match(ui, /<h3[^>]*>\{configurationName\}<\/h3>/, "each card is headed by its set's name");
  assert.match(ui, /requestJson<EnrollmentCard>\(ENDPOINT, \{\s*configurationId,/, "a save names its set of rules");
  assert.match(ui, /\$\{summary\.downloadHost\}\$\{summary\.downloadPath \?\? ""\}/, "F2: the link's path is shown with its host");
  assert.match(ui, /const canShow = card\.onServer && summary\.saved && !summary\.problem;/, "a code that would be refused is not offered for scanning");
  assert.doesNotMatch(ui, />\s*\{(card\.)?configurationId\}/, "names, never ids, on the page");
}

export async function runHeadwindEnrollmentAuditTests() {
  runPlainHttpDownloadRefusedTest();
  runPlainHttpServerRefusedTest();
  runFixedDeviceNumberRefusedTest();
  runWrongConfigurationRefusedTest();
  runDownloadPathShownTest();
  await runDownloadHeadIsManualTest();
  await runDownloadRedirectRefusedTest();
  await runDownloadMissingRefusedTest();
  await runDownloadRangeFallbackTest();
  runConfigurationIdTest();
  runOneCodePerConfigurationTest();
  runSaveAndRevealSourceTest();
  runRouteOrderTest();
  runMigrationTest();
  runPageCardsTest();
}
