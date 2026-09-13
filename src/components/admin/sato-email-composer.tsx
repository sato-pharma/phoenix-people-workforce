"use client";

import {
  AlertTriangle,
  AtSign,
  Check,
  Eye,
  Loader2,
  Mail,
  Paperclip,
  Plus,
  Search,
  Send,
  Sparkles,
  Undo2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import { AdminSectionHeader } from "@/components/admin/admin-design-system";
import { EmailBodyEditor } from "@/components/admin/email-body-editor";
import { SatoEmailListPicker } from "@/components/admin/sato-email-list-picker";
import {
  SATO_EMAIL_ATTACHMENT_ACCEPT,
  SATO_EMAIL_INLINE_ACCEPT,
  SATO_EMAIL_MEDIA_MAX_FILES,
  formatBytes,
} from "@/lib/sato-email/media-limits";
import {
  SATO_EMAIL_MAX_TYPED_ADDRESSES,
  isOutsideCompanyAddress,
  parseTypedEmailAddresses,
} from "@/lib/sato-email/typed-recipients";

export type SatoTemplateView = {
  bodyHtml: string;
  isActive: boolean;
  name: string;
  sortOrder: number;
  subject: string;
  templateKey: string;
};

export type SatoListView = {
  coveredBy: string[];
  description: string;
  label: string;
  listKey: string;
};

export type SatoPersonView = {
  displayName: string;
  email: string;
  hrId: string;
  jobTitle: string | null;
  where: string | null;
};

type PreviewView = {
  attachmentProblem: string | null;
  attachments: Array<{ byteSize: number; filename: string; id: string }>;
  audience: {
    recipients: Array<{ email: string; hrId: string | null; name: string }>;
    skipped: Array<{ displayName: string; hrId: string; reason: string }>;
    warnings: string[];
  };
  emailCount: number;
  html: string;
  outsideAddresses: string[];
  placeholders: string[];
  recipientCount: number;
  recipientProblem: string | null;
};

/** Mirrors MAX_MATCHES in app/api/admin/sato-email/employees/route.ts, so the screen can say it is a cap. */
const SEARCH_MATCH_CAP = 25;

type SendResultView = {
  emailCount: number;
  outcomes: Array<{ batchIndex: number; id: string | null; reason: string | null; recipients: number; status: string }>;
  recipientCount: number;
  skippedReason: string | null;
  status: "sent" | "partial" | "skipped" | "failed";
};

const CARD = "rounded-2xl border border-phx-line bg-white p-5 shadow-[0_10px_28px_rgba(15,23,42,0.06)]";
const FIELD = "w-full rounded-lg border border-phx-line bg-phx-paper px-3 py-2.5 text-sm text-phx-ink";
const DARK_BUTTON =
  "inline-flex h-[42px] items-center justify-center gap-1.5 rounded-lg bg-[#0B0B0B] px-4 text-phx-xs font-black text-white transition hover:bg-[#1E293B] disabled:opacity-50";
const PALE_BUTTON =
  "inline-flex h-[42px] items-center justify-center gap-1.5 rounded-lg border border-phx-line bg-white px-4 text-phx-xs font-black text-phx-ink transition hover:bg-phx-paper disabled:opacity-50";

function newRequestId() {
  return `sato-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The Sato Email Composer.
 *
 * Owner 2026-09-11: a composer with fixed templates he can "flip" out of to free-type, addressed to
 * the distribution lists, for the HR Business Partner and the system administrator, wearing the
 * Sato identity.
 *
 * 🔴 SEND IS NEVER THE FIRST PRESS. Preview resolves the audience live and prints the exact count;
 * only then does Send appear, and it asks once more with that number in the sentence. A hand-written
 * email to a distribution list cannot be recalled, and "I thought that list was smaller" is the
 * mistake this shape exists to prevent. Every change to the draft clears the preview, so the number
 * on screen is never describing an older email than the one about to go.
 */
export function SatoEmailComposer({
  initialLists,
  initialTemplates,
  loadWarnings,
}: {
  initialLists: SatoListView[];
  initialTemplates: SatoTemplateView[];
  loadWarnings: string[];
}) {
  const [templates, setTemplates] = useState(initialTemplates);
  const [mode, setMode] = useState<"template" | "free">(initialTemplates.length > 0 ? "template" : "free");
  const [templateKey, setTemplateKey] = useState<string>("");
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [signOff, setSignOff] = useState("Human Resources");
  // Files clipped to the mail. A body PICTURE is not here: it lives in bodyHtml as an <img>, which
  // is the whole difference between the two halves of what the owner asked for.
  const [attachments, setAttachments] = useState<Array<{ byteSize: number; filename: string; id: string }>>([]);
  const [uploading, setUploading] = useState(false);

  const [listKeys, setListKeys] = useState<string[]>([]);
  const [people, setPeople] = useState<SatoPersonView[]>([]);
  const [term, setTerm] = useState("");
  const [matches, setMatches] = useState<SatoPersonView[]>([]);
  const [searching, setSearching] = useState(false);
  // "Choose people yourself": tick colleagues from a search, or type addresses by hand.
  const [chooseBy, setChooseBy] = useState<"search" | "type">("search");
  const [emails, setEmails] = useState<string[]>([]);
  const [emailText, setEmailText] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [externalJustification, setExternalJustification] = useState("");
  // What the SERVER last called outside. Kept across invalidation on purpose: typing the reason
  // clears the preview, and the reason box must not vanish under the sender's cursor as it does.
  const [serverOutside, setServerOutside] = useState<string[]>([]);

  // The rewrite. `polished` holds what the sender wrote immediately before it, which is the whole
  // of Undo: his own words are never sent anywhere to be fetched back, they are simply still here.
  const [nudge, setNudge] = useState("");
  const [polishing, setPolishing] = useState(false);
  const [polished, setPolished] = useState<{ bodyHtml: string; changes: string[]; subject: string } | null>(null);

  const [clientRequestId, setClientRequestId] = useState(newRequestId);
  const [preview, setPreview] = useState<PreviewView | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"preview" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SendResultView | null>(null);

  // Any edit invalidates the preview. A count left on screen beside a changed audience is a lie the
  // sender has no way to spot.
  const invalidate = useCallback(() => {
    setPreview(null);
    setConfirming(false);
    setResult(null);
  }, []);

  const draft = useMemo(
    () => ({
      attachmentIds: attachments.map((file) => file.id),
      bodyHtml,
      clientRequestId,
      emails,
      externalJustification: externalJustification.trim() || null,
      hrIds: people.map((person) => person.hrId),
      listKeys,
      signOff,
      subject,
      templateKey: mode === "template" && templateKey ? templateKey : null,
    }),
    [attachments, bodyHtml, clientRequestId, emails, externalJustification, listKeys, mode, people, signOff, subject, templateKey],
  );

  const canCompose = Boolean(
    subject.trim() && bodyHtml.trim() && (listKeys.length > 0 || people.length > 0 || emails.length > 0),
  );
  const needsReason = emails.filter((email) => isOutsideCompanyAddress(email) || serverOutside.includes(email));

  /**
   * Put one file in the store and hand back what the caller needs.
   *
   * The same call for both halves of the feature; `kind` is the whole difference. An `inline`
   * upload comes back with a permanent public address for the <img>, an `attachment` comes back
   * with an id and no address at all, because its bytes only ever travel inside the message.
   */
  const uploadOne = useCallback(
    async (file: File, kind: "attachment" | "inline") => {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", kind);
      const response = await fetch("/api/admin/sato-email/media", { body: form, method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as {
        file?: { byteSize: number; filename: string; id: string; url: string | null };
        message?: string;
      };
      if (!response.ok || !payload.file) throw new Error(payload.message ?? "The file could not be uploaded.");
      return payload.file;
    },
    [],
  );

  /**
   * The toolbar Insert image button, wired to the sender own machine.
   *
   * Returns an empty string rather than throwing when it fails, because the editor has nowhere to
   * show a message and this screen does.
   */
  const uploadBodyPicture = useCallback(
    async (file: File) => {
      setUploading(true);
      setError(null);
      try {
        const stored = await uploadOne(file, "inline");
        return stored.url ?? "";
      } catch (uploadError) {
        setError(uploadError instanceof Error ? uploadError.message : "The picture could not be uploaded.");
        return "";
      } finally {
        setUploading(false);
      }
    },
    [uploadOne],
  );

  async function attachFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const stored = await uploadOne(file, "attachment");
        setAttachments((current) =>
          current.some((existing) => existing.id === stored.id)
            ? current
            : [...current, { byteSize: stored.byteSize, filename: stored.filename, id: stored.id }],
        );
      }
      // The email is a different email now, so the count and the preview beside it are stale.
      invalidate();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "The file could not be uploaded.");
    } finally {
      setUploading(false);
    }
  }

  function applyTemplate(key: string) {
    setTemplateKey(key);
    const template = templates.find((item) => item.templateKey === key);
    if (!template) return;
    setSubject(template.subject);
    setBodyHtml(template.bodyHtml);
    setPolished(null);
    invalidate();
  }

  /**
   * Puts the draft into the company's voice. Nothing is saved and nothing is sent — the rewritten
   * wording lands straight back in the two fields the sender was already editing, and the preview
   * is invalidated with it, so a recipient count on screen can never belong to the older draft.
   */
  async function polish() {
    setPolishing(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/sato-email/polish", {
        body: JSON.stringify({ bodyHtml, instruction: nudge, subject }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as {
        message?: string;
        result?: { bodyHtml: string; changes: string[]; subject: string };
      };
      if (!response.ok || !payload.result) {
        setError(payload.message ?? "The rewrite could not be produced.");
        return;
      }
      // His own words, kept here and nowhere else, so Undo is exact rather than approximate.
      setPolished({ bodyHtml, changes: payload.result.changes, subject });
      setSubject(payload.result.subject);
      setBodyHtml(payload.result.bodyHtml);
      invalidate();
    } catch {
      setError("The rewrite could not be produced.");
    } finally {
      setPolishing(false);
    }
  }

  function undoPolish() {
    if (!polished) return;
    setSubject(polished.subject);
    setBodyHtml(polished.bodyHtml);
    setPolished(null);
    invalidate();
  }

  async function search(value: string) {
    setTerm(value);
    if (value.trim().length < 2) {
      setMatches([]);
      return;
    }
    setSearching(true);
    try {
      const response = await fetch(`/api/admin/sato-email/employees?q=${encodeURIComponent(value.trim())}`);
      const payload = (await response.json()) as { employees?: SatoPersonView[] };
      setMatches(response.ok ? (payload.employees ?? []) : []);
    } catch {
      setMatches([]);
    } finally {
      setSearching(false);
    }
  }

  /** One press adds a colleague, the next removes them — the results stay open for the next pick. */
  function togglePerson(match: SatoPersonView) {
    setPeople((current) =>
      current.some((person) => person.hrId === match.hrId)
        ? current.filter((person) => person.hrId !== match.hrId)
        : [...current, match],
    );
    invalidate();
  }

  function tickAllShown() {
    setPeople((current) => [...current, ...matches.filter((match) => !current.some((person) => person.hrId === match.hrId))]);
    invalidate();
  }

  /**
   * Moves every good address out of the box and leaves only what still needs the sender's eye —
   * a typo stays where he typed it, with the reason beside it, rather than disappearing.
   */
  function addTypedAddresses() {
    const { invalid, valid } = parseTypedEmailAddresses(emailText);
    const fresh = valid.filter((email) => !emails.includes(email));
    const accepted = fresh.slice(0, Math.max(0, SATO_EMAIL_MAX_TYPED_ADDRESSES - emails.length));
    const overflow = fresh.slice(accepted.length);

    if (accepted.length > 0) {
      setEmails((current) => [...current, ...accepted]);
      invalidate();
    }
    setEmailText([...invalid, ...overflow].join(", "));

    if (invalid.length > 0) {
      setEmailError(
        invalid.length === 1
          ? `"${invalid[0]}" is not an email address. Correct it and add again.`
          : `These are not email addresses: ${invalid.join(", ")}. Correct them and add again.`,
      );
    } else if (overflow.length > 0) {
      setEmailError(`You can type up to ${SATO_EMAIL_MAX_TYPED_ADDRESSES} addresses. An audience that size belongs on a distribution list.`);
    } else if (valid.length > 0 && accepted.length === 0) {
      setEmailError(valid.length === 1 ? "That address is already added." : "Those addresses are already added.");
    } else {
      setEmailError(null);
    }
  }

  function clearChosen() {
    setPeople([]);
    setEmails([]);
    invalidate();
  }

  async function runPreview() {
    setBusy("preview");
    setError(null);
    try {
      const response = await fetch("/api/admin/sato-email/preview", {
        body: JSON.stringify(draft),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as { message?: string; preview?: PreviewView };
      if (!response.ok || !payload.preview) {
        setError(payload.message ?? "The preview could not be built.");
        return;
      }
      setPreview(payload.preview);
      setServerOutside(payload.preview.outsideAddresses ?? []);
      setConfirming(false);
    } catch {
      setError("The preview could not be built.");
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    setBusy("send");
    setError(null);
    try {
      const response = await fetch("/api/admin/sato-email/send", {
        body: JSON.stringify(draft),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as { message?: string; result?: SendResultView };
      if (!response.ok || !payload.result) {
        setError(payload.message ?? "The email could not be sent.");
        return;
      }
      setResult(payload.result);
      setPreview(null);
      setConfirming(false);
      // A fresh key, so the next email is a new send rather than a silent no-op against the last
      // one's idempotency key.
      setClientRequestId(newRequestId());
    } catch {
      setError("The email could not be sent.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      {loadWarnings.length > 0 ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900">
          {loadWarnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      ) : null}

      {/* Owner 2026-09-13: "make preview and send direct under the place where i write the email".
          On desktop the page is two columns — writing, then preview and send beneath it, on the
          left; the audience on the right, spanning both rows. `auto_1fr` lets the first row take
          the writing card's own height, so a tall audience column never opens a gap between the
          email and its Send button. On a phone it is one column in DOM order — write, pick who, then
          send — because a Send button above the audience would ask for a count of nobody. */}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] xl:grid-rows-[auto_1fr] xl:items-start">
        {/* ---------------------------------------------------------------- what it says */}
        <section className="space-y-4 xl:col-start-1 xl:row-start-1">
          <AdminSectionHeader
            description="Start from a fixed template or write the whole email yourself — the switch below flips between the two, and either way you can edit every word before sending."
            title="What it says"
          />
          <div className={CARD}>
          <div className="flex flex-wrap gap-2">
            <button
              className={mode === "template" ? DARK_BUTTON : PALE_BUTTON}
              onClick={() => {
                setMode("template");
                invalidate();
              }}
              type="button"
            >
              Fixed template
            </button>
            <button
              className={mode === "free" ? DARK_BUTTON : PALE_BUTTON}
              onClick={() => {
                setMode("free");
                setTemplateKey("");
                invalidate();
              }}
              type="button"
            >
              Free type
            </button>
          </div>

          {mode === "template" ? (
            <div className="mt-4">
              <label className="text-phx-xs font-black uppercase tracking-wide text-phx-ink-2" htmlFor="sato-template">
                Template
              </label>
              <select
                className={`mt-2 ${FIELD}`}
                id="sato-template"
                onChange={(event) => applyTemplate(event.target.value)}
                value={templateKey}
              >
                <option value="">Choose a template…</option>
                {templates
                  .filter((template) => template.isActive)
                  .map((template) => (
                    <option key={template.templateKey} value={template.templateKey}>
                      {template.name}
                    </option>
                  ))}
              </select>
              <p className="mt-2 text-xs font-semibold text-phx-ink-faint">
                Anything in [square brackets] is a gap for you to fill. Nothing is filled in automatically.
              </p>
            </div>
          ) : null}

          <div className="mt-4">
            <label className="text-phx-xs font-black uppercase tracking-wide text-phx-ink-2" htmlFor="sato-subject">
              Subject
            </label>
            <input
              className={`mt-2 ${FIELD}`}
              id="sato-subject"
              maxLength={200}
              onChange={(event) => {
                setSubject(event.target.value);
                setPolished(null);
                invalidate();
              }}
              placeholder="What this email is about"
              value={subject}
            />
          </div>

          <div className="mt-4">
            <span className="text-phx-xs font-black uppercase tracking-wide text-phx-ink-2">Body</span>
            <div className="mt-2">
              <EmailBodyEditor
                hiddenActions={["Action button"]}
                imageAccept={SATO_EMAIL_INLINE_ACCEPT}
                onChange={(next) => {
                  setBodyHtml(next);
                  setPolished(null);
                  invalidate();
                }}
                uploadImage={uploadBodyPicture}
                value={bodyHtml}
                variables={[]}
              />
            </div>
            <p className="mt-2 text-xs font-semibold text-phx-ink-faint">
              The picture button in the toolbar puts a picture from your computer straight into the message.
              A picture in the body has to be fetched from the web when somebody opens the email, so anyone
              who has the link can see it &mdash; put a company document in the attachments below instead.
            </p>
          </div>

          {/* ------------------------------------------------------------------ attachments */}
          <div className="mt-4">
            <span className="text-phx-xs font-black uppercase tracking-wide text-phx-ink-2">Attachments</span>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className={`${PALE_BUTTON} cursor-pointer`}>
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                {uploading ? "Uploading" : "Attach a picture or file"}
                <input
                  accept={SATO_EMAIL_ATTACHMENT_ACCEPT}
                  className="hidden"
                  disabled={uploading || attachments.length >= SATO_EMAIL_MEDIA_MAX_FILES}
                  multiple
                  onChange={(event) => {
                    const chosen = event.target.files;
                    // Cleared first, so the same file can be attached again after a failure.
                    event.target.value = "";
                    void attachFiles(chosen);
                  }}
                  type="file"
                />
              </label>
              {attachments.map((file) => (
                <span
                  className="inline-flex items-center gap-2 rounded-lg border border-phx-line bg-phx-paper px-3 py-2 text-phx-xs font-black text-phx-ink"
                  key={file.id}
                >
                  {file.filename}
                  <span className="font-semibold text-phx-ink-faint">{formatBytes(file.byteSize)}</span>
                  <button
                    aria-label={`Remove ${file.filename}`}
                    onClick={() => {
                      setAttachments((current) => current.filter((entry) => entry.id !== file.id));
                      invalidate();
                    }}
                    type="button"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              ))}
            </div>
            <p className="mt-2 text-xs font-semibold text-phx-ink-faint">
              Attachments travel inside the email, so only the people you send it to can open them. Up to
              {" "}{SATO_EMAIL_MEDIA_MAX_FILES} files, and 10 MB in total &mdash; over that the send is refused
              rather than quietly dropping a file.
            </p>
          </div>

          <div className="mt-3 rounded-xl border border-phx-line bg-phx-paper p-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                className={DARK_BUTTON}
                disabled={polishing || !bodyHtml.trim()}
                onClick={() => void polish()}
                type="button"
              >
                {polishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {polishing ? "Rewriting" : "Rewrite it"}
              </button>
              <input
                className={`${FIELD} h-[42px] min-w-[220px] flex-1`}
                maxLength={200}
                onChange={(event) => setNudge(event.target.value)}
                placeholder="Optional — shorter, warmer, lead with the deadline"
                value={nudge}
              />
            </div>
            <p className="mt-2 text-xs font-semibold text-phx-ink-faint">
              Write it however it comes out. This says the same thing in the company&apos;s voice — shorter, plainer,
              more corporate. It never adds a date, a figure, a link or anything inside [square brackets] that you did
              not write yourself, and it refuses rather than guess.
            </p>

            {polished ? (
              <div className="mt-3 rounded-lg border border-phx-line bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-phx-xs font-black uppercase tracking-wide text-phx-ink-2">What changed</span>
                  <button className={PALE_BUTTON} onClick={undoPolish} type="button">
                    <Undo2 className="h-4 w-4" />
                    Put my words back
                  </button>
                </div>
                {polished.changes.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {polished.changes.map((change) => (
                      <li className="text-sm font-semibold text-phx-ink" key={change}>
                        {change}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm font-semibold text-phx-ink">The wording was tightened.</p>
                )}
                <p className="mt-2 text-xs font-semibold text-phx-ink-faint">
                  Read it before you send it. Edit it freely — this panel closes as soon as you do.
                </p>
              </div>
            ) : null}
          </div>

          <div className="mt-4">
            <label className="text-phx-xs font-black uppercase tracking-wide text-phx-ink-2" htmlFor="sato-signoff">
              Signed
            </label>
            <input
              className={`mt-2 ${FIELD}`}
              id="sato-signoff"
              onChange={(event) => {
                setSignOff(event.target.value);
                invalidate();
              }}
              placeholder="Human Resources"
              value={signOff}
            />
          </div>
          </div>
        </section>

        {/* ------------------------------------------------------------- who it reaches */}
        <section className="space-y-4 xl:col-start-2 xl:row-span-2 xl:row-start-1">
          <AdminSectionHeader
            description="Pick a distribution list, choose people yourself, or both. Recipients never see each other's addresses."
            title="Who it reaches"
          />
          <div className={CARD}>
          <SatoEmailListPicker
            lists={initialLists}
            onChange={(next) => {
              setListKeys(next);
              invalidate();
            }}
            selected={listKeys}
          />

          {/* ------------------------------------------------ choose people yourself */}
          {/* Owner 2026-09-13: "make an option to manual search and choose single or multiple
              reciepients and option to manually write emails my self". */}
          <div className="mt-6 border-t border-phx-line pt-5">
            <div className="flex items-center gap-2.5">
              <UserPlus className="h-4 w-4 shrink-0 text-orange-700" />
              <h3 className="text-sm font-black text-phx-ink">Choose people yourself</h3>
            </div>
            <p className="mt-1 text-xs font-semibold leading-5 text-phx-ink-soft">
              Search colleagues and tick one or as many as you need, or type email addresses by hand. Use it on its
              own or on top of a list.
            </p>

            <div aria-label="How to choose people" className="mt-3 grid grid-cols-2 border border-phx-line" role="tablist">
              {(
                [
                  ["search", "Search colleagues", Search],
                  ["type", "Type addresses", AtSign],
                ] as const
              ).map(([key, label, Icon]) => {
                const active = chooseBy === key;
                return (
                  <button
                    aria-selected={active}
                    className={`relative flex min-h-[44px] items-center justify-center gap-1.5 px-2 py-1.5 text-center text-phx-xs font-black transition ${
                      active
                        ? "bg-[#0B0B0B] text-white shadow-[0_6px_16px_rgba(15,23,42,0.18)]"
                        : "bg-white text-phx-ink-soft hover:bg-phx-paper hover:text-phx-ink"
                    }`}
                    key={key}
                    onClick={() => setChooseBy(key)}
                    role="tab"
                    type="button"
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    {label}
                    {active ? <span className="absolute inset-x-0 bottom-0 h-0.5 bg-phx-accent" /> : null}
                  </button>
                );
              })}
            </div>

            {chooseBy === "search" ? (
              <div className="mt-3" role="tabpanel">
                <label className="sr-only" htmlFor="sato-people">
                  Search colleagues
                </label>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-phx-ink-faint" />
                  <input
                    className={`${FIELD} pl-9 pr-10`}
                    id="sato-people"
                    onChange={(event) => void search(event.target.value)}
                    placeholder="Name, job title, area or email"
                    value={term}
                  />
                  {term ? (
                    <button
                      aria-label="Clear the search"
                      className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center text-phx-ink-faint transition hover:text-phx-ink"
                      onClick={() => void search("")}
                      type="button"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>

                {term.trim().length < 2 ? (
                  <p className="mt-2 text-xs font-semibold leading-5 text-phx-ink-faint">
                    Type at least 2 letters. Tick each person you want. The results stay open, so you can pick several in
                    a row.
                  </p>
                ) : matches.length === 0 ? (
                  <p className="mt-2 text-xs font-semibold text-phx-ink-faint">
                    {searching ? "Searching…" : `Nobody matches "${term.trim()}".`}
                  </p>
                ) : (
                  <>
                    <ul className="mt-2 divide-y divide-phx-line border border-phx-line">
                      {matches.map((match) => {
                        const picked = people.some((person) => person.hrId === match.hrId);
                        return (
                          <li key={match.hrId}>
                            <button
                              aria-checked={picked}
                              className={`flex w-full items-start gap-3 px-3 py-2.5 text-left transition ${
                                picked ? "bg-phx-accent-soft" : "bg-white hover:bg-phx-paper"
                              }`}
                              onClick={() => togglePerson(match)}
                              role="checkbox"
                              type="button"
                            >
                              <span className="mt-0.5 flex shrink-0">
                                <ChoiceTick picked={picked} />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block text-sm font-black text-phx-ink">{match.displayName}</span>
                                {match.jobTitle || match.where ? (
                                  <span className="block text-xs font-semibold text-phx-ink-faint">
                                    {[match.jobTitle, match.where].filter(Boolean).join(" · ")}
                                  </span>
                                ) : null}
                                <span className="block break-all text-xs text-phx-ink-soft">{match.email}</span>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs font-semibold text-phx-ink-faint">
                      <span>
                        {matches.length >= SEARCH_MATCH_CAP
                          ? `Showing the first ${SEARCH_MATCH_CAP}. Type more of the name to narrow it.`
                          : `${matches.length} match${matches.length === 1 ? "" : "es"}`}
                      </span>
                      {matches.some((match) => !people.some((person) => person.hrId === match.hrId)) ? (
                        <button className="font-black text-orange-700 hover:underline" onClick={tickAllShown} type="button">
                          Tick all {matches.length} shown
                        </button>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="mt-3" role="tabpanel">
                <label className="text-phx-xs font-black uppercase tracking-wide text-phx-ink-2" htmlFor="sato-typed-emails">
                  Email addresses
                </label>
                <textarea
                  className={`${FIELD} mt-2 min-h-[88px] resize-y`}
                  id="sato-typed-emails"
                  onChange={(event) => {
                    setEmailText(event.target.value);
                    setEmailError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      addTypedAddresses();
                    }
                  }}
                  placeholder="someone@satopharma.com, partner@clinic.com"
                  value={emailText}
                />
                <p className="mt-1.5 text-xs font-semibold leading-5 text-phx-ink-faint">
                  Separate with commas, spaces or new lines. A list pasted from Outlook works too. Press Enter to add.
                </p>
                {emailError ? (
                  <p className="mt-2 border border-rose-200 bg-rose-50 p-2.5 text-xs font-semibold text-rose-900">
                    <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5" />
                    {emailError}
                  </p>
                ) : null}
                <button
                  className={`${DARK_BUTTON} mt-3`}
                  disabled={!emailText.trim()}
                  onClick={addTypedAddresses}
                  type="button"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add addresses
                </button>
              </div>
            )}

            {people.length + emails.length > 0 ? (
              <div className="mt-4 border border-phx-accent-line bg-phx-accent-soft p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-black text-phx-ink">
                    {people.length + emails.length} chosen by you
                    <span className="font-semibold text-phx-ink-soft">
                      {" "}
                      · {people.length} colleague{people.length === 1 ? "" : "s"}, {emails.length} typed address
                      {emails.length === 1 ? "" : "es"}
                    </span>
                  </p>
                  <button className="text-xs font-black text-orange-700 hover:underline" onClick={clearChosen} type="button">
                    Clear all
                  </button>
                </div>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {people.map((person) => (
                    <li className="max-w-full" key={`person-${person.hrId}`}>
                      <ChosenChip
                        icon={<Users className="h-3 w-3 shrink-0 text-phx-ink-faint" />}
                        label={person.displayName}
                        onRemove={() => togglePerson(person)}
                        title={person.email}
                      />
                    </li>
                  ))}
                  {emails.map((email) => (
                    <li className="max-w-full" key={`email-${email}`}>
                      <ChosenChip
                        icon={<Mail className="h-3 w-3 shrink-0 text-phx-ink-faint" />}
                        label={email}
                        onRemove={() => {
                          setEmails((current) => current.filter((item) => item !== email));
                          invalidate();
                        }}
                        outside={needsReason.includes(email)}
                        title={email}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {needsReason.length > 0 ? (
              <div className="mt-4">
                <label className="text-phx-xs font-black uppercase tracking-wide text-phx-ink-2" htmlFor="sato-outside-reason">
                  Why outside addresses?
                </label>
                <p className="mt-1 break-words text-xs font-semibold leading-5 text-orange-700">
                  {needsReason.join(", ")} {needsReason.length === 1 ? "is" : "are"} outside Sato Pharma. Say why, in at
                  least 10 characters. The reason is kept with the send record.
                </p>
                <textarea
                  className={`${FIELD} mt-2 min-h-[64px] resize-y`}
                  id="sato-outside-reason"
                  onChange={(event) => {
                    setExternalJustification(event.target.value);
                    invalidate();
                  }}
                  placeholder="For example: the clinic partner receives the new rota"
                  value={externalJustification}
                />
              </div>
            ) : null}
          </div>
          </div>
        </section>

      {/* ------------------------------------------- preview / send — under what it says */}
      <section className="space-y-4 xl:col-start-1 xl:row-start-2">
        <AdminSectionHeader
          description="Nothing is sent until you have seen exactly who this reaches and said yes to that number."
          title="Check it, then send"
        />
        <div className={CARD}>

        {error ? (
          <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-900">{error}</p>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <button className={DARK_BUTTON} disabled={!canCompose || busy !== null || polishing || uploading} onClick={() => void runPreview()} type="button">
            {busy === "preview" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
            Preview and count recipients
          </button>
        </div>

        {preview ? (
          <div className="mt-5 space-y-4">
            <p className="rounded-xl border border-phx-line bg-phx-paper p-4 text-sm font-black text-phx-ink">
              <Users className="mr-1.5 inline h-4 w-4" />
              {preview.recipientCount} recipient{preview.recipientCount === 1 ? "" : "s"}, sent as {preview.emailCount}{" "}
              email{preview.emailCount === 1 ? "" : "s"}. Nobody sees anyone else&apos;s address.
            </p>

            {preview.attachments.length > 0 ? (
              <div className="rounded-xl border border-phx-line bg-phx-paper p-3 text-sm text-phx-ink-soft">
                <p className="font-black text-phx-ink">
                  <Paperclip className="mr-1.5 inline h-4 w-4" />
                  {preview.attachments.length} file{preview.attachments.length === 1 ? "" : "s"} attached
                </p>
                {preview.attachments.map((file) => (
                  <p key={file.id}>
                    {file.filename} &mdash; {formatBytes(file.byteSize)}
                  </p>
                ))}
              </div>
            ) : null}

            {preview.attachmentProblem ? (
              <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-900">
                <AlertTriangle className="mr-1.5 inline h-4 w-4" />
                {preview.attachmentProblem}
              </p>
            ) : null}

            {preview.recipientProblem ? (
              <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-900">
                <AlertTriangle className="mr-1.5 inline h-4 w-4" />
                {preview.recipientProblem}
              </p>
            ) : null}

            {preview.placeholders.length > 0 ? (
              <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-900">
                <AlertTriangle className="mr-1.5 inline h-4 w-4" />
                Still unfilled: {preview.placeholders.join(" · ")}
              </p>
            ) : null}

            {preview.audience.warnings.length > 0 ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-900">
                {preview.audience.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            ) : null}

            {preview.audience.skipped.length > 0 ? (
              <div className="rounded-xl border border-phx-line bg-phx-paper p-3 text-sm text-phx-ink-soft">
                <p className="font-black text-phx-ink">Left out, and why</p>
                {preview.audience.skipped.map((entry) => (
                  <p key={`${entry.hrId}-${entry.reason}`}>
                    {entry.displayName} — {entry.reason}
                  </p>
                ))}
              </div>
            ) : null}

            <div className="overflow-x-auto rounded-xl border border-phx-line bg-white p-3">
              {/* Sanitised server-side by prepareSatoEmailBody before it was rendered into this
                  HTML — the same string the recipient receives, which is the point of showing it. */}
              <div dangerouslySetInnerHTML={{ __html: preview.html }} />
            </div>

            {confirming ? (
              <div className="rounded-xl border border-phx-line bg-phx-paper p-4">
                <p className="text-sm font-black text-phx-ink">
                  Send &ldquo;{subject}&rdquo; to {preview.recipientCount} recipient
                  {preview.recipientCount === 1 ? "" : "s"} now? A sent email cannot be recalled.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button className={DARK_BUTTON} disabled={busy !== null || polishing || uploading} onClick={() => void send()} type="button">
                    {busy === "send" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                    Yes, send it
                  </button>
                  <button className={PALE_BUTTON} disabled={busy !== null} onClick={() => setConfirming(false)} type="button">
                    Not yet
                  </button>
                </div>
              </div>
            ) : (
              // Blocked, not warned: the attachments are part of the email, and an email that cannot
              // carry them is not the email the sender is looking at.
              <button
                className={DARK_BUTTON}
                disabled={Boolean(preview.attachmentProblem || preview.recipientProblem)}
                onClick={() => setConfirming(true)}
                type="button"
              >
                <Mail className="h-3.5 w-3.5" />
                Send this email
              </button>
            )}
          </div>
        ) : null}

        {result ? (
          <div
            className={`mt-5 rounded-xl border p-4 text-sm font-semibold ${
              result.status === "sent"
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : "border-amber-200 bg-amber-50 text-amber-900"
            }`}
          >
            <p className="font-black">
              {result.status === "sent" ? (
                <>
                  <Check className="mr-1.5 inline h-4 w-4" />
                  Sent to {result.recipientCount} recipient{result.recipientCount === 1 ? "" : "s"} in {result.emailCount}{" "}
                  email{result.emailCount === 1 ? "" : "s"}.
                </>
              ) : result.status === "partial" ? (
                <>Part of this send went out. Read the reasons below before sending again.</>
              ) : (
                <>Nothing was sent.</>
              )}
            </p>
            {result.skippedReason ? <p className="mt-1">{result.skippedReason}</p> : null}
            {result.outcomes
              .filter((outcome) => outcome.reason)
              .map((outcome) => (
                <p className="mt-1" key={outcome.batchIndex}>
                  Email {outcome.batchIndex + 1} ({outcome.recipients} recipients): {outcome.reason}
                </p>
              ))}
          </div>
        ) : null}
        </div>
      </section>
      </div>

      <SatoTemplateManager onSaved={(template) => setTemplates(mergeTemplate(templates, template))} templates={templates} />
    </div>
  );
}

function ChoiceTick({ picked }: { picked: boolean }) {
  if (picked) {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center bg-phx-accent text-white">
        <Check className="h-3 w-3" strokeWidth={3.5} />
      </span>
    );
  }
  return <span className="block h-4 w-4 shrink-0 border border-phx-line-strong bg-white" />;
}

function ChosenChip({
  icon,
  label,
  onRemove,
  outside = false,
  title,
}: {
  icon: ReactNode;
  label: string;
  onRemove: () => void;
  outside?: boolean;
  title: string;
}) {
  return (
    <button
      aria-label={`Remove ${label}`}
      className={`inline-flex max-w-full items-center gap-1.5 border bg-white px-2.5 py-1.5 text-left text-xs font-bold text-phx-ink-2 transition hover:border-phx-ink-faint ${
        outside ? "border-orange-300" : "border-phx-line"
      }`}
      onClick={onRemove}
      title={title}
      type="button"
    >
      {icon}
      <span className="min-w-0 break-all">{label}</span>
      {outside ? <span className="shrink-0 text-[10px] font-black uppercase tracking-wide text-orange-700">Outside</span> : null}
      <X className="h-3 w-3 shrink-0" />
    </button>
  );
}

function mergeTemplate(templates: SatoTemplateView[], saved: SatoTemplateView): SatoTemplateView[] {
  const without = templates.filter((template) => template.templateKey !== saved.templateKey);
  return [...without, saved].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/** Editing the fixed wording. Changing a template sends nothing — it changes what a future send says. */
function SatoTemplateManager({
  onSaved,
  templates,
}: {
  onSaved: (template: SatoTemplateView) => void;
  templates: SatoTemplateView[];
}) {
  const [open, setOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string>("");
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function load(key: string) {
    setEditingKey(key);
    setMessage(null);
    const template = templates.find((item) => item.templateKey === key);
    if (!template) {
      setName("");
      setSubject("");
      setBodyHtml("");
      setIsActive(true);
      return;
    }
    setName(template.name);
    setSubject(template.subject);
    setBodyHtml(template.bodyHtml);
    setIsActive(template.isActive);
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const key = editingKey || name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      const response = await fetch("/api/admin/sato-email/templates", {
        body: JSON.stringify({ bodyHtml, isActive, name, subject, templateKey: key }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as { message?: string; template?: SatoTemplateView };
      if (!response.ok || !payload.template) {
        setMessage(payload.message ?? "The template could not be saved.");
        return;
      }
      onSaved(payload.template);
      setEditingKey(payload.template.templateKey);
      setMessage("Saved.");
    } catch {
      setMessage("The template could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-4">
      <AdminSectionHeader
        action={
          <button className={PALE_BUTTON} onClick={() => setOpen((current) => !current)} type="button">
            {open ? "Close" : "Manage templates"}
          </button>
        }
        description="The fixed wording both seats can pick from. Editing one changes what future emails say — it sends nothing."
        title="Templates"
      />

      {open ? (
        <div className={`${CARD} space-y-4`}>
          <div>
            <label className="text-phx-xs font-black uppercase tracking-wide text-phx-ink-2" htmlFor="sato-template-edit">
              Edit an existing template, or leave this on &ldquo;New template&rdquo;
            </label>
            <select
              className={`mt-2 ${FIELD}`}
              id="sato-template-edit"
              onChange={(event) => load(event.target.value)}
              value={editingKey}
            >
              <option value="">New template</option>
              {templates.map((template) => (
                <option key={template.templateKey} value={template.templateKey}>
                  {template.name}
                  {template.isActive ? "" : " (switched off)"}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="text-phx-xs font-black uppercase tracking-wide text-phx-ink-2" htmlFor="sato-template-name">
                Name
              </label>
              <input
                className={`mt-2 ${FIELD}`}
                id="sato-template-name"
                onChange={(event) => setName(event.target.value)}
                placeholder="Public holiday"
                value={name}
              />
            </div>
            <div>
              <label className="text-phx-xs font-black uppercase tracking-wide text-phx-ink-2" htmlFor="sato-template-subject">
                Subject
              </label>
              <input
                className={`mt-2 ${FIELD}`}
                id="sato-template-subject"
                onChange={(event) => setSubject(event.target.value)}
                placeholder="Public holiday: [Holiday name]"
                value={subject}
              />
            </div>
          </div>

          <div>
            <span className="text-phx-xs font-black uppercase tracking-wide text-phx-ink-2">Body</span>
            <div className="mt-2">
              <EmailBodyEditor hiddenActions={["Action button"]} onChange={setBodyHtml} value={bodyHtml} variables={[]} />
            </div>
            <p className="mt-2 text-xs font-semibold text-phx-ink-faint">
              Leave a gap the sender must fill as [square brackets] — the composer warns about any left unfilled.
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm font-semibold text-phx-ink">
            <input checked={isActive} className="h-4 w-4" onChange={(event) => setIsActive(event.target.checked)} type="checkbox" />
            Offer this template in the composer
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <button className={DARK_BUTTON} disabled={saving || !name.trim() || !subject.trim() || !bodyHtml.trim()} onClick={() => void save()} type="button">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Save template
            </button>
            {message ? <span className="text-sm font-semibold text-phx-ink-soft">{message}</span> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
