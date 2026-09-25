import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripComments } from "./support/comment-strip.ts";

/**
 * A CLOSING CAN BE PUBLISHED SILENTLY — AND SILENCE MUST ALWAYS BE ASKED FOR.
 *
 * Owner, 2026-09-07: "publish aug anti infective but with no email this time." Until this existed
 * there was no way to do it: `publishClosing` fired `notifyClosingPublished` unconditionally, and a
 * publish mails roughly twelve people — every District Manager seated on the line, the CEO, the
 * Marketing Manager, the SFE Manager, the line's NSM and its product managers. A month republished
 * after a correction does not need all of them told a second time.
 *
 * 🔴 THE DEFAULT IS THE WHOLE SAFETY PROPERTY, AND IT FAILS SILENTLY IN ONE DIRECTION ONLY.
 * Publishing is how a line's managers learn the month is final. If `notify` defaulted to false, or
 * were a truthiness check, then every caller that simply forgot the argument would publish a month
 * that nobody is told about — and nothing anywhere would report it. There is no bounce, no error and
 * no audit row saying "no mail was sent"; the closing just sits there looking published while the
 * managers wait for a mail that is never coming. The opposite mistake — an unwanted mail — is loud,
 * immediate and survivable. So the test below is really about `!== false`, twice.
 *
 * A sent mail cannot be recalled, and `unpublishClosing` does not try: it deletes the row and sends
 * nothing. That asymmetry is why the suppression lives at the publish call site rather than inside
 * the notifier — a future caller of the notifier must not inherit a silence it never requested.
 */

const PUBLICATION_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/sales/monthly-closing-publication.ts", import.meta.url)),
  "utf8",
);

const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL("../app/api/sales/monthly-closing/publish/route.ts", import.meta.url)),
  "utf8",
);

/**
 * Body of one exported function, sliced from its signature to the next top-level export.
 *
 * Scoped to the function deliberately, never a fixed byte window: a source-pinning test that slices
 * a fixed range false-fails the moment anything above it shifts, and a test that cries wolf gets
 * deleted. Same helper shape as tests/closing-publication-snapshot.test.ts.
 */
function exportedFunctionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start > 0, `expected to find ${name}`);
  const rest = source.slice(start + 1);
  const next = rest.indexOf("\nexport ");
  return next === -1 ? rest : rest.slice(0, next);
}

/** Source with comments stripped, so a condition quoted in prose cannot satisfy a check. */
function code(source: string): string {
  return stripComments(source);
}

export function runClosingPublishSilentlyTests() {
  const publish = code(exportedFunctionBody(PUBLICATION_SOURCE, "publishClosing"));

  // ── The option exists and is optional ────────────────────────────────────────────────────────
  assert.match(
    publish,
    /notify\?\s*:\s*boolean/,
    "publishClosing must take an OPTIONAL notify — every existing caller keeps mailing",
  );

  // ── The guard is `!== false`, never a truthiness test ────────────────────────────────────────
  assert.match(
    publish,
    /input\.notify\s*!==\s*false/,
    "the send must be guarded by `input.notify !== false`",
  );
  assert.doesNotMatch(
    publish,
    /if\s*\(\s*publishedAt\s*&&\s*input\.notify\s*\)/,
    "a truthiness check would make a FORGOTTEN argument publish in silence — the one failure nobody sees",
  );
  assert.equal(
    publish.split("notifyClosingPublished(").length - 1,
    1,
    "exactly one send site, so the guard cannot be bypassed by a second call",
  );

  // The guard and the send are the same statement — not two, where an early return could drift.
  const sendIndex = publish.indexOf("notifyClosingPublished(");
  const guardIndex = publish.indexOf("input.notify !== false");
  assert.ok(guardIndex > 0 && guardIndex < sendIndex, "the guard must sit before the send it controls");

  // ── The notifier itself stays unconditional: silence belongs to the caller ───────────────────
  const notifier = readFileSync(
    fileURLToPath(new URL("../src/lib/sales/closing-publish-notification.ts", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(
    code(notifier),
    /notify\s*[?!]?\s*[:=]/,
    "notifyClosingPublished must NOT learn about notify — a future caller must not inherit a silence it never asked for",
  );

  // ── The route: opt-out only, and only on the literal boolean ─────────────────────────────────
  const post = code(ROUTE_SOURCE.slice(ROUTE_SOURCE.indexOf("export async function POST")));
  assert.match(
    post,
    /body\.notify\s*===\s*false\s*\?\s*false\s*:\s*true/,
    'the route must coerce with `body.notify === false ? false : true` — JSON "false" is a STRING and must still publish loudly',
  );
  assert.doesNotMatch(
    post,
    /notify:\s*Boolean\(/,
    'Boolean("false") is true, but Boolean(undefined) is FALSE — that coercion silences every caller that omits the field',
  );
  assert.doesNotMatch(post, /notify:\s*body\.notify\s*[,}]/, "an unvalidated pass-through accepts any junk as a decision");

  // ── Nothing else about publishing changed ────────────────────────────────────────────────────
  assert.match(publish, /assertClosingPeriodComplete\(period\)/, "the closing golden rule still gates the publish");
  assert.match(publish, /assertNotHeadOfficeClosing\(line\)/, "Head Office is still never a closing");
  assert.match(
    publish,
    /published_by:\s*input\.actorHrId/,
    "a silent publish is still attributed to whoever published it",
  );
  assert.doesNotMatch(
    publish,
    /snapshot_/,
    "the upsert payload must stay four columns — a silent publish must not restate the drift baseline",
  );
}
