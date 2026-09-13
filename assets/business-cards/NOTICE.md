# Business card assets

- `business-card-template.pdf` — cut from the owner-approved Sato Pharma business card (Canva
  export, spacing fixed 2026-09-12). Page 1 is the front without its text or contact icons, page 2 is
  the back, both with a 3 mm bleed and a TrimBox. Page 3 carries the four contact icons alone. Nothing
  was redrawn: each page keeps a subset of the design's own PDF content. On 2026-09-13, at the
  owner's request, the back logo (a 355×134 CMYK JPEG whose dark background is lighter than the
  card's ink, so it showed as a box) gained a soft mask built from its own pixels: its background is
  transparent, its letters opaque. The JPEG bytes and every page box are unchanged. Read by
  `src/lib/business-cards/render-pdf.ts`; never served from `public/`.
- `Montserrat-Bold.ttf`, `Montserrat-Regular.ttf` — Montserrat Version 7.200, the typeface the card
  was designed in (glyph advances identical to the subsets Canva embedded).
  Copyright 2011 The Montserrat Project Authors (https://github.com/JulietaUla/Montserrat).
  Licensed under the SIL Open Font License, Version 1.1 — http://scripts.sil.org/OFL.
  Embedding in documents is permitted (OS/2 `fsType` 0).
