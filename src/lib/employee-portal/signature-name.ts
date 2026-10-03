/**
 * The name an identity banner signs with: the full name, with a middle name cut to its initial once
 * there are three parts or more — "Hager Nabil Abdelmaged" → "Hager N. Abdelmaged".
 *
 * This is the portal banner's own rule (`displaySignatureName` in the design-locked
 * `identity-card.tsx`), restated here because that component exports nothing. The performance card's
 * banner must sign with the name the rep sees on his own portal, so `tests/rep-performance-card.test.ts`
 * pins this function AND the banner's copy of the rule — a change to one without the other fails it.
 *
 * Pure and dependency-free on purpose: the test imports it without loading the card's database layer.
 */
export function signatureNameFor(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 3) return parts.join(" ");
  return `${parts[0]} ${parts[1].charAt(0).toUpperCase()}. ${parts[parts.length - 1]}`;
}
