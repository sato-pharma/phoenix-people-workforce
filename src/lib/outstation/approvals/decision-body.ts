/**
 * What the decide route accepts — judged before anything is read or written.
 *
 * Rebuilt 2026-11-23 (owner: "REBUILD FROM SCRATCH"). The route this replaces took each row WHOLE
 * (`z.looseObject({})`): the trip as the screen had loaded it, figures included, travelled back to
 * the write. Here a press is six fields and nothing else: which claim, which version of it, the
 * action, an amount, a reason, and "keep the full claim" said out loud. Every figure that is paid is
 * read on the server.
 */

import { z } from "zod";

/** One request never decides more than this many claims; the Ready lane is far below it. */
export const DESK_DECISION_LIMIT = 100;

export const DeskDecideBodySchema = z.strictObject({
  decisions: z
    .array(
      z.strictObject({
        action: z.enum(["approve", "reduce", "reject"]),
        approvedAmount: z.number().finite().positive().max(10_000_000).nullable().optional(),
        comment: z.string().max(2000).nullable().optional(),
        keepFull: z.boolean().optional(),
        requestId: z.number().int().positive(),
        revision: z.string().min(1).max(200),
      }),
    )
    .min(1)
    .max(DESK_DECISION_LIMIT),
});

export type DeskDecideBody = z.infer<typeof DeskDecideBodySchema>;

/**
 * "Save amounts" on one claim: the four parts he typed, the version he saw, and the reason. The
 * figures are the ones he sets (owner, 24 Nov 2026: any figure, above the claim too); each is
 * capped at the same EGP 1,000,000 the stored edit is read with (hr-amounts.ts).
 */
const part = z.number().finite().min(0).max(1_000_000);

export const DeskAmountsBodySchema = z.strictObject({
  parts: z.strictObject({ allowance: part, meeting: part, other: part, travel: part }),
  reason: z.string().max(2000),
  requestId: z.number().int().positive(),
  revision: z.string().min(1).max(200),
});

export type DeskAmountsBody = z.infer<typeof DeskAmountsBodySchema>;
