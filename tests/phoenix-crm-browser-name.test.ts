import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { BROWSER_PLACEHOLDER, browserNameFromUserAgent, nameBrowserIn } from "../src/lib/phoenix-crm/browser-name.ts";
import {
  NO_FIX_FOR_A_VISIT,
  PLACE_PRECISION_NOTE,
  ROUGH_FIX_AT_THE_PLACE,
  ROUGH_FIX_FOR_A_VISIT,
} from "../src/lib/phoenix-crm/entry-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * A location message names the browser the rep is actually in — never "Phoenix", which is not an app
 * on anybody's phone.
 *
 * The incident this pins: on Phoenix CRM's first real day a rep met "Turn on precise location for
 * Phoenix" at 11:24 Cairo and was still blocked at 18:28. She searched her settings, found no Phoenix,
 * decided the browser was at fault and signed in again on Firefox — which refused her identically,
 * because the permission she was hunting belongs to the browser and nothing had ever told her so.
 * Eighteen planned visits went unlogged. Every sentence that sends a rep to a phone setting is in
 * here, because leaving one behind leaves the whole dead end in place.
 */
export function runPhoenixCrmBrowserNameTests(): void {
  // ── Every brand is read before the generic names it also claims ───────────────
  // Her own two, read from app_sessions on 2026-10-03 — the pair that has to come out different.
  assert.equal(
    browserNameFromUserAgent("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36"),
    "Chrome",
    "her Chrome session claims Safari too, and is still Chrome",
  );
  assert.equal(
    browserNameFromUserAgent("Mozilla/5.0 (Android 13; Mobile; rv:157.0) Gecko/157.0 Firefox/157.0"),
    "Firefox",
    "the Firefox she tried at 17:33",
  );

  assert.equal(
    browserNameFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"),
    "Safari",
    "Safari is what is left when no other brand matched",
  );
  assert.equal(
    browserNameFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0 Mobile/15E148 Safari/604.1"),
    "Chrome",
    "Chrome on an iPhone is CriOS, and is still called Chrome in Settings",
  );
  assert.equal(
    browserNameFromUserAgent("Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 EdgA/120.0"),
    "Edge",
    "Edge also claims Chrome and Safari",
  );
  assert.equal(
    browserNameFromUserAgent("Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 OPR/79.0"),
    "Opera",
    "Opera also claims Chrome",
  );
  assert.equal(
    browserNameFromUserAgent("Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36"),
    "Samsung Internet",
    "Samsung Internet also claims Chrome",
  );

  // ── An unknown or absent agent never produces a half-written sentence ─────────
  for (const unknown of [null, undefined, "", "curl/8.4.0", "PhoenixHealthCheck/1"]) {
    assert.equal(browserNameFromUserAgent(unknown), null, `nothing is guessed from ${JSON.stringify(unknown)}`);
  }
  const unnamed = nameBrowserIn(ROUGH_FIX_FOR_A_VISIT, null);
  assert.equal(unnamed, ROUGH_FIX_FOR_A_VISIT, "an unnamed browser leaves the sentence exactly as the server wrote it");
  assert.match(unnamed, /Turn on precise location for your browser/, "and unsubstituted it is already a finished sentence");

  assert.equal(
    nameBrowserIn(ROUGH_FIX_FOR_A_VISIT, "Chrome"),
    "Your phone gave only a rough location. Turn on precise location for Chrome; if it is already on, step outside the building and wait a few seconds, then tap Log visit again.",
    "what Yasmeen should have read at 16:51",
  );

  // She DID switch it on, and the sentence still sent her back to the setting — eighteen more times
  // between 16:12 and 18:47. A rep who has already done it needs the other half of the answer.
  for (const message of [ROUGH_FIX_AT_THE_PLACE, ROUGH_FIX_FOR_A_VISIT]) {
    assert.match(message, /if it is already on, step outside the building and wait a few seconds/, `"${message}" must not dead-end a rep who already switched it on`);
  }
  assert.equal(nameBrowserIn("Nothing to name here.", "Chrome"), "Nothing to name here.", "a message without the placeholder is untouched");

  // ── NOT ONE message may send a rep to an app called Phoenix ───────────────────
  // The permission he is sent to find is the browser's. Naming an app he does not have is the whole
  // defect, and it is only fixed if every one of these sentences is fixed together.
  const sources = [
    "src/lib/phoenix-crm/entry-rules.ts",
    "src/lib/phoenix-crm/day-start-rules.ts",
    "src/lib/phoenix-crm/dictation.ts",
    "src/lib/phoenix-crm/speak.ts",
    "src/components/phoenix-crm/capture-location.tsx",
    "src/components/phoenix-crm/live-photo-capture.tsx",
  ];
  for (const file of sources) {
    // `stripComments`, never a line filter: a line is judged by how it STARTS, so the body of a
    // multi-line comment reads as code and the code sharing its opening line is never scanned at all.
    const body = stripComments(readFileSync(file, "utf8"));
    assert.doesNotMatch(body, /for Phoenix\b/, `${file} must not send a rep to a setting called Phoenix`);
  }

  for (const message of [NO_FIX_FOR_A_VISIT, PLACE_PRECISION_NOTE, ROUGH_FIX_AT_THE_PLACE, ROUGH_FIX_FOR_A_VISIT]) {
    assert.ok(message.includes(BROWSER_PLACEHOLDER), `"${message}" names the browser, so a screen can sharpen it`);
  }

  // ── The screens that show a refusal are the ones that name the browser ────────
  // A display site added later without this is a message that silently keeps the placeholder.
  for (const file of [
    "src/components/phoenix-crm/visit-log-form.tsx",
    "src/components/phoenix-crm/list-customer.tsx",
    "src/components/phoenix-crm/place-editor.tsx",
  ]) {
    const body = readFileSync(file, "utf8");
    assert.match(body, /useBrowserNamed\(\)/, `${file} names the rep's browser in what it shows him`);
  }

  // ── And so are the four screens that raise a refusal of their OWN ─────────────
  // 🔴 HOLDING THE HOOK IS NOT ENOUGH — THE MESSAGE HAS TO GO THROUGH IT AT THE RENDER. Those three
  // screens name what the SERVER refused; a permission the BROWSER refuses never reaches the server,
  // so the component raising it is the only thing that can name the browser, and for four screens
  // nothing did. Norhan Gamal (AI-0025) read "Location is blocked for your browser" on her iPhone at
  // 10:59:01 and 11:10:15 Cairo on 12 October 2026, and three times on 10 October; the touch trail
  // (since retired) held 42 of that sentence and 30 of the camera's, across four reps, between 4 and 12 October. She
  // has never saved a place, a visit or a venue. Naming it at the render rather than at each
  // `setError` is deliberate: a message added to one of these later is named without being wired.
  for (const [file, shown] of [
    ["src/components/phoenix-crm/capture-location.tsx", "{browserNamed(error)}"],
    ["src/components/phoenix-crm/live-photo-capture.tsx", "{browserNamed(error)}"],
    ["src/components/phoenix-crm/speak.tsx", "{browserNamed(error)}"],
    ["src/components/phoenix-crm/day-start-button.tsx", "{browserNamed(problem)}"],
  ] as const) {
    const body = readFileSync(file, "utf8");
    assert.match(body, /useBrowserNamed\(\)/, `${file} raises its own permission refusal, so it reads the browser's name`);
    assert.ok(body.includes(shown), `${file} must show it named: ${shown}`);
    assert.doesNotMatch(
      stripComments(body),
      /<CrmNote tone="bad">\{(?:error|problem)\}<\/CrmNote>/,
      `${file} must not render a refusal that skipped the namer`,
    );
  }

  // ── And the validation screens, which show the SERVER's place refusals ────────
  // 🔴 THE PLACE REFUSALS ARE THE COMMONEST ONES A REP MEETS, AND THESE SCREENS PRINTED THEM RAW. The
  // server's too-rough and not-captured sentences carry the placeholder (entry-rules.ts
  // `roughFixAtThePlace`, `NO_FIX_AT_THE_PLACE`, the pharmacy pair; shared-place-rules.ts for a
  // building), and every screen that shows them put the text straight into the note: between 2 and 22
  // October 2026, 180 place readings were refused as too rough for 12 reps (phoenix_crm_refused_readings),
  // each one reading "Turn on precise location for your browser" while the visit bar beside it said
  // Chrome. The note is split over three lines in these files, so the one-line pattern above never saw it.
  for (const [file, sites] of [
    ["src/components/phoenix-crm/list-screens.tsx", 2], // Validate, and the SaveBar under Save the clinic
    ["src/components/phoenix-crm/out-of-list-entry.tsx", 1], // Someone new
    ["src/components/phoenix-crm/add-pharmacy.tsx", 1],
    ["src/components/phoenix-crm/pharmacy-details.tsx", 1],
    ["src/components/phoenix-crm/signboard-retake-screen.tsx", 1],
    ["src/components/phoenix-crm/shared-place-screens.tsx", 1], // a new polyclinic or centre
    ["src/components/phoenix-crm/venue-timetable-screen.tsx", 1],
  ] as const) {
    const code = stripComments(readFileSync(file, "utf8"));
    assert.match(code, /useBrowserNamed\(\)/, `${file} shows a place refusal, so it reads the browser's name`);
    const named = code.split("{browserNamed(problem)}").length - 1;
    assert.ok(named >= sites, `${file} must show its ${sites} refusal note(s) named, found ${named}`);
    assert.doesNotMatch(
      code,
      /<CrmNote\b[^>]*\btone="bad"[^>]*>\s*\{(?:error|problem)\}\s*<\/CrmNote>/,
      `${file} must not render a refusal that skipped the namer, on one line or several`,
    );
  }

  // What her iPhone should have read, from the user agent app_sessions recorded for her that morning.
  assert.equal(
    nameBrowserIn(
      `Location is blocked for ${BROWSER_PLACEHOLDER}. Allow location for this site in its settings, then press Capture location again.`,
      browserNameFromUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1",
      ),
    ),
    "Location is blocked for Safari. Allow location for this site in its settings, then press Capture location again.",
    "what AI-0025 should have read at 10:59 on 12 October",
  );

  // The name is read after hydration, never in the render the server also performs: the two would
  // disagree and React would throw the subtree away to settle it. `useSyncExternalStore` is the one
  // primitive that does that without state set from an effect, which this repo's lint refuses.
  const hook = stripComments(readFileSync("src/components/phoenix-crm/use-browser-name.ts", "utf8"));
  assert.match(hook, /useSyncExternalStore\(subscribe, onThePhone, onTheServer\)/, "the server's snapshot is the placeholder, so the two renders agree");
  assert.doesNotMatch(hook, /useState|useEffect/, "never state seeded in render, and never state set from an effect");
}
