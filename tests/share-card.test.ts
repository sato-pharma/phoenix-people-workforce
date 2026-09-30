import assert from "node:assert/strict";

import {
  SHARE_TARGETS,
  milestoneShareCaption,
  shareComposerUrl,
  shareFallbackHint,
  spotlightShareCaption,
} from "@/lib/share/social-share";

// The pure half of social sharing — the caption text, the composer URLs, and the target catalogue.
// The DOM half (canShare / navigator.share / download-and-open) is exercised in the browser, not here.

export function runShareCardTests(): void {
  // ── The catalogue is exactly the four the owner named, in his order ────────────────────────────
  assert.deepEqual(
    SHARE_TARGETS.map((t) => t.id),
    ["whatsapp", "whatsapp-status", "linkedin", "facebook"],
    "the four share targets are WhatsApp, WhatsApp Status, LinkedIn and Facebook, in that order",
  );

  // ── WhatsApp Status has NO web composer — it is share-sheet only ───────────────────────────────
  const status = SHARE_TARGETS.find((t) => t.id === "whatsapp-status");
  assert.ok(status && status.hasWebComposer === false, "WhatsApp Status cannot be reached by a web URL");
  assert.equal(
    shareComposerUrl("whatsapp-status", "hi"),
    null,
    "there is no web composer for WhatsApp Status — the OS share sheet is the only route",
  );
  assert.match(
    shareFallbackHint("whatsapp-status"),
    /Status/,
    "the Status fallback tells the person to post it from WhatsApp on their phone",
  );

  // ── The composers carry the caption, URL-encoded ──────────────────────────────────────────────
  const caption = "Celebrating my First year at Sato Pharma! 🎉 #SatoPharma";
  const encoded = encodeURIComponent(caption);
  assert.equal(shareComposerUrl("whatsapp", caption), `https://wa.me/?text=${encoded}`);
  assert.equal(
    shareComposerUrl("linkedin", caption),
    `https://www.linkedin.com/feed/?shareActive=true&text=${encoded}`,
  );
  // Facebook's sharer needs a public URL; with a page URL it uses it, without it opens the composer.
  assert.equal(
    shareComposerUrl("facebook", caption, "https://phoenix-hr.satopharma.com/x"),
    `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent("https://phoenix-hr.satopharma.com/x")}`,
  );
  assert.equal(shareComposerUrl("facebook", caption), "https://www.facebook.com/");

  // ── The captions are warm, first-person, and name Sato Pharma ─────────────────────────────────
  assert.match(milestoneShareCaption("Two years"), /^Celebrating my Two years at Sato Pharma!/);
  assert.match(spotlightShareCaption("August 2026"), /^My Sato Pharma spotlight — August 2026\./);
  for (const line of [milestoneShareCaption("First year"), spotlightShareCaption("Q3")]) {
    assert.match(line, /#SatoPharma/, "every caption carries the #SatoPharma tag");
  }
}
