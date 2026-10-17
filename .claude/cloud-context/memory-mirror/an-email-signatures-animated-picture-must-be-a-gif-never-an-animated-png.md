---
name: an-email-signatures-animated-picture-must-be-a-gif-never-an-animated-png
description: "A signature's moving emblem must be an animated GIF - Gmail and Outlook for Windows show only the first frame of an animated PNG; a GIF pixel is on or off, so the glow is dotted by error diffusion at 8x (384 px, 150 KB) and the app averages it down, keeping it transparent on any ground."
metadata:
  node_type: memory
  type: reference
  originSessionId: c5dcb10a-7b1a-4e7d-b7cc-a545b5ed0ca1
  modified: 2026-10-17T09:20:53.470Z
---

The owner's email signature carries the Phoenix emblem with the Talent Acquisition banner's glow and lightning strike
(48x48 shown; 12 frames: 4,450 ms still, then eleven 50 ms strike frames, looping forever).

- **Animated PNG is the wrong format for email.** Litmus (Nov 2019) lists Gmail, the Gmail app and Outlook for Windows as
  showing only the first frame of an animated PNG; Apple Mail, iOS, Outlook.com, Yahoo and Outlook for Mac play it. The
  92 KB `phoenix-hr-signature-glow.png` therefore sat static in the two apps the owner uses most. It stays, as the
  `prefers-color-scheme: dark` `<picture>` source (Apple Mail, iPhone Mail), where its true transparency is smooth.
- **Animated GIF is what plays.** Microsoft's Outlook page says Outlook plays animated GIFs in the body by default
  (Microsoft 365, 2024, 2021) and shows the first frame only when Windows' "Show animations" is off. Shipped file:
  `public/assets/branding/phoenix-hr-signature-glow.gif`. **Not proven by a real send to Gmail** - a send-to-self is the test.
- **A GIF pixel is fully on or fully off.** Baking the glow on white (48 KB, commit cebd31bc0 on the PR branch) is smooth
  on white but leaves a white square on Gmail/Outlook dark modes. The shipped GIF instead DOTS the glow: 384x384 (8x),
  Floyd-Steinberg on the still frame's alpha, the pattern kept in every frame (the strike only adds colour, so no pixel
  is ever erased), faint-pixel colour taken from a Gaussian blur of the trusted glow (stored colour under alpha 9/255 is
  noise). 150 KB, transparent on white, grey and dark.
- **What decided the numbers.** 8x because Chrome shrinks 8:1 (1x) and 4:1 (2x) as exact mip steps; 3x was visibly
  speckled at 2x density, 6x (107 KB) still sandy. Paler-but-denser dots were REJECTED: better on white, grey fog on
  dark. Colour changes under 16/255 in the strike are dropped to save ~25 KB.

**Why:** the owner asked "check gmail and make it not static in outlook", then "the dotted must be fixed".

**How to apply:** any new animated picture in an email goes out as a GIF with a still first frame that stands alone.
Never an APNG or WebP. Measure against an INDEPENDENT reference (a Lanczos shrink of the big frame), never a
Chrome-drawn one: a reference drawn at the same ratio flatters the same-ratio file. sharp 0.35.5 ignores `colours` for a
palette PNG (always 256), so free the transparent GIF index by hand (least-used colour); prove the file by decoding it
with libvips and diffing every frame (0 bytes differed). Whether Outlook for Windows shrinks 8:1 smoothly is UNTESTED -
a crude shrink turns the halo into 1-pixel specks, not a broken picture. Related: [[the-approved-signature-master-is-the-svg-in-downloads]].
