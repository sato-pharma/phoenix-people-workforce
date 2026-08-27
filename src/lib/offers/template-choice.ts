/**
 * Which letter design an offer opens on.
 *
 * ── Why this is its own module ──
 * The composer is a client component and the job-title catalogue lives in `service.ts`, which
 * reaches for `getSupabaseAdmin()`. Importing that into the browser bundle to answer a question
 * about two arrays already in memory would ship the service-role client to the client. These are
 * pure functions over data the screen already holds, so both sides can share one answer.
 *
 * ── The one rule worth stating ──
 * A title's binding is a STARTING POINT, never a lock. Whoever is writing the offer can always
 * change the template afterwards, and choosing a title that has no binding must not undo a choice
 * they already made. That is why the "no answer" case here is `null` and not "the default" — the
 * caller decides whether null means *fall back* or *leave it alone*, and those are different
 * answers in different places.
 */

import type { OfferJobTitle, OfferTemplate } from "@/lib/offers/types";

/**
 * The same normalisation the catalogue's unique index uses — `lower(btrim(title))`.
 *
 * "Medical Representative" and "Medical representative " must resolve to one row, because the
 * database already refuses to store them as two and a lookup that disagreed with the constraint
 * would find nothing for a title that certainly exists.
 */
function normaliseTitle(title: string): string {
  return title.trim().toLowerCase();
}

/** The catalogue row for a typed title, or null when the title is not in the catalogue. */
export function findOfferJobTitle<T extends { title: string }>(title: string, catalogue: T[]): T | null {
  const wanted = normaliseTitle(title);
  if (!wanted) return null;
  return catalogue.find((entry) => normaliseTitle(entry.title) === wanted) ?? null;
}

/**
 * Whichever template new offers open on when nothing else has been decided.
 *
 * Falls through to the first template rather than returning nothing, because a workspace with
 * templates but no `isDefault` row — possible for a moment while the flag is being moved — must
 * still render a letter rather than an empty screen. Empty string only when there are no templates
 * at all, which the composer already treats as "cannot compose".
 */
export function defaultOfferTemplateId(templates: Pick<OfferTemplate, "id" | "isDefault">[]): string {
  return templates.find((template) => template.isDefault)?.id ?? templates[0]?.id ?? "";
}

/**
 * The design bound to a job title, or null if it has none.
 *
 * A binding pointing at a template that no longer exists resolves to null rather than to the dead
 * id. The database clears these itself (`on delete set null`), but a screen holding a list loaded
 * before the deletion would otherwise put a dead id into the picker, and a `<select>` whose value
 * matches no option renders blank — which reads as "no template" while actually meaning "a
 * template you cannot see".
 */
export function offerTemplateIdForTitle(
  title: string,
  catalogue: Pick<OfferJobTitle, "templateId" | "title">[],
  templates: Pick<OfferTemplate, "id">[],
): string | null {
  const match = findOfferJobTitle(title, catalogue);
  if (!match?.templateId) return null;
  return templates.some((template) => template.id === match.templateId) ? match.templateId : null;
}
