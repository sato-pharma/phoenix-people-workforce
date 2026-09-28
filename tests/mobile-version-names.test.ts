import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The version a human reads and the version Play counts must move together.
 *
 * WHAT WENT WRONG. `versionCode` went 1 → 2 → 3 across three different binaries on 2026-09-28 while
 * `version` stayed `0.1.0` for all of them, because only one of the two is forced to change: Play
 * refuses a bundle whose `versionCode` is not higher than the published one, and says nothing at all
 * about the version NAME. So the managed Play repository listed three distinct builds — the Modules
 * tab, the version-code fix, and the in-app WebView — as one string, `0.1.0`, and nobody reading the
 * store could tell which was on a tablet.
 *
 * THE RULE: `version` is `0.<versionCode>.0`. Deliberately mechanical rather than semantic. A "bump
 * the name too" convention is exactly the sort of thing that holds for two releases and then quietly
 * stops, and its failure is invisible — the build succeeds, Play accepts it, and only a person
 * comparing two tablets ever notices. Tying the two together makes the name un-forgettable: the code
 * MUST rise for Play to accept the upload, so the name rises with it or this test goes red.
 *
 * `appVersionSource` is `local` in eas.json, so EAS increments neither — both numbers live in
 * `app.json` and are whatever this repository says they are.
 *
 * NEITHER IS PART OF THE RUNTIME FINGERPRINT. The Android config keys the fingerprint hashes are
 * `adaptiveIcon`, `blockedPermissions`, `package`, `permissions` and `predictiveBackGestureEnabled` —
 * `versionCode` and `version` are not among them. So bumping either is free: it does not move the
 * runtime, does not strand the OTA updates already published against it, and does not invalidate a
 * binary already installed.
 */
export function runMobileVersionNamesTests() {
  const appJson = JSON.parse(readFileSync("mobile/app.json", "utf8")) as {
    expo: { android: { versionCode: number }; version: string };
  };

  const { version } = appJson.expo;
  const { versionCode } = appJson.expo.android;

  assert.equal(
    typeof versionCode,
    "number",
    "android.versionCode must be a number — Play counts it, and a string would be a silent no-op",
  );
  assert.ok(
    Number.isInteger(versionCode) && versionCode >= 1,
    `android.versionCode must be a whole number of at least 1, not ${String(versionCode)}`,
  );

  assert.equal(
    version,
    `0.${versionCode}.0`,
    `mobile/app.json: version "${version}" does not match versionCode ${versionCode}. They move together — raise the name to "0.${versionCode}.0" in the same edit that raises the code, so the managed Play repository never lists two different binaries under one version string again.`,
  );

  // The exact string three separate builds shipped under. Named so a revert to it fails loudly rather
  // than passing whenever versionCode happens to be 1 again (it cannot go back, but a hand edit can).
  assert.notEqual(
    version,
    "0.1.0",
    "0.1.0 is the string versionCode 1, 2 and 3 all shipped under — it is never the right answer again",
  );

  // eas.json must keep EAS out of it: with `appVersionSource: "remote"` EAS would manage the code on
  // its own servers, this file would stop being the source of truth, and the rule above would be
  // checking a number that no longer reaches the build.
  const easJson = JSON.parse(readFileSync("mobile/eas.json", "utf8")) as {
    cli?: { appVersionSource?: string };
  };
  assert.equal(
    easJson.cli?.appVersionSource,
    "local",
    "eas.json must keep appVersionSource local, or app.json stops deciding the version that ships",
  );
}
