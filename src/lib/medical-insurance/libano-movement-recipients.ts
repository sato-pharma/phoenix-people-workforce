// Who the additions and deletions email to Libano-Suisse goes to (owner, 27 Nov 2026), fixed in code and never
// typed on the page. Its own file, with no imports, so the page's confirm panel shows the very addresses the
// server sends to (./libano-movement-email.ts builds and sends it).

/** The insurer's policy administration: the To of every additions and deletions email. */
export const LIBANO_POLICY_ADMIN_EMAIL = "Policy.Admin@Libano-suisse-takaful.com";
/** The insurer's account manager for Sato Pharma: copied on every additions and deletions email. */
export const LIBANO_ACCOUNT_MANAGER_EMAIL = "ahmed.elshazly@libano-suisse-takaful.com";
/** The owner's own mailbox: copied, and where a reply lands. */
export const LIBANO_EMAIL_OWNER_COPY = "omar.anwar@satopharma.com";

export const LIBANO_MOVEMENT_EMAIL_TO: readonly string[] = [LIBANO_POLICY_ADMIN_EMAIL];
export const LIBANO_MOVEMENT_EMAIL_CC: readonly string[] = [LIBANO_ACCOUNT_MANAGER_EMAIL, LIBANO_EMAIL_OWNER_COPY];

/**
 * A TEST send goes here alone: the same email and the same file, to the owner and nobody at the insurer, so he
 * can open the file before the real one leaves (owner, 27 Nov 2026: "make send and test send"). His work
 * mailbox, never a personal address: this repository is public.
 */
export const LIBANO_MOVEMENT_TEST_TO: readonly string[] = [LIBANO_EMAIL_OWNER_COPY];
