"use client";

import {
  AlertTriangle,
  AtSign,
  Check,
  Eye,
  FileUp,
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
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import { AdminSectionHeader } from "@/components/admin/admin-design-system";
import { AssistDictation } from "@/components/admin/assist-dictation";
import { EmailBodyEditor } from "@/components/admin/email-body-editor";
import { SatoEmailListPicker } from "@/components/admin/sato-email-list-picker";
import { attachablesFromTransfer } from "@/lib/email/transfer-files";
import {
  SATO_EMAIL_ATTACHMENT_ACCEPT,
  SATO_EMAIL_INLINE_ACCEPT,
  SATO_EMAIL_MEDIA_MAX_FILES,
  formatBytes,
} from "@/lib/sato-email/media-limits";
import { promisesAnAttachment } from "@/lib/sato-email/attachment-promise";
import { SATO_EMAIL_DOCUMENT_ACCEPT } from "@/lib/sato-email/source-document";
import {
  SATO_EMAIL_MAX_TYPED_ADDRESSES,
  isOutsideCompanyAddress,
  parseTypedEmailAddresses,
} from "@/lib/sato-email/typed-recipients";
import { phxSelectClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

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

/**
 * What the assistant is being asked to do.
 *
 * Owner 2026-09-17: "I want to be able to tell it write a job offer to someone whose area will be
 * like this ... I wanted a real assistant, not a do-nothing." Write composes from his instruction
 * and works on an empty body; Rewrite is the older behaviour, which only ever touches wording.
 *
 * Owner 2026-09-23: "upload pdf and the system absorb and extract the data from the pdf and make it
 * as email." Document is that third one — the facts come from the file he uploaded, which is read
 * on the server and never stored.
 *
 * Declared here rather than imported from `@/lib/sato-email/polish`, which is a server module —
 * importing it would pull the OpenAI client into the browser bundle. `parseSatoAssistMode` on the
 * route is the authority; anything else it receives is read as a rewrite.
 */
type AssistMode = "rewrite" | "write" | "document";

type SendResultView = {
  emailCount: number;
  outcomes: Array<{ batchIndex: number; id: string | null; reason: string | null; recipients: number; status: string }>;
  recipientCount: number;
  skippedReason: string | null;
  status: "sent" | "partial" | "skipped" | "failed";
};

const CARD = "rounded-2xl border border-phx-line bg-white p-5 shadow-[0_10px_28px_rgba(15,23,42,0.06)]";
const FIELD = cn(phxSelectClassName, "w-full px-3 py-2.5");
const DARK_BUTTON =
  "inline-flex h-[42px] items-center justify-center gap-1.5 bg-[#0B0B0B] px-4 text-phx-xs font-black text-white transition hover:bg-[#1E293B] disabled:opacity-50";
const PALE_BUTTON =
  "inline-flex h-[42px] items-center justify-center gap-1.5 border border-phx-line bg-white px-4 text-phx-xs font-black text-phx-ink transition hover:bg-phx-paper disabled:opacity-50";

/**
 * Which composer this screen is, as data.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY THE CEO COMPOSER IS THIS FILE WITH A VARIANT, AND NOT A SECOND COPY OF IT.
 *
 * Owner 2026-10-06 asked for a CEO composer "exactly as sato email composer copy paste". This file
 * is 1,500 lines, and every one of them is a rule somebody learned the hard way: Send never being
 * the first press, the preview being cleared by any edit so the recipient count can never describe an
 * older draft, the attachment budget disabling Send rather than warning beside it, a typed outside
 * address needing a reason, Insert image opening the file picker instead of asking for an address.
 * A literal copy would start identical and drift on the first fix applied to one of them, with
 * nothing reporting which screen had been left behind — and the screen left behind would be the one
 * that mails the whole company over the chief executive's signature.
 *
 * So "exactly as" is implemented by being the same screen. What differs is listed here, nowhere
 * else: the API it posts to, the label on the signature field, and whether the assistant shows three
 * mode buttons or one box with a microphone.
 * ───────────────────────────────────────────────────────────────────────────────────────────── */
export type ComposerVariant = {
  /** Where every fetch on this screen goes. No trailing slash. */
  apiBase: string;
  /**
   * The assistant's shape. `modes` is the Sato composer's three buttons; `understood` is the CEO's
   * one box, where the assistant reads the intent itself and the server decides the guard set — see
   * `src/lib/ceo-email/assist.ts`.
   */
  assist: "modes" | "understood";
  /** True on the variant whose instruction box carries a microphone. */
  dictation: boolean;
  /** How long one instruction may be, mirroring the cap the route slices at. */
  instructionMaxChars: number;
  /** The prefix on the idempotency `clientRequestId`, so a key names the screen it came from. */
  requestIdPrefix: string;
  /** What the signature field is called, and the hint under it. */
  signOffDefault: string;
  signOffHint: string;
  signOffLabel: string;
};

export const SATO_COMPOSER_VARIANT: ComposerVariant = {
  apiBase: "/api/admin/sato-email",
  assist: "modes",
  dictation: false,
  // Mirrors SATO_ASSIST_MAX_INSTRUCTION_CHARS, which the route slices at. Pinned by the polish test.
  instructionMaxChars: 4_000,
  requestIdPrefix: "sato",
  signOffDefault: "Human Resources",
  signOffHint: "Printed under the message as the sender. Leave it as it is unless this email is from a named person.",
  signOffLabel: "Signed",
};

function newRequestId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
  dictationAvailable = false,
  initialLists,
  initialTemplates,
  loadWarnings,
  variant = SATO_COMPOSER_VARIANT,
}: {
  /**
   * Whether the server can turn speech into words at all, read server-side on the page.
   *
   * 🔴 THE BROWSER CANNOT SEE WHETHER THE KEY IS CONFIGURED, and the microphone is a promise: a
   * control that offers "the words appear when you stop" with nothing behind it is a bug the person
   * only discovers after speaking a paragraph. So the page asks, and the answer is a boolean and
   * nothing else — never which service, never why it is missing.
   */
  dictationAvailable?: boolean;
  initialLists: SatoListView[];
  initialTemplates: SatoTemplateView[];
  loadWarnings: string[];
  /**
   * Which composer this is. Defaults to the Sato one, so every existing caller is byte-identical.
   * See `ComposerVariant` above for why this is a parameter and not a second copy of this file.
   */
  variant?: ComposerVariant;
}) {
  const api = variant.apiBase;
  const [templates, setTemplates] = useState(initialTemplates);
  const [mode, setMode] = useState<"template" | "free">(initialTemplates.length > 0 ? "template" : "free");
  const [templateKey, setTemplateKey] = useState<string>("");
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [signOff, setSignOff] = useState(variant.signOffDefault);
  // Files clipped to the mail. A body PICTURE is not here: it lives in bodyHtml as an <img>, which
  // is the whole difference between the two halves of what the owner asked for.
  const [attachments, setAttachments] = useState<Array<{ byteSize: number; filename: string; id: string }>>([]);
  const [uploading, setUploading] = useState(false);
  // Whether a file is being dragged over the attachments row, so the frame can say "drop it here".
  const [dropActive, setDropActive] = useState(false);

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

  // The assistant. `polished` holds what the sender wrote immediately before it, which is the whole
  // of Undo: his own words are never sent anywhere to be fetched back, they are simply still here.
  const [instruction, setInstruction] = useState("");
  const [polishing, setPolishing] = useState<AssistMode | null>(null);
  /**
   * Seconds on the button while the assistant works, and nothing else — no bar, no percentage,
   * because neither would be true.
   *
   * Reading a document is the slow one: measured 29–39 seconds on the owner's own incentive policy.
   * A spinner that sits still for half a minute reads as broken rather than busy, which is exactly
   * what happened (owner, 2026-09-23: "its taking hilarious long time"). A number that keeps moving
   * says the same wait is progress. It counts for all three modes because the sender cannot know
   * which of them is the slow one.
   */
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    // Nothing is set synchronously here on purpose: zeroing the counter in the effect cascades a
    // render every time `polishing` changes, which is what CI's react-hooks/set-state-in-effect
    // caught. The zero belongs to the click that starts the run, below; the interval is the only
    // part that genuinely needs an effect, because only an effect can clean it up.
    if (polishing === null) return;
    const startedAt = Date.now();
    const tick = window.setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(tick);
  }, [polishing]);
  const counted = (label: string) => (elapsed > 0 ? `${label} · ${elapsed}s` : label);
  const [polished, setPolished] = useState<
    {
      bodyHtml: string;
      changes: string[];
      checks: string[];
      /**
       * The understood variant only: what the assistant worked out he was asking for, and the
       * language it answered in. Shown so he can see it read him correctly — he picked no mode, so
       * the screen owes him the one it chose. Null on the Sato composer, where he pressed a button.
       */
      intent: "write" | "polish" | "translate" | "document" | null;
      language: string | null;
      mode: AssistMode;
      /** Document mode: what the server actually read out of the file, named, in one line. */
      source: string | null;
      subject: string;
      /**
       * The file was loaded as it stands and nothing wrote anything — an HTML upload. The heading
       * above the result has to say so: "what it wrote from your document" over a file the
       * assistant never touched is the screen telling the sender the opposite of what happened.
       */
      verbatim: boolean;
    } | null
  >(null);
  // Lights the dashed frame while a document is dragged over the assistant. Separate from the
  // attachments row's own flag on purpose: the two drops do opposite things, and one shared flag
  // would light both frames and tell the sender the drop does either.
  const [documentDrop, setDocumentDrop] = useState(false);

  const [clientRequestId, setClientRequestId] = useState(() => newRequestId(variant.requestIdPrefix));
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
  // The second net behind the body editor handing a dropped PDF to the attachments row: whatever
  // gesture lost the file, an email whose words promise one and whose preview carries none is
  // flagged, and the confirmation has to say "without an attachment" (owner, 2026-10-24).
  const promisedButEmpty = Boolean(preview) && (preview?.attachments.length ?? 0) === 0 && promisesAnAttachment(subject, bodyHtml);
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
      const response = await fetch(`${api}/media`, { body: form, method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as {
        file?: { byteSize: number; filename: string; id: string; url: string | null };
        message?: string;
      };
      if (!response.ok || !payload.file) throw new Error(payload.message ?? "The file could not be uploaded.");
      return payload.file;
    },
    // 🔴 `api` BELONGS HERE NOW THAT THE COMPOSER SERVES TWO MODULES. An empty list was harmless while
    // there was one endpoint; with the CEO variant beside the Sato one, a closure holding a stale
    // `api` would post one module's attachment into the other module's store.
    [api],
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

  async function attachFiles(files: readonly File[] | FileList | null) {
    const chosen = files ? Array.from(files) : [];
    if (chosen.length === 0) return;
    setUploading(true);
    setError(null);
    // Counted in a local, not read back from state: `setAttachments` does not land until the
    // component re-renders, so a batch of twenty dropped files would every one of them read the
    // same starting count and sail past the ceiling.
    let carried = attachments.length;
    try {
      for (const file of chosen) {
        if (carried >= SATO_EMAIL_MEDIA_MAX_FILES) {
          setError(`An email may carry at most ${SATO_EMAIL_MEDIA_MAX_FILES} attachments — the rest were not attached.`);
          break;
        }
        const stored = await uploadOne(file, "attachment");
        carried += 1;
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
   * Writes the email he asked for, or puts the draft he wrote into the company's voice. Nothing is
   * saved and nothing is sent — the result lands straight back in the two fields he was already
   * editing, and the preview is invalidated with it, so a recipient count on screen can never
   * belong to the older draft.
   */
  async function polish(assistMode: AssistMode) {
    setElapsed(0);
    setPolishing(assistMode);
    setError(null);
    try {
      const understood = variant.assist === "understood";
      const response = await fetch(`${api}/${understood ? "assist" : "polish"}`, {
        // 🔴 NO `mode` ON THE UNDERSTOOD VARIANT, and not merely because the route ignores one: a
        // mode on the wire is the browser choosing which guard set judges the answer, which is the
        // hole `src/lib/ceo-email/assist.ts` is written against. The server reads the intent.
        body: JSON.stringify(understood ? { bodyHtml, instruction, subject } : { bodyHtml, instruction, mode: assistMode, subject }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as {
        message?: string;
        result?: {
          bodyHtml: string;
          changes: string[];
          checks?: string[];
          /** The understood variant answers with what it WORKED OUT, which is not a mode he picked. */
          intent?: "write" | "polish" | "translate" | "document";
          language?: string;
          mode?: AssistMode;
          subject: string;
        };
      };
      if (!response.ok || !payload.result) {
        setError(payload.message ?? "The assistant could not answer.");
        return;
      }
      // His own words, kept here and nowhere else, so Undo is exact rather than approximate.
      setPolished({
        bodyHtml,
        changes: payload.result.changes,
        checks: payload.result.checks ?? [],
        // What it worked out, reported honestly: "translate" and "polish" both land as a rewrite
        // heading, "write" as a written one. He never chose either, so the screen says which it read.
        intent: payload.result.intent ?? null,
        language: payload.result.language ?? null,
        // 🔴 ON THE UNDERSTOOD VARIANT THE MODE IS DERIVED FROM THE INTENT, NEVER FROM `assistMode`.
        // That variant has ONE button and it passes "write" always, so falling back to it labelled a
        // tightening of his own words "Read as: write it" — the exact misreading the heading below
        // exists to surface. The assist route answers with `intent` and no `mode`; the Sato variant,
        // which really does have two buttons, keeps reading the mode it asked for.
        mode: understood
          ? payload.result.intent === "write"
            ? "write"
            : "rewrite"
          : (payload.result.mode ?? assistMode),
        source: null,
        subject,
        verbatim: false,
      });
      setSubject(payload.result.subject);
      setBodyHtml(payload.result.bodyHtml);
      invalidate();
    } catch {
      setError("The assistant could not answer.");
    } finally {
      setPolishing(null);
    }
  }

  /**
   * Writes the email out of a document the sender uploaded — the owner's "upload pdf and the system
   * absorb and extract the data from the pdf and make it as email".
   *
   * The file goes up, the words come back inside the draft, and nothing is stored: this is not the
   * attach button, and a document he wants the reader to HAVE still has to be attached on the row
   * above. Undo puts his own words back exactly as the other two modes do.
   */
  async function buildFromDocument(file: File | null | undefined) {
    if (!file) return;
    setElapsed(0);
    setPolishing("document");
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      // Everything he has already typed travels with it: a subject he wrote is kept, a body he
      // started is built on, and an instruction shapes what the document becomes.
      form.append("bodyHtml", bodyHtml);
      form.append("instruction", instruction);
      form.append("subject", subject);
      const response = await fetch(`${api}/document`, { body: form, method: "POST" });
      const payload = (await response.json()) as {
        message?: string;
        result?: { bodyHtml: string; changes: string[]; checks?: string[]; mode?: AssistMode; subject: string };
        source?: { fileName: string; note: string; route?: string };
      };
      if (!response.ok || !payload.result) {
        setError(payload.message ?? "The email could not be built from that document.");
        return;
      }
      setPolished({
        bodyHtml,
        changes: payload.result.changes,
        checks: payload.result.checks ?? [],
        intent: "document",
        language: null,
        mode: "document",
        source: payload.source?.note ?? null,
        subject,
        verbatim: payload.source?.route === "verbatim",
      });
      setSubject(payload.result.subject);
      setBodyHtml(payload.result.bodyHtml);
      invalidate();
    } catch {
      setError("The email could not be built from that document.");
    } finally {
      setPolishing(null);
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
      const response = await fetch(`${api}/employees?q=${encodeURIComponent(value.trim())}`);
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
      const response = await fetch(`${api}/preview`, {
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
      const response = await fetch(`${api}/send`, {
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
      setClientRequestId(newRequestId(variant.requestIdPrefix));
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
                attachFiles={(files) => void attachFiles(files)}
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
              Paste a photo or a screenshot straight into the message, drag one in from a folder, or use the
              picture button in the toolbar. A picture in the body has to be fetched from the web when
              somebody opens the email, so anyone who has the link can see it &mdash; put a company document
              in the attachments below instead. A PDF or any other file dropped or pasted into the message
              is attached below, not placed in the text.
            </p>
          </div>

          {/* ------------------------------------------------------------------ attachments */}
          <div className="mt-4">
            <span className="text-phx-xs font-black uppercase tracking-wide text-phx-ink-2">Attachments</span>
            {/*
              Dropping a file here attaches it. The dashed frame only appears while something is
              being dragged over it: an always-visible drop box beside the button would say the
              same thing twice, and the button is what a sender reaches for first.
            */}
            <div
              className={`mt-2 border border-dashed p-2 transition ${
                dropActive ? "border-[#FED7AA] bg-phx-accent-soft" : "border-transparent"
              }`}
              onDragLeave={() => setDropActive(false)}
              onDragOver={(event) => {
                // Only a real file drag. Without this the frame lights up when the sender drags a
                // word out of the body, which is a move inside the editor and nothing to do here.
                if (!Array.from(event.dataTransfer.types).includes("Files")) return;
                event.preventDefault();
                setDropActive(true);
              }}
              onDrop={(event) => {
                if (event.dataTransfer.files.length === 0) return;
                event.preventDefault();
                setDropActive(false);
                void attachFiles(attachablesFromTransfer(Array.from(event.dataTransfer.files)));
              }}
            >
            <div className="flex flex-wrap items-center gap-2">
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
                  className="inline-flex items-center gap-2 border border-phx-line bg-phx-paper px-3 py-2 text-phx-xs font-black text-phx-ink"
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
            </div>
            <p className="mt-2 text-xs font-semibold text-phx-ink-faint">
              Click the button or drag files onto this row. Attachments travel inside the email, so only the
              people you send it to can open them. Up to {SATO_EMAIL_MEDIA_MAX_FILES} files, and 10 MB in
              total &mdash; over that the send is refused rather than quietly dropping a file.
            </p>
          </div>

          <div className="mt-3 rounded-xl border border-phx-line bg-phx-paper p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="text-phx-xs font-black uppercase tracking-wide text-phx-ink-2" htmlFor="sato-assist">
                {variant.assist === "understood" ? "Say what you want, in any language" : "Tell the assistant what you want"}
              </label>
              {/*
                The microphone sits ON the label row rather than with the buttons below, because what
                it does is FILL THIS BOX — it is another way of typing, not another thing to press
                after typing. Only rendered where the server can actually turn speech into words:
                `dictationAvailable` is read server-side, and an inert microphone reads as a bug.
              */}
              {variant.dictation && dictationAvailable ? (
                <AssistDictation
                  busy={polishing !== null}
                  endpoint={`${api}/transcribe`}
                  onText={(spoken) =>
                    setInstruction((current) => {
                      const joined = `${current.trim()} ${spoken.trim()}`.trim();
                      // The cap is enforced here as well as on the textarea, because `maxLength`
                      // constrains TYPING and does nothing to a programmatic append.
                      return joined.slice(0, variant.instructionMaxChars);
                    })
                  }
                />
              ) : null}
            </div>
            <textarea
              className={`mt-2 ${FIELD} min-h-[88px]`}
              id="sato-assist"
              maxLength={variant.instructionMaxChars}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder={
                variant.assist === "understood"
                  ? "Tell the company we are moving the head office on 1 November — or, on a letter you already wrote: "
                    + "shorter and firmer, put the three dates in a table, اكتبها بالعربي كمان"
                  : "Write a job offer for Ahmed Samir, medical representative, Giza area, reporting to the Cairo district "
                    + "manager — or, on a draft you already wrote: shorter, lead with the deadline, put the branches in a "
                    + "table of two columns"
              }
              rows={3}
              value={instruction}
            />
            {/*
              Dropping a document here builds the email from it. The dashed frame appears only
              while something is being dragged over it, exactly as on the attachments row — and it
              is a different row from that one on purpose: dropping a file there attaches it to the
              email, dropping it here turns it INTO the email, and one frame for both would say the
              drop does either.
            */}
            <div
              className={`mt-2 border border-dashed p-2 transition ${
                documentDrop ? "border-[#FED7AA] bg-phx-accent-soft" : "border-transparent"
              }`}
              onDragLeave={() => setDocumentDrop(false)}
              onDragOver={(event) => {
                if (polishing !== null) return;
                // Only a real file drag — without this the frame lights up when he drags a word
                // out of his own draft, which is a move inside the editor and nothing to do here.
                if (!Array.from(event.dataTransfer.types).includes("Files")) return;
                event.preventDefault();
                setDocumentDrop(true);
              }}
              onDrop={(event) => {
                if (polishing !== null || event.dataTransfer.files.length === 0) return;
                event.preventDefault();
                setDocumentDrop(false);
                // One document, one email. A second file dropped alongside it would be read into
                // nothing, so only the first is taken and the rest are left where they were.
                void buildFromDocument(event.dataTransfer.files[0]);
              }}
            >
            <div className="flex flex-wrap items-center gap-2">
              {/*
                🔴 ONE BUTTON ON THE CEO COMPOSER, AND THAT IS THE OWNER'S INSTRUCTION, NOT A TIDY-UP.
                2026-10-06: "the assist is perfectly able to understand the ceo if the ceo asked to
                type he understand if asked to polish he understand". So nothing here chooses a mode,
                and nothing here POSTS one — the route takes no `mode` at all, because a mode on the
                wire would hand the browser the choice of which guard set judges the answer. The
                server reads the intent and decides; `src/lib/ceo-email/assist.ts` holds the floor
                that makes that safe.

                It is enabled on an instruction OR on a body: "polish this" is a press with an empty
                box and a letter already written, which is a real way to use it.
              */}
              {variant.assist === "understood" ? (
                <button
                  className={DARK_BUTTON}
                  disabled={polishing !== null || (!instruction.trim() && !bodyHtml.trim())}
                  onClick={() => void polish("write")}
                  type="button"
                >
                  {polishing !== null && polishing !== "document" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  {polishing !== null && polishing !== "document" ? counted("Working on it") : "Do it"}
                </button>
              ) : (
                <>
                  <button
                    className={DARK_BUTTON}
                    disabled={polishing !== null || !instruction.trim()}
                    onClick={() => void polish("write")}
                    type="button"
                  >
                    {polishing === "write" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4" />
                    )}
                    {polishing === "write" ? counted("Writing") : "Write it"}
                  </button>
                  <button
                    className={PALE_BUTTON}
                    disabled={polishing !== null || !bodyHtml.trim()}
                    onClick={() => void polish("rewrite")}
                    type="button"
                  >
                    {polishing === "rewrite" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4" />
                    )}
                    {polishing === "rewrite" ? counted("Rewriting") : "Rewrite what I wrote"}
                  </button>
                </>
              )}
              <label className={`${PALE_BUTTON} cursor-pointer ${polishing !== null ? "pointer-events-none opacity-50" : ""}`}>
                {polishing === "document" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FileUp className="h-4 w-4" />
                )}
                {polishing === "document" ? counted("Reading the document") : "Build it from a document"}
                <input
                  accept={SATO_EMAIL_DOCUMENT_ACCEPT}
                  className="hidden"
                  disabled={polishing !== null}
                  onChange={(event) => {
                    const chosen = event.target.files?.[0];
                    // Cleared first, so the same document can be tried again after a failure.
                    event.target.value = "";
                    void buildFromDocument(chosen);
                  }}
                  type="file"
                />
              </label>
            </div>
            </div>
            {variant.assist === "understood" ? (
              <p className="mt-2 text-xs font-semibold text-phx-ink-faint">
                Type it or dictate it, in any language, and press <strong>Do it</strong> — there is nothing to choose.
                Ask for a letter and it writes one, on an empty page; ask for your own letter to read better and it only
                changes how it reads; ask for it in another language and it translates it, keeping every figure and
                every gap. <strong>Build it from a document</strong> reads a PDF, a Word file, a text file or a picture
                of one — click the button or drag it onto this row — and writes the letter that carries what it says, in
                its own figures. An <strong>HTML file is loaded exactly as it is</strong>, with its wording, layout and
                tables kept and nothing rewritten. The document is read and thrown away: if the reader should also
                receive it, attach it above. It never invents a fact — anything you did not give it comes back as a
                [square bracket] gap for you to fill, a figure you had written going missing is refused outright, and so
                is a link it did not get from you.
              </p>
            ) : (
              <p className="mt-2 text-xs font-semibold text-phx-ink-faint">
                <strong>Write it</strong> composes the whole email from what you asked for, even on an empty page, and
                uses every button in the toolbar above — including a table of the shape you name. <strong>Rewrite what
                I wrote</strong> keeps your draft and only changes how it reads. <strong>Build it from a document</strong>
                reads a PDF, a Word file, a text file or a picture of one — click the button or drag it onto
                this row — and writes the email that carries what it says, in its own figures, in English and Arabic
                together. An <strong>HTML file is loaded exactly as it is</strong>, with its own wording, layout and
                tables kept and nothing rewritten. The document is read and thrown away:
                if the reader should also receive it, attach it above. None of the three invents a fact: anything you did
                not give it comes back as a [square bracket] gap for you to fill, and a link it did not get from you is
                refused outright.
              </p>
            )}

            {polished ? (
              <div className="mt-3 border border-phx-line bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {/*
                    🔴 ON THE UNDERSTOOD VARIANT THIS HEADING IS THE ONLY PLACE HE LEARNS HOW HE WAS
                    READ. He pressed one button, so if the assistant took "make it firmer" as a
                    request to write a new letter, nothing else on screen would say so — the words
                    look plausible either way. It names the reading, and the language it answered in.
                  */}
                  <span className="text-phx-xs font-black uppercase tracking-wide text-phx-ink-2">
                    {polished.verbatim
                      ? "Loaded from your file, as it is"
                      : polished.intent === "translate"
                        ? `Translated${polished.language ? ` into ${polished.language}` : ""}, your figures unchanged`
                        : polished.mode === "document"
                          ? "What it wrote from your document"
                          : polished.mode === "write"
                            ? variant.assist === "understood"
                              ? `Read as: write it${polished.language ? ` · ${polished.language}` : ""}`
                              : "What it wrote"
                            : variant.assist === "understood"
                              ? `Read as: your own words, tightened${polished.language ? ` · ${polished.language}` : ""}`
                              : "What changed"}
                  </span>
                  <button className={PALE_BUTTON} onClick={undoPolish} type="button">
                    <Undo2 className="h-4 w-4" />
                    Put my words back
                  </button>
                </div>
                {/*
                  Which file this draft came from, and how much of it was read. A sender who picked
                  the wrong document has no other way to see it: the words on screen look right
                  either way.
                */}
                {polished.source ? (
                  <p className="mt-2 text-sm font-semibold text-phx-ink-2">{polished.source}</p>
                ) : null}
                {polished.changes.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {polished.changes.map((change) => (
                      <li className="text-sm font-semibold text-phx-ink" key={change}>
                        {change}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm font-semibold text-phx-ink">
                    {polished.mode === "rewrite" ? "The wording was tightened." : "The email is written."}
                  </p>
                )}
                {/*
                  🔴 THE CHECK LIST. A figure the assistant wrote that you never gave it is not refused in
                  write mode — refusing would leave you with no email at all — so it is named here instead,
                  one line each, in the place you cannot miss before pressing Preview.
                */}
                {polished.checks.length > 0 ? (
                  <div className="mt-3 border border-[#FED7AA] bg-phx-accent-soft p-3">
                    <span className="text-phx-xs font-black uppercase tracking-wide text-phx-accent-press">
                      Check these before you send
                    </span>
                    <ul className="mt-2 space-y-1">
                      {polished.checks.map((check) => (
                        <li className="text-sm font-semibold text-phx-ink" key={check}>
                          {check}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <p className="mt-2 text-xs font-semibold text-phx-ink-faint">
                  Read it before you send it. Fill in anything left in [square brackets]. Edit it freely — this panel
                  closes as soon as you do.
                </p>
              </div>
            ) : null}
          </div>

          <div className="mt-4">
            <label className="text-phx-xs font-black uppercase tracking-wide text-phx-ink-2" htmlFor="sato-signoff">
              {variant.signOffLabel}
            </label>
            <input
              className={`mt-2 ${FIELD}`}
              id="sato-signoff"
              onChange={(event) => {
                setSignOff(event.target.value);
                invalidate();
              }}
              placeholder={variant.signOffDefault}
              value={signOff}
            />
            <p className="mt-2 text-xs font-semibold text-phx-ink-faint">{variant.signOffHint}</p>
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
          <button className={DARK_BUTTON} disabled={!canCompose || busy !== null || polishing !== null || uploading} onClick={() => void runPreview()} type="button">
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

            {promisedButEmpty ? (
              <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-900">
                <AlertTriangle className="mr-1.5 inline h-4 w-4" />
                This email says a file is attached, but nothing is attached. Attach it above before you send.
              </p>
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
                {promisedButEmpty ? (
                  <p className="mt-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-900">
                    <AlertTriangle className="mr-1.5 inline h-4 w-4" />
                    Nothing is attached. Press &ldquo;Not yet&rdquo; and attach the file above, or send it without one.
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button className={DARK_BUTTON} disabled={busy !== null || polishing !== null || uploading} onClick={() => void send()} type="button">
                    {busy === "send" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                    {promisedButEmpty ? "Send it without an attachment" : "Yes, send it"}
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

      <SatoTemplateManager
        api={api}
        onSaved={(template) => setTemplates(mergeTemplate(templates, template))}
        templates={templates}
      />
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
  api,
  onSaved,
  templates,
}: {
  // 🔴 PASSED IN, NEVER THE SATO DEFAULT. This component saves a template, and the two composers
  // have two tables: without the variant's own base a CEO letter template would be written into
  // `sato_email_templates`, where it would appear in the HR composer's picker and nowhere else.
  api: string;
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
      const response = await fetch(`${api}/templates`, {
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
