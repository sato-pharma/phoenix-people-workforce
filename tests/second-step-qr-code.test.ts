import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import { otpauthUri } from "../src/lib/auth/second-step.ts";
import { SECOND_STEP_QR, SECOND_STEP_QR_LABEL } from "../src/lib/auth/second-step-qr.ts";

/**
 * THE SECOND SIGN-IN STEP'S SET-UP SHOWS A QR CODE TO SCAN, BESIDE THE KEY TO TYPE (owner, 14 Nov 2026:
 * "write code or scan qr code"; "install the qr library").
 *
 * What is pinned:
 *
 *   1. The library ships: `qrcode.react` is a production dependency at an exact version.
 *   2. The settings: error correction M, the standard four-module quiet zone, black on white.
 *   3. Both set-up screens (the sign-in page and the profile card) draw the code from `setup.otpauthUri`,
 *      the SAME address their "Open in the app" link carries, so scanning and tapping add the same account.
 *   4. Nothing is fetched to draw it: no outside QR picture service, no <img>, no fetch — the key never
 *      leaves the page.
 *   5. The real library, with the real settings, draws the real address as a square code of the size its
 *      length needs, labelled for a screen reader, with the key nowhere in the markup.
 *
 * Proven once by a real decoder (14 Nov 2026): the same library version drew the address of account B-10
 * (140 characters, a 57-module square with its margin) and of a 178-character account name (61), each was
 * rasterised at twice the drawn size, and OpenCV's QRCodeDetector read both back byte for byte. Case 5's
 * size pin is that same address, so a change of library, version or setting that moves it goes red here.
 *
 * Case 5 loads the library inside the test, so on a laptop whose node_modules predates this dependency
 * only this test fails; CI installs from the lockfile.
 */

const LOGIN_PAGE = "src/components/auth/premium-login-page.tsx";
const PROFILE_CARD = "src/components/auth/second-step-card.tsx";
const QR_COMPONENT = "src/components/auth/second-step-qr-code.tsx";
const QR_SETTINGS = "src/lib/auth/second-step-qr.ts";
const SECOND_STEP_ROUTE = "app/api/auth/second-step/route.ts";

const SAMPLE_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

function code(path: string) {
  return stripComments(readFileSync(path, "utf8"));
}

export async function runSecondStepQrCodeTests() {
  // ── 1. The library ships ─────────────────────────────────────────────────────────────────────
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.match(manifest.dependencies?.["qrcode.react"] ?? "", /^\d+\.\d+\.\d+$/, "qrcode.react is a production dependency at an exact version");
  assert.equal(manifest.devDependencies?.["qrcode.react"], undefined, "a devDependency would not reach the sign-in page");

  // ── 2. The settings ─────────────────────────────────────────────────────────────────────────
  assert.equal(SECOND_STEP_QR.level, "M", "level M survives a smudge or a glare");
  assert.equal(SECOND_STEP_QR.marginSize, 4, "four modules of white margin, the quiet zone a phone camera needs on the dark page");
  assert.equal(SECOND_STEP_QR.bgColor, "#ffffff");
  assert.equal(SECOND_STEP_QR.fgColor, "#000000");

  const component = code(QR_COMPONENT);
  assert.ok(component.includes('import { QRCodeSVG } from "qrcode.react"'), "drawn by the library, in the page");
  assert.ok(component.includes("value={otpauthUri}") && component.includes("{...SECOND_STEP_QR}"), "the component draws the address it is given, with the shared settings");
  assert.ok(component.includes("aria-label={SECOND_STEP_QR_LABEL}"), "a screen reader hears what it is");
  assert.ok(!/\btitle=/.test(component), "no title: a tooltip is one more place the address could leak into");

  // ── 3. Both screens, the same address as "Open in the app" ──────────────────────────────────
  for (const screen of [LOGIN_PAGE, PROFILE_CARD]) {
    const source = code(screen);
    assert.ok(source.includes("<SecondStepQrCode otpauthUri={setup.otpauthUri} />"), `${screen}: the set-up draws the QR code`);
    assert.ok(source.includes("href={setup.otpauthUri}"), `${screen}: "Open in the app" carries the same address`);
    assert.ok(source.includes("{setup.secretForTyping}"), `${screen}: the key to type stays beside the code`);
    assert.ok(source.includes("2. Scan this code with the app, or give it the key."), `${screen}: step 2 offers both ways`);
  }

  // ── 4. Nothing is fetched to draw it ─────────────────────────────────────────────────────────
  const OUTSIDE_QR_SERVICE = /https?:\/\/[^\s"'`]*(qr|chart\.googleapis|quickchart|barcode)/i;
  for (const file of [LOGIN_PAGE, PROFILE_CARD, QR_COMPONENT, QR_SETTINGS, SECOND_STEP_ROUTE]) {
    assert.doesNotMatch(code(file), OUTSIDE_QR_SERVICE, `${file}: no outside QR picture service — the key never leaves the page`);
  }
  assert.ok(!/<img\b|fetch\(/.test(component), "the component draws in the page and fetches nothing");

  // ── 5. The real library draws the real address ──────────────────────────────────────────────
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { QRCodeSVG } = await import("qrcode.react");
  const address = otpauthUri({ account: "B-10", secret: SAMPLE_SECRET });
  assert.equal(address.length, 140, "the sample is the address the decoder proof read");
  const markup = renderToStaticMarkup(
    createElement(QRCodeSVG, { ...SECOND_STEP_QR, "aria-label": SECOND_STEP_QR_LABEL, role: "img", value: address }),
  );
  assert.match(markup, /^<svg\b/, "an inline SVG, drawn in the page");
  assert.ok(markup.includes('viewBox="0 0 57 57"'), `version 8 at level M with its 4-module margin, as the decoder read it: ${markup.slice(0, 160)}`);
  assert.ok(markup.includes('fill="#ffffff"'), "a white ground");
  assert.ok(markup.includes('fill="#000000"'), "black modules");
  assert.ok(markup.includes(`aria-label="${SECOND_STEP_QR_LABEL}"`), "labelled for a screen reader");
  assert.ok(!markup.includes(SAMPLE_SECRET) && !markup.includes("otpauth"), "the key and the address are in the modules only, never in readable text");
}
