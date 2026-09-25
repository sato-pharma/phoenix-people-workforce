---
name: sharp-extract-then-stats-measures-the-source-image
description: "sharp's .stats() reports the SOURCE image and silently ignores every operation queued before it, so extract().stats() measures the whole page, not the crop"
metadata:
  type: reference
---

```js
await sharp(bytes).extract({ left, top, width, height }).stats()   // measures the WHOLE image
```

`.stats()` does **not** run the queued pipeline. It reads the input, so `extract`, `resize`,
`grayscale` and everything else chained before it are silently discarded. No error, no warning —
just numbers for a region you did not ask about.

**Why:** this cost two full debug cycles on `tests/hiring-document-capture.test.ts` (2026-08-22).
A "is the seal still coloured?" helper cropped to the seal and asked for channel statistics; the
assertion failed at 5.2, was "fixed", and failed at **exactly 5.2 again** — the identical number
being the tell that nothing about the measurement had changed. It was reporting the average of the
entire mostly-white page both times.

**How to apply:** materialise the crop before measuring it.

```js
const cropped = await sharp(bytes).extract({ left, top, width, height }).raw().toBuffer();
const stats = await sharp(cropped, { raw: { channels: 3, width: size, height: size } }).stats();
```

An identical failing number across a "fix" means the measurement, not the subject, is wrong.
Related: [[prove-it-fails-verify-which-assertion-fired]],
[[sharp-is-a-devdependency-that-two-production-paths-import]].
