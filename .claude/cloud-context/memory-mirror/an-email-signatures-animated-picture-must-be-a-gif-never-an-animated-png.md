---
name: an-email-signatures-animated-picture-must-be-a-gif-never-an-animated-png
description: "A signature's moving emblem must be an animated GIF - Gmail and Outlook for Windows show only the first frame of an animated PNG; a GIF cannot be partly transparent, so bake the glow on white and keep the PNG only as the dark-mode picture source."
metadata:
  node_type: memory
  type: reference
  originSessionId: c5dcb10a-7b1a-4e7d-b7cc-a545b5ed0ca1
  modified: 2026-10-17T09:05:51.540Z
---

The owner's email signature carries the Phoenix emblem with the Talent Acquisition banner's glow and lightning strike
(48x48 shown, 144x144 file, 12 frames: 4,450 ms still, then eleven 50 ms strike frames, looping forever).

- **Animated PNG is the wrong format for email.** Litmus (Nov 2019) lists Gmail, the Gmail app and Outlook for Windows as
  showing only the first frame of an animated PNG; Apple Mail, iOS, Outlook.com, Yahoo and Outlook for Mac play it. The
  shipped PNG (`phoenix-hr-signature-glow.png`, 92 KB) was therefore static in the two apps the owner uses most.
- **Animated GIF is what plays everywhere that matters.** Microsoft's own Outlook page says Outlook plays animated
  GIFs in the body by default (Microsoft 365, 2024, 2021); it shows the first frame only when Windows' "Show animations"
  is off. The shipped file is `public/assets/branding/phoenix-hr-signature-glow.gif`, 48,555 bytes.
- **A GIF has one transparent colour and no partial transparency**, so the glow is composited on white. On a light
  screen it is indistinguishable from the PNG; on a dark one it sits on a small white square. So the signature keeps the
  PNG as the `prefers-color-scheme: dark` `<picture>` source (Apple Mail and iPhone Mail honour it) and loads the GIF
  everywhere else, the same split the Sato logo already uses.
- **Not proven by a real send to Gmail.** The Gmail claim rests on the 2019 Litmus table; a send-to-self is the test.

**Why:** the owner asked "check gmail and make it not static in outlook" after the PNG shipped.

**How to apply:** any new animated picture in an email goes out as a GIF with a still first frame that stands alone.
Never an APNG or WebP. Build one with a hand-written encoder only if needed: sharp 0.35.5 ignores `colours` for a palette
PNG (always 256 entries), so free the transparent index by hand (least-used colour), and prove the file by decoding it
with libvips and diffing every frame against the intended ones (0 bytes differed here). Related: [[the-approved-signature-master-is-the-svg-in-downloads]].
