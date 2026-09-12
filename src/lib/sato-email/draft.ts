import type { SatoEmailDraft } from "./service";

/**
 * One reader for what the composer posts, shared by the preview route and the send route.
 *
 * 🔴 THE REASON IT IS SHARED RATHER THAN WRITTEN TWICE. The preview is the sender's only sight of
 * who a send reaches — the confirm step prints that count and they press Send on the strength of
 * it. If the two routes parsed the body even slightly differently (one trimming a list key, one
 * not; one accepting a subject the other rejects), the preview would be describing a different
 * email from the one that goes out, and nothing on screen would say so. Same reader, same draft.
 */
export type ParsedDraft = { draft: SatoEmailDraft } | { message: string };

function stringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  if (!value.every((item) => typeof item === "string")) return null;
  return Array.from(new Set((value as string[]).map((item) => item.trim()).filter(Boolean)));
}

export function parseSatoEmailDraft(body: Record<string, unknown>): ParsedDraft {
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  if (!subject) return { message: "A subject is required." };
  if (subject.length > 200) return { message: "A subject must be 200 characters or fewer." };

  const bodyHtml = typeof body.bodyHtml === "string" ? body.bodyHtml.trim() : "";
  if (!bodyHtml) return { message: "The email body is empty." };

  const listKeys = stringArray(body.listKeys);
  if (!listKeys) return { message: "listKeys must be an array of strings." };
  const hrIds = stringArray(body.hrIds);
  if (!hrIds) return { message: "hrIds must be an array of strings." };
  if (listKeys.length === 0 && hrIds.length === 0) {
    return { message: "Choose at least one distribution list or colleague." };
  }

  // Attachments go through the same reader as everything else, so the preview totals the same files
  // the send will carry. They are ids of already-uploaded rows, never bytes: the upload happened at
  // /api/admin/sato-email/media under its own gate, and this route only names what to clip on.
  const attachmentIds = stringArray(body.attachmentIds);
  if (!attachmentIds) return { message: "attachmentIds must be an array of strings." };
  if (attachmentIds.some((id) => !/^[0-9a-fA-F-]{36}$/.test(id))) {
    return { message: "An attachment id is not valid." };
  }

  const clientRequestId = typeof body.clientRequestId === "string" ? body.clientRequestId.trim() : "";
  // Not optional, and not generated here. It is what makes a double-click send once: a key minted
  // server-side would be different on the second request, which is the failure it exists to stop.
  if (!clientRequestId) return { message: "clientRequestId is required." };

  const signOff = typeof body.signOff === "string" ? body.signOff.trim() : "";
  const templateKey = typeof body.templateKey === "string" && body.templateKey.trim() ? body.templateKey.trim() : null;
  const externalJustification =
    typeof body.externalJustification === "string" && body.externalJustification.trim()
      ? body.externalJustification.trim()
      : null;

  return { draft: { attachmentIds, bodyHtml, clientRequestId, externalJustification, hrIds, listKeys, signOff, subject, templateKey } };
}
