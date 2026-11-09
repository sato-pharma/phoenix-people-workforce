import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { safeReturnUrl } from "../src/lib/auth/safe-return-url.ts";
import { hashPasscode, passcodeMatches } from "../src/lib/share-links/passcode-hash.ts";
import { assertReachableEmailImage } from "../src/lib/email/email-safety.ts";
import { isConsoleHost } from "../src/lib/new-hire-mailbox/robot/turbify-joiner.ts";
import { throwawayPassword } from "../src/lib/mailbox-offboarding/robot/clear-app-passwords.ts";
import { parsePharmacyLicenseDataUrl } from "../src/lib/venues/pharmacy-license.ts";
import { isWorkEmailFormat } from "../src/lib/employees/employee-directory.ts";
import { replaceTemplateBraces } from "../src/lib/notifications/email.ts";
import { validateTelegramTemplateText } from "../src/lib/notifications/telegram-template-placeholders.ts";
import { buildOutstationCarEvidenceImagePath } from "../src/lib/outstation/car-evidence-storage.ts";
import { htmlDocumentBody, htmlDocumentSubject } from "../src/lib/sato-email/source-document.ts";
import { emailPlainText } from "../src/lib/sato-email/polish.ts";
import { buildAdminMirrorMessage } from "../src/lib/email/admin-telegram-mirror.ts";
import { keysInMarkup } from "../src/lib/hiring-pack/document-inventory.ts";

/**
 * The CodeQL code-scanning alerts that were real (9 Nov 2026) — one assertion per behaviour fixed.
 *
 *  1. A sign-in only ever sends its user back to a path on this site.
 *  2. A share-link passcode is stored as a slow scrypt hash, and a link minted before still opens.
 *  3. The email signature check never reaches an internal host, directly or through a redirect.
 *  4. The joiner robot's "signed in" check reads the host, not a substring of the login page's url.
 *  5. A leaver's throwaway mailbox password is drawn from the crypto source.
 *  6. Seven text reads that took seconds on a long hostile input now finish at once, same results.
 *  7. HTML is stripped until nothing more comes off, and entities are decoded with &amp; last.
 */

const LONG = 50_000;

function fast<T>(label: string, run: () => T): T {
  const started = performance.now();
  const result = run();
  const ms = performance.now() - started;
  assert.ok(ms < 1_000, `${label} must finish at once on a ${LONG}-character input, took ${ms.toFixed(0)} ms`);
  return result;
}

function testSafeReturnUrl(): void {
  assert.equal(safeReturnUrl("/admin"), "/admin");
  assert.equal(safeReturnUrl("  /portal?tab=1 "), "/portal?tab=1");
  for (const hostile of ["//evil.com", "/\\evil.com", "/\t/evil.com", "/\n/evil.com", "https://evil.com", "evil.com", "", null, undefined]) {
    assert.equal(safeReturnUrl(hostile), null, `${JSON.stringify(hostile)} must not be followed after sign-in`);
  }
}

async function testSharePasscode(): Promise<void> {
  const token = "tok-123";
  const stored = hashPasscode("4821", token);
  assert.ok(stored.startsWith("scrypt$"), `a new passcode is a scrypt hash, got ${stored}`);
  assert.notEqual(hashPasscode("4821", token), stored, "each hash carries its own salt");
  assert.equal(await passcodeMatches("4821", token, stored), true);
  assert.equal(await passcodeMatches(" 4821 ", token, stored), true, "the typed passcode is trimmed, as before");
  assert.equal(await passcodeMatches("4822", token, stored), false);
  assert.equal(await passcodeMatches("4821", "another-token", stored), false, "the hash is still bound to its link");
  assert.equal(await passcodeMatches("4821", token, "scrypt$broken"), false, "a damaged hash opens nothing");

  // A link minted before 9 Nov 2026 stored hex SHA-256 of `<token>:<passcode>`; it must still open.
  const legacyStored = createHash("sha256").update(`${token}:4821`).digest("hex");
  assert.equal(await passcodeMatches("4821", token, legacyStored), true, "an old link's passcode still opens it");
  assert.equal(await passcodeMatches("0000", token, legacyStored), false);
  assert.equal(await passcodeMatches("4821", token, null), true, "a link with no passcode needs none");
}

async function testEmailImageNeverReachesAnInternalHost(): Promise<void> {
  const realFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    seen.push(String(input));
    return new Response(null, { status: 302, headers: { location: "https://10.0.0.1/a.png" } });
  }) as typeof fetch;
  try {
    for (const hostile of ["https://169.254.169.254/x.png", "https://127.0.0.1/x.png", "https://user:pw@cdn.example.org/a.png"]) {
      await assert.rejects(
        () => assertReachableEmailImage(hostile, { cacheTtlMs: -1 }),
        /must not use a local\/internal host/,
        `${hostile} must be refused before any request`,
      );
    }
    assert.equal(seen.length, 0, "a refused url is never fetched");

    await assert.rejects(
      () => assertReachableEmailImage("https://cdn.example.org/redirects.png", { cacheTtlMs: -1 }),
      /not reachable as an image/,
    );
    assert.ok(seen.length > 0, "the public url itself is checked");
    assert.ok(!seen.some((url) => url.includes("10.0.0.1")), `a redirect onto a private host is never followed, saw ${seen.join(", ")}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

function testConsoleHost(): void {
  assert.equal(isConsoleHost("https://ecp.turbify.com/satopharma.com"), true);
  assert.equal(
    isConsoleHost("https://login.turbify.com/login?.done=https%3A%2F%2Fecp.turbify.com%2F"),
    false,
    "the login page carries the console's address in its return link and is not the console",
  );
  assert.equal(isConsoleHost("https://ecp.turbify.com.evil.net/"), false);
  assert.equal(isConsoleHost("not a url"), false);
}

function testThrowawayPassword(): void {
  const passwords = new Set(Array.from({ length: 50 }, () => throwawayPassword()));
  assert.equal(passwords.size, 50, "fifty passwords from the default source are fifty different passwords");
  const source = readFileSync(
    new URL("../src/lib/mailbox-offboarding/robot/clear-app-passwords.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /throwawayPassword\(random: \(\) => number = cryptoRandom\)/, "the default source is crypto, never Math.random");
}

function testSlowReadsAreLinear(): void {
  assert.throws(
    () => fast("the pharmacy licence upload", () => parsePharmacyLicenseDataUrl(`data:image/png;base64,QUJD${"=".repeat(LONG)}A`)),
    /must be a photo or a PDF attached inside the app/,
  );

  assert.equal(fast("the work-email check", () => isWorkEmailFormat(`!@!.${"!.".repeat(LONG)}@`)), false);
  assert.equal(isWorkEmailFormat(`a@${"a.".repeat(LONG)}a`), true);
  assert.equal(isWorkEmailFormat("mona.adel@satopharma.com"), true);
  assert.equal(isWorkEmailFormat("mona.adel@satopharma"), false);
  assert.equal(isWorkEmailFormat("mona adel@satopharma.com"), false);

  const braces = "{".repeat(LONG);
  assert.equal(fast("the email placeholder fill", () => replaceTemplateBraces(braces, () => "X")), braces);
  assert.equal(replaceTemplateBraces("Dear {name}, {}", (key) => key.toUpperCase()), "Dear NAME, {}");

  assert.deepEqual(
    fast("the Telegram template check", () => validateTelegramTemplateText("<a".repeat(LONG), [])),
    { errors: [], unknownPlaceholders: [] },
  );
  assert.ok(validateTelegramTemplateText("<b>hi</b>", []).errors.some((error) => error.includes("HTML is not allowed")));

  const hrId = `a${"-".repeat(LONG)}b`;
  const metadata = { employeeHrId: hrId, requestDraftId: "r", requestId: null } as unknown as Parameters<
    typeof buildOutstationCarEvidenceImagePath
  >[0];
  assert.equal(fast("the car photo path", () => buildOutstationCarEvidenceImagePath(metadata)), `car/${hrId}/r.jpg`);

  fast("the admin Telegram mirror", () => buildAdminMirrorMessage({ subject: "s", html: "<style".repeat(LONG) } as never));

  // Thousands of openers that never close: every one used to re-read the rest of the file.
  const unclosed = "<script>".repeat(LONG);
  assert.equal(fast("the uploaded HTML file's script and style removal", () => htmlDocumentBody(unclosed)), unclosed);
  assert.equal(htmlDocumentBody("<p>a</p><SCRIPT type=x>b()</Script ><style>c{}</style><p>d</p>"), "<p>a</p><p>d</p>");
}

function testHtmlIsStrippedWholeAndDecodedOnce(): void {
  assert.equal(htmlDocumentBody("<scr<script></script>ipt>alert(1)</script>"), "", "a script split around another one is removed whole");
  assert.equal(htmlDocumentBody("<!<!-- -->-- hidden -->x"), "x");
  assert.equal(htmlDocumentSubject("<title>a &amp;lt;b&amp;gt;</title>"), "a &lt;b&gt;", "&amp; is decoded last, so &amp;lt; reads &lt;");
  assert.equal(emailPlainText("<p>&amp;lt;x&amp;gt;</p>"), "&lt;x&gt;");
  // The composer module loads the JSX email layout, which this runner cannot import, so its order is read.
  const composer = readFileSync(new URL("../src/lib/email/email-composer-service.ts", import.meta.url), "utf8");
  const toText = composer.slice(composer.indexOf("export function composerHtmlToText"));
  assert.ok(
    toText.indexOf('.replace(/&amp;/gi, "&")') > toText.indexOf('.replace(/&#39;/gi, "\'")'),
    "the composer's plain text decodes &amp; after every other entity",
  );
  assert.deepEqual(keysInMarkup('<i data-hp-key="&amp;quot;">'), ["&quot;"]);
  const mirror = buildAdminMirrorMessage({ subject: "s", html: "a<script>x()</script >b</script>c &amp;lt;" } as never);
  assert.ok(mirror.message.includes("a b c &lt;"), `a script closed as "</script >" is removed and the text after it kept, got: ${mirror.message}`);
}

/** Every part runs, and every failure is reported together. */
export async function runCodeqlRealAlertsTests(): Promise<void> {
  const parts: Array<[string, () => void | Promise<void>]> = [
    ["sign-in return path", testSafeReturnUrl],
    ["share-link passcode", testSharePasscode],
    ["email image host", testEmailImageNeverReachesAnInternalHost],
    ["console host", testConsoleHost],
    ["throwaway password", testThrowawayPassword],
    ["linear reads", testSlowReadsAreLinear],
    ["html strip and decode", testHtmlIsStrippedWholeAndDecodedOnce],
  ];
  const failures: string[] = [];
  for (const [name, run] of parts) {
    try {
      await run();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`CodeQL real alerts — ${failures.join(" | ")}`);
}
