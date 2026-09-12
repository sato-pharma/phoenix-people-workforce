"use client";

import { AlertTriangle, Check, Eye, Loader2, Mail, Paperclip, Search, Send, Sparkles, Undo2, Users, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { AdminSectionHeader } from "@/components/admin/admin-design-system";
import { EmailBodyEditor } from "@/components/admin/email-body-editor";
import {
  SATO_EMAIL_ATTACHMENT_ACCEPT,
  SATO_EMAIL_INLINE_ACCEPT,
  SATO_EMAIL_MEDIA_MAX_FILES,
  formatBytes,
} from "@/lib/sato-email/media-limits";

export type SatoTemplateView = {
  bodyHtml: string;
  isActive: boolean;
  name: string;
  sortOrder: number;
  subject: string;
  templateKey: string;
};

export type SatoListView = {
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
  placeholders: string[];
  recipientCount: number;
};

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
      hrIds: people.map((person) => person.hrId),
      listKeys,
      signOff,
      subject,
      templateKey: mode === "template" && templateKey ? templateKey : null,
    }),
    [attachments, bodyHtml, clientRequestId, listKeys, mode, people, signOff, subject, templateKey],
  );

  const canCompose = Boolean(subject.trim() && bodyHtml.trim() && (listKeys.length > 0 || people.length > 0));

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

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        {/* ---------------------------------------------------------------- what it says */}
        <section className="space-y-4">
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
        <section className="space-y-4">
          <AdminSectionHeader
            description="Pick a distribution list, name people individually, or both. Recipients never see each other's addresses."
            title="Who it reaches"
          />
          <div className={CARD}>
          <div className="space-y-2">
            {initialLists.length === 0 ? (
              <p className="rounded-xl border border-dashed border-phx-line bg-phx-paper p-4 text-sm text-phx-ink-soft">
                No distribution list is switched on yet. Turn one on under Distribution Lists, or name people below.
              </p>
            ) : null}
            {initialLists.map((list) => {
              const checked = listKeys.includes(list.listKey);
              return (
                <label
                  className="flex cursor-pointer items-start gap-3 rounded-xl border border-phx-line bg-phx-paper p-3"
                  key={list.listKey}
                >
                  <input
                    checked={checked}
                    className="mt-1 h-4 w-4"
                    onChange={() => {
                      setListKeys((current) =>
                        checked ? current.filter((key) => key !== list.listKey) : [...current, list.listKey],
                      );
                      invalidate();
                    }}
                    type="checkbox"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-black text-phx-ink">{list.label}</span>
                    <span className="block text-xs font-semibold text-phx-ink-faint">{list.description}</span>
                  </span>
                </label>
              );
            })}
          </div>

          <div className="mt-5">
            <label className="text-phx-xs font-black uppercase tracking-wide text-phx-ink-2" htmlFor="sato-people">
              Add people by name
            </label>
            <div className="relative mt-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-phx-ink-faint" />
              <input
                className={`${FIELD} pl-9`}
                id="sato-people"
                onChange={(event) => void search(event.target.value)}
                placeholder="Search a colleague"
                value={term}
              />
            </div>

            {searching ? <p className="mt-2 text-xs font-semibold text-phx-ink-faint">Searching…</p> : null}

            {matches.length > 0 ? (
              <ul className="mt-2 space-y-1">
                {matches
                  .filter((match) => !people.some((person) => person.hrId === match.hrId))
                  .map((match) => (
                    <li key={match.hrId}>
                      <button
                        className="w-full rounded-lg border border-phx-line bg-white px-3 py-2 text-left text-sm text-phx-ink transition hover:bg-phx-paper"
                        onClick={() => {
                          setPeople((current) => [...current, match]);
                          setTerm("");
                          setMatches([]);
                          invalidate();
                        }}
                        type="button"
                      >
                        <span className="font-black">{match.displayName}</span>
                        {match.jobTitle ? (
                          <span className="block text-xs font-semibold text-phx-ink-faint">
                            {match.jobTitle}
                            {match.where ? ` · ${match.where}` : ""}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
              </ul>
            ) : null}

            {people.length > 0 ? (
              <ul className="mt-3 flex flex-wrap gap-2">
                {people.map((person) => (
                  <li key={person.hrId}>
                    <button
                      className="inline-flex items-center gap-1.5 rounded-full border border-phx-line bg-phx-paper px-3 py-1.5 text-xs font-bold text-phx-ink-2"
                      onClick={() => {
                        setPeople((current) => current.filter((item) => item.hrId !== person.hrId));
                        invalidate();
                      }}
                      type="button"
                    >
                      {person.displayName}
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          </div>
        </section>
      </div>

      {/* ------------------------------------------------------------------ preview / send */}
      <section className="space-y-4">
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
                disabled={Boolean(preview.attachmentProblem)}
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

      <SatoTemplateManager onSaved={(template) => setTemplates(mergeTemplate(templates, template))} templates={templates} />
    </div>
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
