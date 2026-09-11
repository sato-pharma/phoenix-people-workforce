/**
 * WHO MAY CHANGE WHERE A TEMPLATE'S MAIL GOES, AS OPPOSED TO WHAT IT SAYS.
 *
 * 🔴 THE HOLE THIS CLOSES. Until 2026-09-11 `communication: update` was held by Super Admin alone,
 * so every field on an email template was Super-Admin-only by ACCIDENT. Granting `hr_communication`
 * to the HR Business Partner made that accident load-bearing, and a template carries two kinds of
 * field that are not alike at all:
 *
 *   WHAT IT SAYS - subject, greeting, body, closing. Editing these is the whole point of the grant.
 *   WHERE IT GOES - toStaticEmails, ccStaticEmails, bccStaticEmails, and isActive.
 *
 * A static address is a permanent extra recipient on every send of that template. One save adding a
 * personal address to `bccStaticEmails` on the offer letter copies every future offer, and the same
 * shape reaches resignation notices, contracts and probation outcomes. THREE CONTROLS THAT LOOK
 * LIKE THEY WOULD CATCH IT DO NOT:
 *
 *   * The Recipient Assurance Guard is handed these addresses as `externalRecipients` ON PURPOSE -
 *     the one control designed to refuse an unrecognised address is told this one is deliberate.
 *   * An off-domain static address is a health WARNING worth -10, never a refusal.
 *   * The confidence gate never holds a send this small, so a 1-recipient mail becoming 2 is inside
 *     tolerance by design.
 *
 * `isActive` is the mirror image: turning the password-reset template off ends every password-reset
 * mail company-wide, and `action: "save"` requires no change reason, unlike `"publish"`.
 *
 * 🔴 THE CHECK IS ON THE CHANGE, NOT ON THE FIELD BEING PRESENT. The designer sends the whole rules
 * object back on every save, so refusing any payload that MENTIONS these fields would block every
 * ordinary content edit and read as a broken screen. Compare against what is stored, and refuse
 * only a real difference. That also means an empty or absent field cannot be used to clear one.
 */

export type PrivilegedTemplateFieldsInput = {
  /** The stored template, or null for one that does not exist yet. */
  stored: { isActive?: boolean; rules?: Partial<TemplateStaticRecipients> } | null;
  /**
   * The incoming payload, as posted. Absent fields are "no change", never "clear it".
   *
   * Deliberately open-ended: the route hands this the WHOLE request body, which also carries the
   * subject, greeting and body a content edit changes. Narrowing it to the two fields this guard
   * reads would force the caller to pick them out by hand, and a caller picking fields out by hand
   * is a caller that can forget one.
   */
  payload: { isActive?: boolean; rules?: Partial<TemplateStaticRecipients> } & Record<string, unknown>;
  /** The role resolved on the SERVER, never anything the caller can write. */
  role: string | null | undefined;
};

type TemplateStaticRecipients = {
  bccStaticEmails: string[];
  ccStaticEmails: string[];
  toStaticEmails: string[];
};

const STATIC_RECIPIENT_FIELDS = ["toStaticEmails", "ccStaticEmails", "bccStaticEmails"] as const;

/** Address lists are a SET, not a sequence — reordering the same addresses is not a change. */
function normalizeAddresses(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return Array.from(
    new Set(
      value
        .map((entry) => String(entry ?? "").trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    ),
  )
    .sort()
    .join(",");
}

/**
 * Returns a plain refusal reason when this caller may not make this change, else null.
 * Super Admin is never refused.
 */
export function refusePrivilegedTemplateChange(input: PrivilegedTemplateFieldsInput): string | null {
  if (input.role === "Super Admin") return null;

  for (const field of STATIC_RECIPIENT_FIELDS) {
    const incoming = input.payload.rules?.[field];
    if (incoming === undefined) continue;
    if (normalizeAddresses(incoming) !== normalizeAddresses(input.stored?.rules?.[field])) {
      return `Fixed ${field === "toStaticEmails" ? "To" : field === "ccStaticEmails" ? "Cc" : "Bcc"} addresses on an email template are Super Admin only. A fixed address is added to every send of this template.`;
    }
  }

  if (input.payload.isActive !== undefined && input.payload.isActive !== (input.stored?.isActive ?? false)) {
    return "Switching an email template on or off is Super Admin only. It changes whether that mail is sent at all, company-wide.";
  }

  return null;
}
