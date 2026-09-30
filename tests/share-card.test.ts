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
  // Without a public link (desktop fallback): WhatsApp carries the caption, LinkedIn/Facebook open a
  // composer for a manual picture attach.
  assert.equal(shareComposerUrl("whatsapp", caption), `https://wa.me/?text=${encoded}`);
  assert.equal(
    shareComposerUrl("linkedin", caption),
    `https://www.linkedin.com/feed/?shareActive=true&text=${encoded}`,
  );
  assert.equal(shareComposerUrl("facebook", caption), "https://www.facebook.com/");

  // ── WITH the public share link — the whole point: LinkedIn and Facebook scrape its og:image ────
  const page = "https://phoenix-hr.satopharma.com/share/card/tok";
  assert.equal(
    shareComposerUrl("linkedin", caption, page),
    `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(page)}`,
    "with a link, LinkedIn uses share-offsite so the card shows in the preview",
  );
  assert.equal(
    shareComposerUrl("facebook", caption, page),
    `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(page)}`,
    "with a link, Facebook's sharer scrapes it",
  );
  assert.equal(
    shareComposerUrl("whatsapp", caption, page),
    `https://wa.me/?text=${encodeURIComponent(`${caption}\n${page}`)}`,
    "with a link, WhatsApp carries the caption and the link for a preview",
  );
  // WhatsApp Status is share-sheet only, with or without a link.
  assert.equal(shareComposerUrl("whatsapp-status", caption, page), null);

  // ── The captions are warm, first-person, and name Sato Pharma ─────────────────────────────────
  assert.match(milestoneShareCaption("Two years"), /^Celebrating my Two years at Sato Pharma!/);
  assert.match(spotlightShareCaption("August 2026"), /^My Sato Pharma spotlight — August 2026\./);
  for (const line of [milestoneShareCaption("First year"), spotlightShareCaption("Q3")]) {
    assert.match(line, /#SatoPharma/, "every caption carries the #SatoPharma tag");
  }
}
