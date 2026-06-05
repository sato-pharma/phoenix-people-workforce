"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";

const sources = [
  "LinkedIn",
  "Facebook",
  "Website",
  "Referral",
  "Future Talents Program",
  "Recruitment Agency",
  "Other",
];

const field = "w-full border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-orange-500 focus:outline-none";

type FormState = {
  fullName: string;
  email: string;
  phone: string;
  governorate: string;
  currentEmployer: string;
  yearsExperience: string;
  expectedSalary: string;
  noticePeriod: string;
  cvExternalUrl: string;
  source: string;
};

const initialState: FormState = {
  fullName: "",
  email: "",
  phone: "",
  governorate: "",
  currentEmployer: "",
  yearsExperience: "",
  expectedSalary: "",
  noticePeriod: "",
  cvExternalUrl: "",
  source: "LinkedIn",
};

export function PublicApplicationForm({ title, token }: { title: string; token: string }) {
  const [form, setForm] = useState<FormState>(initialState);
  const [status, setStatus] = useState<"idle" | "submitting" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const set = (key: keyof FormState) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((prev) => ({ ...prev, [key]: event.target.value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.fullName.trim()) {
      setError("Please enter your full name.");
      return;
    }
    if (!form.email.trim() && !form.phone.trim()) {
      setError("Please provide an email or mobile number.");
      return;
    }
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch(`/api/recruitment/apply/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: form.fullName,
          email: form.email || undefined,
          phone: form.phone || undefined,
          governorate: form.governorate || undefined,
          currentEmployer: form.currentEmployer || undefined,
          yearsExperience: form.yearsExperience || undefined,
          expectedSalary: form.expectedSalary || undefined,
          noticePeriod: form.noticePeriod || undefined,
          cvExternalUrl: form.cvExternalUrl || undefined,
          source: form.source || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Submission failed.");
      setStatus("done");
    } catch (caught) {
      setStatus("idle");
      setError(caught instanceof Error ? caught.message : "Submission failed.");
    }
  };

  if (status === "done") {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center p-6 text-center">
        <h1 className="text-2xl font-semibold text-slate-900">Application received</h1>
        <p className="mt-2 text-sm text-slate-600">
          Thank you for applying for <span className="font-medium">{title}</span>. Our team will be in touch.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl p-6">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-orange-600">Apply now</p>
        <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
        <p className="mt-1 text-sm text-slate-600">Tell us about yourself. Fields marked * are required.</p>
      </div>

      {error ? (
        <div className="mb-4 border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      ) : null}

      <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
        <label className="sm:col-span-2 text-sm text-slate-700">
          Full name *
          <input className={field} value={form.fullName} onChange={set("fullName")} required />
        </label>
        <label className="text-sm text-slate-700">
          Email
          <input className={field} type="email" value={form.email} onChange={set("email")} />
        </label>
        <label className="text-sm text-slate-700">
          Mobile number
          <input className={field} value={form.phone} onChange={set("phone")} />
        </label>
        <label className="text-sm text-slate-700">
          Governorate
          <input className={field} value={form.governorate} onChange={set("governorate")} />
        </label>
        <label className="text-sm text-slate-700">
          Current employer
          <input className={field} value={form.currentEmployer} onChange={set("currentEmployer")} />
        </label>
        <label className="text-sm text-slate-700">
          Years of experience
          <input className={field} type="number" value={form.yearsExperience} onChange={set("yearsExperience")} />
        </label>
        <label className="text-sm text-slate-700">
          Expected salary
          <input className={field} type="number" value={form.expectedSalary} onChange={set("expectedSalary")} />
        </label>
        <label className="text-sm text-slate-700">
          Notice period
          <input className={field} value={form.noticePeriod} onChange={set("noticePeriod")} />
        </label>
        <label className="text-sm text-slate-700">
          How did you hear about us?
          <select className={field} value={form.source} onChange={set("source")}>
            {sources.map((source) => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </select>
        </label>
        <label className="sm:col-span-2 text-sm text-slate-700">
          CV link (Google Drive / Dropbox URL)
          <input className={field} type="url" value={form.cvExternalUrl} onChange={set("cvExternalUrl")} placeholder="https://…" />
        </label>
        <div className="sm:col-span-2">
          <button
            className="bg-orange-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50"
            disabled={status === "submitting"}
            type="submit"
          >
            {status === "submitting" ? "Submitting…" : "Submit application"}
          </button>
        </div>
      </form>
    </main>
  );
}
