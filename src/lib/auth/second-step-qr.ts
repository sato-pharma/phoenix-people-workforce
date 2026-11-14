/**
 * THE QR CODE ON THE SECOND SIGN-IN STEP'S SET-UP (owner, 14 Nov 2026: "write code or scan qr code").
 *
 * The set-up screen offers two ways to give an authenticator app the key: type it (or copy it, or open it
 * straight in the app on a phone), or scan this code with the phone's camera. The code carries the SAME
 * otpauth:// address the "Open in the app" link carries (`otpauthUri` in ./second-step.ts), so the two
 * paths add the same account under the same name.
 *
 * It is drawn in the browser by `qrcode.react`, from these settings. Nothing is fetched to draw it: the
 * key never leaves the page for an outside picture service. Level M survives a smudge or a glare; the
 * four-module white margin is the quiet zone the standard asks for, and it is what lets a phone camera
 * find the code on the dark sign-in page. Square, flat, black on white.
 *
 * Kept in a plain .ts module so tests/second-step-qr-code.test.ts draws the code with exactly the
 * settings the two screens use.
 */
export const SECOND_STEP_QR = {
  bgColor: "#ffffff",
  fgColor: "#000000",
  level: "M",
  marginSize: 4,
  size: 176,
} as const;

/** What a screen reader says. Never the key: it is in the address the code carries, and nowhere else. */
export const SECOND_STEP_QR_LABEL = "QR code for your authenticator app";
