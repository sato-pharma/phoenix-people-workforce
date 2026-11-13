import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  INTEGRATIONS,
  INTEGRATION_CATEGORIES,
  WHATSAPP_GRAPH_API,
  WHATSAPP_GRAPH_API_VERSION_FILES,
  findIntegration,
  integrationConfiguration,
  type IntegrationEntry,
} from "../src/lib/integrations/registry.ts";
import { declaredJobSlugs } from "../src/lib/observability/job-schedule.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE INTEGRATIONS PAGE (integration audit, 13 Nov 2026: ISS-039, ISS-040, ISS-042, INT-063).
 *
 *   1  the registry is well formed: one id each, a known kind, and every scheduled job it names is declared
 *   2  "configured or not" is answered from variable NAMES; a marked value never comes back out
 *   3  the page is Super Admin only, and its gate runs before anything is read
 *   4  the loader reads times only, and a read that fails says "unavailable", never "none"
 *   5  the messaging API version is written in seven files; they agree with the registry, and there is no eighth
 *   6  the voice-transcription entry carries its data note
 *   7  the page is on the Admin Tools hub, for the Super Admin alone
 *   8  no page loads a typeface from a font service: the joining form's Arabic face is served from the app (ISS-043)
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const PAGE = "app/(admin)/admin/integrations/page.tsx";
const STATUS = "src/lib/integrations/status.ts";
const BOARD = "src/components/admin/integrations/integrations-board.tsx";

function namesOf(entry: IntegrationEntry): string[] {
  if (entry.credential.kind === "env") return [...new Set(entry.credential.anyOf.flat())];
  if (entry.credential.kind === "switch") return [entry.credential.name];
  return [];
}

function registryIsWellFormed() {
  const ids = INTEGRATIONS.map((entry) => entry.id);
  assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), [], "every integration has its own id");
  assert.ok(INTEGRATIONS.length >= 37, `the registry lists every outside service (37 since Google Fonts and the OpenStreetMap tiles left on 13 Nov 2026), found ${INTEGRATIONS.length}`);

  const declared = new Set(declaredJobSlugs());
  for (const entry of INTEGRATIONS) {
    assert.ok(INTEGRATION_CATEGORIES.includes(entry.category), `${entry.id}: "${entry.category}" is a listed kind`);
    for (const field of ["name", "provider", "usedFor"] as const) {
      assert.ok(entry[field].trim().length > 0, `${entry.id}: ${field} is filled in`);
    }
    assert.match(entry.usedFor, /\.$/, `${entry.id}: "used for" is a full sentence`);
    if (entry.credential.kind === "env") {
      assert.ok(entry.credential.anyOf.length > 0, `${entry.id}: names at least one set of variables`);
      for (const set of entry.credential.anyOf) {
        assert.ok(set.length > 0, `${entry.id}: no set of variables is empty, or it would always read as configured`);
        for (const name of set) assert.match(name, /^[A-Z][A-Z0-9_]+$/, `${entry.id}: ${name} is a variable NAME`);
      }
    }
    if (entry.health.kind === "heartbeat" && entry.health.slugs !== "*") {
      assert.ok(entry.health.slugs.length > 0, `${entry.id}: names at least one scheduled job`);
      for (const slug of entry.health.slugs) {
        assert.ok(declared.has(slug), `${entry.id}: the scheduled job "${slug}" is declared in JOB_SCHEDULES, or its row would say "none recorded" for ever`);
      }
    }
    if (entry.health.kind === "none") assert.ok(entry.health.why.trim().length > 0, `${entry.id}: says why nothing is recorded`);
  }
  // Every kind on the list is used; an empty block would be a heading over nothing.
  for (const category of INTEGRATION_CATEGORIES) {
    assert.ok(INTEGRATIONS.some((entry) => entry.category === category), `"${category}" holds at least one integration`);
  }
}

function configurationNeverReturnsAValue() {
  const MARK = "MARKED-VALUE-";
  for (const entry of INTEGRATIONS) {
    const names = namesOf(entry);
    const full = Object.fromEntries(names.map((name) => [name, `${MARK}${name}`]));
    const half = Object.fromEntries(names.slice(0, 1).map((name) => [name, `${MARK}${name}`]));
    for (const env of [full, half, {}]) {
      const answer = integrationConfiguration(entry, env);
      assert.ok(!JSON.stringify(answer).includes(MARK), `${entry.id}: a variable's VALUE came back out of integrationConfiguration`);
      for (const name of [...answer.names, ...answer.missing]) {
        assert.ok(names.includes(name), `${entry.id}: "${name}" is one of the entry's own variable names`);
      }
    }
    if (entry.credential.kind === "env") {
      assert.equal(integrationConfiguration(entry, full).state, "configured", `${entry.id}: every variable set reads as configured`);
      const none = integrationConfiguration(entry, {});
      assert.equal(none.state, "not-configured", `${entry.id}: nothing set reads as not configured`);
      assert.ok(none.missing.length > 0, `${entry.id}: not configured names what is missing`);
    }
  }

  const zoom = findIntegration("zoom");
  assert.ok(zoom && zoom.credential.kind === "env");
  const partly = integrationConfiguration(zoom, { ZOOM_ACCOUNT_ID: "a", ZOOM_CLIENT_ID: "b" });
  assert.equal(partly.state, "partly", "two of Zoom's four variables is partly set, never configured");
  assert.deepEqual(partly.missing, ["ZOOM_CLIENT_SECRET", "ZOOM_HOST_USER"]);

  // Either of two complete sets is enough.
  const anthropic = findIntegration("anthropic");
  assert.ok(anthropic);
  assert.equal(integrationConfiguration(anthropic, { ANTHROPIC_API_KEY_2: "k" }).state, "configured");

  // A value that is only blanks, or only a byte-order mark, is not set.
  const resend = findIntegration("resend");
  assert.ok(resend);
  assert.equal(integrationConfiguration(resend, { RESEND_API_KEY: "   " }).state, "not-configured");
  assert.equal(integrationConfiguration(resend, { RESEND_API_KEY: "﻿" }).state, "not-configured");

  // A kill switch is on unless it holds an off word.
  const metrics = findIntegration("supabase-host-metrics");
  assert.ok(metrics && metrics.credential.kind === "switch");
  assert.equal(integrationConfiguration(metrics, {}).state, "on");
  for (const word of ["off", "0", "false", " OFF "]) {
    assert.equal(integrationConfiguration(metrics, { [metrics.credential.name]: word }).state, "off", `"${word}" switches it off`);
  }

  // The three live sheets need all six of their variables: two of them is partly, with the other four named.
  const sheets = findIntegration("live-company-sheets");
  assert.ok(sheets);
  const oneSheet = integrationConfiguration(sheets, { SHEET_REFRESH_WEBHOOK_URL: "u", SHEET_REFRESH_WEBHOOK_SECRET: "s" });
  assert.equal(oneSheet.state, "partly", "one live sheet of three is partly set");
  assert.equal(oneSheet.missing.length, 4);
}

function pageIsSuperAdminOnlyAndGatedFirst() {
  const page = stripComments(read(PAGE));
  const guest = page.indexOf('redirect("/login")');
  const gate = page.indexOf("assertSystemAdministratorWorkspaceAccess(access");
  const bounce = page.indexOf('if (!allowed) redirect("/admin")');
  const load = page.indexOf("loadIntegrationsBoard(");
  assert.ok(guest > 0, "an expired session goes to sign-in");
  assert.ok(gate > guest, "the Super Admin gate runs after the session is resolved");
  assert.ok(bounce > gate, "anyone the gate refuses is sent away");
  assert.ok(load > bounce, "nothing is read until the gate has passed");
  assert.match(page, /export const dynamic = "force-dynamic"/, "read for each visit, never built once and served to all");
  assert.doesNotMatch(page, /process\.env/, "the page itself reads no variable");
}

function loaderReadsTimesOnlyAndNeverHidesAFailedRead() {
  const status = stripComments(read(STATUS));
  const selects = [...status.matchAll(/\.select\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.ok(selects.length >= 5, `the loader's reads were found (${selects.length})`);
  for (const columns of selects) {
    assert.ok(["created_at", "occurred_at", "updated_at"].includes(columns), `the loader selects a time and nothing else, found "${columns}"`);
  }
  assert.doesNotMatch(status, /\.select\(\s*\)|\.select\("\*"\)/, "never a whole row: a stored error message can quote a request");
  assert.doesNotMatch(status, /\.(insert|update|upsert|delete|rpc)\(/, "the loader writes nothing");
  assert.doesNotMatch(status, /\bfetch\(/, "the loader calls no outside service");

  const catches = status.split(/\bcatch\b/).slice(1);
  assert.ok(catches.length >= 2, "the loader catches its failed reads");
  for (const after of catches) {
    assert.match(after.slice(0, 220), /unavailable|describe\(error\)/, 'a read that fails becomes "unavailable" with its reason, never an empty cell');
  }
  assert.equal(status.split("process.env").length - 1, 1, "the loader hands the environment to integrationConfiguration and reads no variable itself");

  const board = stripComments(read(BOARD));
  assert.doesNotMatch(board, /process\.env/, "the board reads no variable");
  assert.match(board, /Unavailable/, "the board prints an unreadable source as Unavailable");
  assert.match(board, /Not recorded/, "the board prints an event Phoenix does not record as Not recorded");
}

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      filesUnder(rel, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

function messagingVersionAgreesEverywhere() {
  assert.match(WHATSAPP_GRAPH_API.version, /^v\d{2}\.\d$/);
  for (const file of WHATSAPP_GRAPH_API_VERSION_FILES) {
    const versions = [...stripComments(read(file)).matchAll(/"(v\d{2}\.\d)"/g)].map((match) => match[1]);
    assert.ok(versions.length > 0, `${file} still carries the messaging API version`);
    assert.deepEqual(
      [...new Set(versions)],
      [WHATSAPP_GRAPH_API.version],
      `${file} and WHATSAPP_GRAPH_API.version disagree: change the version, its expiry and its review date together`,
    );
  }
  // An eighth file would be moved by nobody: the registry's list is the only thing that says where to look.
  // The raw text is searched first so only the few files that hold the shape are parsed for comments.
  const carriers = [...filesUnder("src"), ...filesUnder("app")]
    .filter((file) => file !== "src/lib/integrations/registry.ts")
    .filter((file) => {
      const source = read(file);
      return /"v\d{2}\.\d"/.test(source) && /"v\d{2}\.\d"/.test(stripComments(source));
    });
  assert.deepEqual(carriers.sort(), [...WHATSAPP_GRAPH_API_VERSION_FILES].sort(), "every file that writes a Graph API version is on the registry's list");

  const expires = Date.parse(`${WHATSAPP_GRAPH_API.expiresOn}T00:00:00Z`);
  const review = Date.parse(`${WHATSAPP_GRAPH_API.reviewBy}T00:00:00Z`);
  assert.ok(Number.isFinite(expires) && Number.isFinite(review), "both dates are real days");
  const daysAhead = (expires - review) / 86_400_000;
  assert.ok(daysAhead >= 60, `the review falls at least two months before the version is retired (${daysAhead} days)`);

  const whatsapp = findIntegration("whatsapp");
  assert.ok(whatsapp);
  const note = (whatsapp.notes ?? []).join(" ");
  assert.ok(note.includes(WHATSAPP_GRAPH_API.version), "the WhatsApp row names the version");
  assert.match(note, /8 October 2027/, "the WhatsApp row names the day Meta retires it");
  assert.match(note, /8 July 2027/, "the WhatsApp row names the review day");
}

function voiceTranscriptionCarriesItsDataNote() {
  const groq = findIntegration("groq");
  assert.ok(groq, "the voice transcription service is listed");
  const notes = (groq.notes ?? []).join(" ");
  assert.match(notes, /Data note:/, "the row says a clip can hold a person's name");
  assert.match(notes, /United States/, "the row says where the provider stores data");
  assert.match(notes, /Not verified:/, "the row says what has not been checked, in so many words");
}

function pageIsOnTheAdminToolsHub() {
  const navigation = read("src/config/system-navigation.ts");
  const at = navigation.indexOf('href: "/admin/integrations"');
  assert.ok(at > 0, "the page has a card in the navigation");
  const card = navigation.slice(at, navigation.indexOf("},", at));
  assert.match(card, /roles: \["Super Admin"\],/, "the card is offered to the Super Admin alone, matching the page's gate");
  const band = navigation.slice(navigation.indexOf('heading: "Platform Health"'), navigation.indexOf('heading: "Email & Notifications"'));
  assert.ok(band.includes('"/admin/integrations"'), "the card sits in the Platform Health band of Admin Tools");
}

// ISS-043: the joining form collects a new hire's personal data, and its Arabic typeface used to come from
// Google Fonts, so the new hire's address reached a third party. The face is served from the app now.
function noPageLoadsATypefaceFromAFontService() {
  const FONT_SERVICE = /fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fonts\.bunny\.net/;
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      // The content-security policy names the hosts it allows; that is a rule, not a load.
      else if (/\.(ts|tsx|css)$/.test(entry.name) && rel !== "src/lib/security/content-security-policy.ts" && FONT_SERVICE.test(stripComments(read(rel)))) offenders.push(rel);
      // A page served as a file from public/ is a page too. The marketing guide imported Inter from Google
      // Fonts and the first sweep, which read only app/ and src/, never saw it (found 13 Nov 2026).
      // Its own comment may NAME the service it left, so the page is read with its comments taken out.
      else if (dir.startsWith("public") && /\.(html?|css|js|svg)$/.test(entry.name) && FONT_SERVICE.test(read(rel).replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, ""))) offenders.push(rel);
    }
  };
  for (const dir of ["app", "src", "public"]) walk(dir);
  assert.deepEqual(offenders, [], "🔴 a page loads a typeface from a font service: serve it from public/fonts, as the joining form does (ISS-043)");

  // The marketing guide's Inter: one variable file, every weight the page asks for, with its licence.
  const guide = read("public/marketing-guide.html");
  assert.ok(guide.includes("src:url('/fonts/inter-latin.woff2') format('woff2')"), "the marketing guide declares Inter from the app's own /fonts");
  assert.match(guide, /font-family:'Inter';[^}]*font-weight:300 900/, "the one file answers every weight the guide asks for (it uses 400 to 900)");
  assert.ok(!/@import\s+url\(/.test(guide), "the guide imports no stylesheet from anywhere: an import is how the font service got in");
  assert.equal(readFileSync(path.join(ROOT, "public/fonts/inter-latin.woff2")).subarray(0, 4).toString("latin1"), "wOF2", "public/fonts/inter-latin.woff2 is a real woff2 file");
  assert.match(read("public/fonts/inter-OFL.txt"), /SIL OPEN FONT LICENSE/, "Inter's licence ships beside it");

  const form = stripComments(read("src/components/offers/joining-form-page.tsx"));
  for (const file of ["cairo-arabic.woff2", "cairo-latin-ext.woff2", "cairo-latin.woff2"]) {
    assert.ok(form.includes(`url("/fonts/${file}")`), `the joining form declares ${file} from the app's own /fonts`);
    const bytes = readFileSync(path.join(ROOT, "public/fonts", file));
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "wOF2", `public/fonts/${file} is a real woff2 file`);
  }
  assert.match(form, /font-family:"Cairo";[^}]*font-weight:400 700/, "the bundled Cairo answers the regular, semibold and bold the form asks for");
  assert.match(read("public/fonts/cairo-OFL.txt"), /SIL OPEN FONT LICENSE/, "the typeface's licence ships beside it");
  assert.equal(findIntegration("openstreetmap-tiles") ?? null, null, "the OpenStreetMap tiles are no longer an outside service: the integrity maps' streets are a Google picture (ISS-012)");
  assert.equal(findIntegration("google-fonts") ?? null, null, "Google Fonts is no longer an outside service Phoenix depends on");
}

export async function runIntegrationsRegistryTests() {
  registryIsWellFormed();
  configurationNeverReturnsAValue();
  pageIsSuperAdminOnlyAndGatedFirst();
  loaderReadsTimesOnlyAndNeverHidesAFailedRead();
  messagingVersionAgreesEverywhere();
  voiceTranscriptionCarriesItsDataNote();
  pageIsOnTheAdminToolsHub();
  noPageLoadsATypefaceFromAFontService();
}
