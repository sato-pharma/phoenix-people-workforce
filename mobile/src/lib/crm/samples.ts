/**
 * Phoenix CRM — free samples and promotional material, on the phone.
 *
 * The transcription of the vocabulary in `src/lib/phoenix-crm/samples.ts`. `mobile/tsconfig.json`
 * maps `@/*` to `mobile/src/*` only, so the phone cannot import the web tree; this copy is pinned
 * label for label by `tests/phoenix-crm-samples.test.ts`.
 *
 * The PARSING is deliberately NOT copied. The phone sends what the rep tapped and the server cleans
 * it — one cleaner, on the side that also knows which products the line still sells. A second copy
 * here could only ever disagree with it.
 *
 * 🔴 A RECORD of what he handed over, never a stock movement: nothing subtracts, nothing is
 * allocated, and no balance exists anywhere in this app.
 */

export const SAMPLE_MATERIALS = [
  { key: "material:pen", label: "Pen" },
  { key: "material:block_note", label: "Block note" },
  { key: "material:giveaway", label: "Giveaway" },
] as const;

export const SAMPLE_QUANTITY_MAX = 99;

export type SamplesGiven = Record<string, number>;
