"use client";

import * as React from "react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { phxFieldClassName, phxFieldGridTwoClassName, phxLabelClassName, phxSelectClassName, phxTextareaClassName } from "@/components/ui/form-tokens";
import { formatLeftDay } from "@/lib/employees/left-flag";
import { MEDICAL_INSURANCE_DOCUMENT_WORDS, type MedicalInsuranceDocumentKind, type MedicalInsuranceDocumentRow, type MedicalInsuranceMoneyView, type MedicalInsuranceView } from "@/lib/medical-insurance/view";

import { cairoDateTime, SaveError, sendForm, sendJson, textLinkClassName, useSave } from "./medical-insurance-parts";

const SEAT_URL = "/api/medical-insurance/documents";
const RESTRICTED_URL = "/api/medical-insurance/invoices/documents";

function urlFor(kind: MedicalInsuranceDocumentKind): string {
  return kind === "policy" || kind === "email" ? RESTRICTED_URL : SEAT_URL;
}

function sizeWords(bytes: number | null): string | null {
  if (!bytes) return null;
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function MedicalInsuranceDocumentsTab({ canEdit, money, view }: { canEdit: boolean; money: MedicalInsuranceMoneyView | null; view: MedicalInsuranceView }) {
  const kinds: MedicalInsuranceDocumentKind[] = money ? ["communication_tool", "form", "policy", "email"] : ["communication_tool", "form"];

  return (
    <div className="space-y-5">
      <DocumentList canEdit={canEdit} description="The insurer's contacts and how to reach them, and the forms it asks for." documents={view.documents} empty="No communication tools or forms saved yet." title="Communication tools and forms" />
      {money ? <DocumentList canEdit description="The policy and every email with the insurer. These stay with you." documents={money.documents} empty="The policy and emails have not been saved yet." title="Policy and emails" /> : null}
      {canEdit || money ? <AddDocumentPanel kinds={canEdit ? kinds : kinds.filter((kind) => kind === "policy" || kind === "email")} /> : null}
    </div>
  );
}

function DocumentList({ canEdit, description, documents, empty, title }: { canEdit: boolean; description: string; documents: MedicalInsuranceDocumentRow[]; empty: string; title: string }) {
  const { busy, error, save } = useSave();

  return (
    <AdminTableShell description={description} title={title}>
      <SaveError error={error} />
      {documents.length === 0 ? (
        <p className="p-4 text-sm font-semibold text-phx-ink-soft">{empty}</p>
      ) : (
        <ul>
          {documents.map((document) => {
            const url = `${urlFor(document.kind)}/${document.id}`;
            const size = sizeWords(document.sizeBytes);
            return (
              <li className="gap-6 border-b border-phx-line p-4 md:flex md:items-start md:justify-between" key={document.id}>
                <div className="min-w-0 flex-1 space-y-1">
                <p className="break-words text-sm font-black text-phx-ink" dir="auto">{document.title}</p>
                <p className="break-words text-phx-xs font-bold text-phx-ink-soft">
                  {MEDICAL_INSURANCE_DOCUMENT_WORDS[document.kind]}{size ? `, ${size}` : ""}. Saved {cairoDateTime(document.uploadedAt)}{document.uploadedByName ? ` by ${document.uploadedByName}` : ""}.
                </p>
                {document.emailFrom || document.emailTo || document.emailSentOn ? (
                  <p className="break-words text-phx-xs font-semibold text-phx-ink-soft" dir="auto">
                    {[document.emailFrom ? `From ${document.emailFrom}` : null, document.emailTo ? `to ${document.emailTo}` : null, document.emailSentOn ? `on ${formatLeftDay(document.emailSentOn)}` : null].filter(Boolean).join(" ")}
                  </p>
                ) : null}
                {document.note ? <p className="break-words text-phx-xs font-semibold text-phx-ink-faint" dir="auto">{document.note}</p> : null}
                {document.body ? <p className="whitespace-pre-wrap break-words border-l-2 border-phx-line pl-3 text-sm text-phx-ink" dir="auto">{document.body}</p> : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-x-3 gap-y-1 pt-1">
                  {document.fileName ? <a className={textLinkClassName} href={url} rel="noreferrer" target="_blank">Open</a> : null}
                  {document.fileName ? <a className={textLinkClassName} href={`${url}?download=1`}>Download</a> : null}
                  {canEdit ? (
                    <button className={textLinkClassName} disabled={busy} onClick={() => void save(() => sendJson(url, "DELETE"))} type="button">
                      Take off this page
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </AdminTableShell>
  );
}

function AddDocumentPanel({ kinds }: { kinds: MedicalInsuranceDocumentKind[] }) {
  const { busy, error, save } = useSave();
  const [kind, setKind] = React.useState<MedicalInsuranceDocumentKind>(kinds[0] ?? "communication_tool");
  const [title, setTitle] = React.useState("");
  const [note, setNote] = React.useState("");
  const [emailFrom, setEmailFrom] = React.useState("");
  const [emailTo, setEmailTo] = React.useState("");
  const [emailSentOn, setEmailSentOn] = React.useState("");
  const [body, setBody] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const isEmail = kind === "email";

  function add() {
    const form = new FormData();
    form.set("kind", kind);
    form.set("title", title);
    form.set("note", note);
    if (isEmail) {
      form.set("emailFrom", emailFrom);
      form.set("emailTo", emailTo);
      form.set("emailSentOn", emailSentOn);
      form.set("body", body);
    }
    if (file) form.set("file", file);
    void save(
      () => sendForm(urlFor(kind), form),
      () => {
        setTitle("");
        setNote("");
        setEmailFrom("");
        setEmailTo("");
        setEmailSentOn("");
        setBody("");
        setFile(null);
        if (fileRef.current) fileRef.current.value = "";
      },
    );
  }

  return (
    <AdminTableShell description="A file of up to 25 MB, or for an email, its pasted text." title="Save a document">
      <div className="space-y-3 p-4">
        <div className={phxFieldGridTwoClassName}>
          <label className="block">
            <span className={phxLabelClassName}>What it is</span>
            <select className={phxSelectClassName} onChange={(event) => setKind(event.target.value as MedicalInsuranceDocumentKind)} value={kind}>
              {kinds.map((value) => <option key={value} value={value}>{MEDICAL_INSURANCE_DOCUMENT_WORDS[value]}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={phxLabelClassName}>Title</span>
            <input className={phxFieldClassName} onChange={(event) => setTitle(event.target.value)} value={title} />
          </label>
          <label className="block">
            <span className={phxLabelClassName}>File</span>
            <input className={phxFieldClassName} onChange={(event) => setFile(event.target.files?.[0] ?? null)} ref={fileRef} type="file" />
          </label>
          <label className="block">
            <span className={phxLabelClassName}>Note</span>
            <input className={phxFieldClassName} onChange={(event) => setNote(event.target.value)} value={note} />
          </label>
          {isEmail ? (
            <>
              <label className="block">
                <span className={phxLabelClassName}>From</span>
                <input className={phxFieldClassName} onChange={(event) => setEmailFrom(event.target.value)} value={emailFrom} />
              </label>
              <label className="block">
                <span className={phxLabelClassName}>To</span>
                <input className={phxFieldClassName} onChange={(event) => setEmailTo(event.target.value)} value={emailTo} />
              </label>
              <label className="block">
                <span className={phxLabelClassName}>Date sent</span>
                <input className={phxFieldClassName} onChange={(event) => setEmailSentOn(event.target.value)} type="date" value={emailSentOn} />
              </label>
              <label className="block sm:col-span-2">
                <span className={phxLabelClassName}>The email&apos;s text</span>
                <textarea className={phxTextareaClassName} onChange={(event) => setBody(event.target.value)} rows={6} value={body} />
              </label>
            </>
          ) : null}
        </div>
        <SaveError error={error} />
        <Button className="h-10" disabled={busy} onClick={add}>Save</Button>
      </div>
    </AdminTableShell>
  );
}
