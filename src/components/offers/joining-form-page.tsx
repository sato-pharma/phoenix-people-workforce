"use client";

import { useMemo, useState } from "react";

import {
  JOINING_FORM_EDUCATION_OPTIONS,
  JOINING_FORM_GENDER_OPTIONS,
  JOINING_FORM_GOVERNORATES,
  JOINING_FORM_OTHER_AREA,
  readEgyptianNationalId,
  validateJoiningForm,
  type JoiningFormAnswers,
  type JoiningFormField,
} from "@/lib/offers/joining-form";
import type { JoiningFormView } from "@/lib/offers/joining-form-service";

/**
 * The candidate's joining form — 100% Sato Pharma (owner, 2026-10-08), never Phoenix.
 *
 * Sato's SHARP identity, from the `sato-pharma-identity` skill: a navy head band with the reverse
 * mark closed by a 3px brand-blue seam, micro labels (10.5px bold uppercase, 0.2em tracking), 1px
 * hairlines, one brand blue, white paper on a tinted canvas, and every corner 90°. Exempt from the
 * Phoenix form kit for the same reason `offers/` is — this page is the company's, not the app's.
 *
 * Mobile first: a candidate opens it from his phone's mail app. One column at 375px, two for the
 * read-only facts on wider screens, nothing that scrolls sideways, and nothing cut with an ellipsis.
 */

type OpenView = Extract<JoiningFormView, { kind: "open" }>;

const INK = "#111820";
const BRAND = "#0879b8";

const microClass = "text-[10.5px] font-bold uppercase tracking-[0.2em]";
const inputClass =
  "block h-11 w-full rounded-none border border-[#cdd6dc] bg-white px-3 text-[15px] text-[#111820] outline-none transition-colors focus:border-[#0879b8] focus:ring-1 focus:ring-[#0879b8] disabled:bg-[#f2f5f7]";

function money(value: number): string {
  return `EGP ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(value)}`;
}

function letterDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || "To be confirmed";
  const date = new Date(`${iso}T00:00:00Z`);
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "long", timeZone: "UTC", year: "numeric" });
}

export function SatoBand({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <header className="border-b-[3px] border-[#0879b8] bg-[#111820] text-white">
      <div className="mx-auto max-w-3xl px-4 pb-8 pt-6 sm:px-8">
        {/* The reverse mark: SATO is drawn in white, so this file belongs on navy only. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img alt="Sato Pharma" className="h-10 w-auto" src="/brand/sato-pharma-logo.png" />
        <p className={`${microClass} mt-8 text-[#5db7e8]`}>{eyebrow}</p>
        <h1 className="mt-2 break-words text-2xl font-bold leading-tight sm:text-3xl">{title}</h1>
      </div>
    </header>
  );
}

export function SatoFooter() {
  return (
    <footer className="mx-auto max-w-3xl px-4 pb-10 pt-6 sm:px-8">
      <div className="border-t border-[#dde4e8] pt-4">
        <p className={`${microClass} text-[#8a959d]`}>Sato Pharma · Human Resources</p>
        <p className="mt-2 text-xs leading-relaxed text-[#69757e]">
          This page is private to you. If you have any question about your offer, reply to the offer email.
        </p>
      </div>
    </footer>
  );
}

function Section({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <section className="border border-[#dde4e8] bg-white">
      <div className="border-b border-[#dde4e8] px-4 py-3 sm:px-6">
        <h2 className={`${microClass} text-[#0879b8]`}>{label}</h2>
      </div>
      <div className="px-4 py-5 sm:px-6">{children}</div>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0 border-b border-[#e1e7eb] pb-3">
      <dt className={`${microClass} text-[#69757e]`}>{label}</dt>
      <dd className="mt-1 break-words text-[15px] font-semibold text-[#111820]">{value || "To be confirmed by HR"}</dd>
    </div>
  );
}

function Field({
  children,
  error,
  hint,
  htmlFor,
  label,
}: {
  children: React.ReactNode;
  error?: string;
  hint?: string;
  htmlFor: string;
  label: string;
}) {
  return (
    <div className="min-w-0">
      <label className={`${microClass} block text-[#45515a]`} htmlFor={htmlFor}>
        {label}
      </label>
      <div className="mt-2">{children}</div>
      {error ? (
        <p className="mt-1.5 text-sm text-[#b91c1c]" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-xs text-[#69757e]">{hint}</p>
      ) : null}
    </div>
  );
}

type Done = { hrId: string; satoEmail: string | null; satoEmailReason: string | null };

export function JoiningFormPage({ token, view }: { token: string; view: OpenView }) {
  const { job, offer, pay, residence } = view;
  const hasAreaList = residence.areaOptions.length > 0;

  const [answers, setAnswers] = useState<JoiningFormAnswers>({
    birthDate: "",
    education: "",
    educationOther: "",
    fullName: offer.candidateName,
    gender: "",
    mobileNumber: "",
    nationalId: "",
    personalEmail: offer.candidateEmail,
    residenceAddress: "",
    residenceArea: "",
    residenceAreaOther: "",
    residenceCity: residence.defaultCity ?? "",
  });
  const [errors, setErrors] = useState<Partial<Record<JoiningFormField, string>>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  function set<K extends JoiningFormField>(key: K, value: string) {
    setAnswers((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  }

  // The national ID already states the date of birth and the gender — fill both the moment it is
  // complete, so he only confirms them. He can still change either; the check then says they differ.
  function setNationalId(raw: string) {
    set("nationalId", raw);
    const read = readEgyptianNationalId(raw);
    if (read) {
      setAnswers((current) => ({
        ...current,
        birthDate: current.birthDate || read.birthDate,
        gender: current.gender || read.gender,
        nationalId: raw,
      }));
    }
  }

  // The cascade: the area he lives in picks its governorate when that is recognisable.
  function setResidenceArea(value: string) {
    set("residenceArea", value);
    const city = residence.cityByArea[value];
    if (city) setAnswers((current) => ({ ...current, residenceArea: value, residenceCity: city }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setFailure(null);
    const checked = validateJoiningForm(answers, { residenceAreaOptions: residence.areaOptions, todayIso: today });
    if (!checked.value) {
      setErrors(checked.errors);
      const first = Object.keys(checked.errors)[0];
      if (first) document.getElementById(`jf-${first}`)?.focus();
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/public/offer-acceptance/${encodeURIComponent(token)}`, {
        body: JSON.stringify(answers),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        errors?: Partial<Record<JoiningFormField, string>>;
        hrId?: string;
        message?: string;
        ok?: boolean;
        satoEmail?: string | null;
        satoEmailReason?: string | null;
      };
      if (response.ok && payload.ok && payload.hrId) {
        setDone({ hrId: payload.hrId, satoEmail: payload.satoEmail ?? null, satoEmailReason: payload.satoEmailReason ?? null });
        window.scrollTo({ behavior: "smooth", top: 0 });
        return;
      }
      if (payload.errors) setErrors(payload.errors);
      setFailure(payload.message ?? "Please check the highlighted fields and try again.");
    } catch {
      setFailure("We could not reach the server. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="min-h-screen bg-[#f2f5f7] text-[#45515a]">
        <SatoBand eyebrow="Joining form received" title={`Welcome to Sato Pharma, ${offer.salutationName}`} />
        <main className="mx-auto max-w-3xl space-y-5 px-4 py-8 sm:px-8">
          <Section label="You have accepted the offer">
            <p className="text-[15px] leading-relaxed">
              Thank you. Your acceptance and your details are recorded, and your employee record is ready. Our HR
              team will contact you before your first day on {letterDate(job.hireDate)}.
            </p>
            <dl className="mt-5 grid gap-4 sm:grid-cols-2">
              <Fact label="Your HR ID" value={done.hrId} />
              <Fact label="Your Sato email" value={done.satoEmail ?? (done.satoEmailReason ? `HR will send it to you — ${done.satoEmailReason}` : "HR will send it to you")} />
            </dl>
          </Section>
        </main>
        <SatoFooter />
      </div>
    );
  }

  const ref = (field: JoiningFormField) => `jf-${field}`;

  return (
    <div className="min-h-screen bg-[#f2f5f7] text-[#45515a]">
      <SatoBand eyebrow="Joining form" title={`Welcome to Sato Pharma, ${offer.salutationName}`} />
      <main className="mx-auto max-w-3xl space-y-5 px-4 py-8 sm:px-8">
        <p className="text-[15px] leading-relaxed">
          To accept your offer{offer.reference ? ` (${offer.reference})` : ""}, check your position below and complete
          your personal details. <strong className="text-[#111820]">Pressing Submit is your acceptance of the offer.</strong>{" "}
          If you wish to decline, simply reply to the offer email.
        </p>

        <Section label="Your position">
          <dl className="grid gap-4 sm:grid-cols-2">
            <Fact label="HR ID" value={job.hrIdPreview ? `${job.hrIdPreview} (confirmed when you submit)` : null} />
            <Fact label="Job position" value={job.jobTitle} />
            <Fact label="Department" value={job.departmentName} />
            <Fact label="Line" value={job.lineName} />
            <Fact label="Area" value={job.areaName} />
            <Fact label="Region" value={job.regionName} />
            <Fact label="Manager" value={job.managerName} />
            <Fact label="Manager ID" value={job.managerHrId} />
            <Fact label="Hiring date" value={letterDate(job.hireDate)} />
            <Fact label="Contract type" value={job.contractType} />
            <Fact
              label="Sato email"
              value={job.satoEmail ? `${job.satoEmail} (created when you submit)` : `HR will send it to you${job.satoEmailReason ? ` — ${job.satoEmailReason}` : ""}`}
            />
          </dl>
        </Section>

        {pay ? (
          <Section label="Your monthly package">
            <table className="w-full table-fixed border-collapse text-[15px]">
              <colgroup>
                <col />
                <col className="w-1/2" />
              </colgroup>
              <tbody>
                {[
                  ["Base salary", pay.baseSalary],
                  ["Basic salary", pay.basicSalary],
                  ["Fuel allowance", pay.fuelAllowance],
                  ["Extra cost of living", pay.extraCostOfLiving],
                  ["Gross salary", pay.grossSalary],
                ].map(([label, amount]) => (
                  <tr className="border-b border-[#e1e7eb]" key={label as string}>
                    <th className="py-2.5 pr-3 text-left font-normal">{label}</th>
                    <td className="py-2.5 text-right font-semibold tabular-nums text-[#111820]">{money(amount as number)}</td>
                  </tr>
                ))}
                <tr className="bg-[#f3f9fc]">
                  <th className={`${microClass} px-2 py-3 text-left text-[#0879b8]`}>Net salary</th>
                  <td className="px-2 py-3 text-right text-lg font-bold tabular-nums text-[#111820]">{money(pay.netSalary)}</td>
                </tr>
              </tbody>
            </table>
          </Section>
        ) : null}

        <form noValidate onSubmit={submit}>
          <Section label="Your details">
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Field error={errors.fullName} hint="As written on your national ID card, in English." htmlFor={ref("fullName")} label="Full name">
                  <input autoComplete="name" className={inputClass} id={ref("fullName")} onChange={(e) => set("fullName", e.target.value)} value={answers.fullName} />
                </Field>
              </div>
              <Field error={errors.mobileNumber} htmlFor={ref("mobileNumber")} label="Mobile number">
                <input autoComplete="tel" className={inputClass} id={ref("mobileNumber")} inputMode="tel" onChange={(e) => set("mobileNumber", e.target.value)} placeholder="01XXXXXXXXX" type="tel" value={answers.mobileNumber} />
              </Field>
              <Field error={errors.personalEmail} htmlFor={ref("personalEmail")} label="Private email">
                <input autoComplete="email" className={inputClass} id={ref("personalEmail")} inputMode="email" onChange={(e) => set("personalEmail", e.target.value)} type="email" value={answers.personalEmail} />
              </Field>
              <div className="sm:col-span-2">
                <Field error={errors.nationalId} hint="14 digits. Your date of birth and gender are filled in from it." htmlFor={ref("nationalId")} label="National ID number">
                  <input className={inputClass} id={ref("nationalId")} inputMode="numeric" maxLength={20} onChange={(e) => setNationalId(e.target.value)} value={answers.nationalId} />
                </Field>
              </div>
              <Field error={errors.gender} htmlFor={ref("gender")} label="Gender">
                <select className={inputClass} id={ref("gender")} onChange={(e) => set("gender", e.target.value)} value={answers.gender}>
                  <option value="">Choose</option>
                  {JOINING_FORM_GENDER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </Field>
              <Field error={errors.birthDate} htmlFor={ref("birthDate")} label="Date of birth">
                <input className={inputClass} id={ref("birthDate")} max={today} onChange={(e) => set("birthDate", e.target.value)} type="date" value={answers.birthDate} />
              </Field>
              <Field error={errors.education} htmlFor={ref("education")} label="Education">
                <select className={inputClass} id={ref("education")} onChange={(e) => set("education", e.target.value)} value={answers.education}>
                  <option value="">Choose your faculty</option>
                  {JOINING_FORM_EDUCATION_OPTIONS.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </Field>
              {answers.education === "Other" ? (
                <Field error={errors.educationOther} htmlFor={ref("educationOther")} label="Your faculty or degree">
                  <input className={inputClass} id={ref("educationOther")} onChange={(e) => set("educationOther", e.target.value)} value={answers.educationOther} />
                </Field>
              ) : (
                <div className="hidden sm:block" />
              )}

              <Field error={errors.residenceArea} htmlFor={ref("residenceArea")} label="Residence area">
                {hasAreaList ? (
                  <select className={inputClass} id={ref("residenceArea")} onChange={(e) => setResidenceArea(e.target.value)} value={answers.residenceArea}>
                    <option value="">Choose your area</option>
                    {residence.areaOptions.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                    <option value={JOINING_FORM_OTHER_AREA}>My area is not listed</option>
                  </select>
                ) : (
                  <input className={inputClass} id={ref("residenceArea")} onChange={(e) => set("residenceArea", e.target.value)} placeholder="District or neighbourhood" value={answers.residenceArea} />
                )}
              </Field>
              <Field error={errors.residenceCity} htmlFor={ref("residenceCity")} label="Residence city">
                <select className={inputClass} id={ref("residenceCity")} onChange={(e) => set("residenceCity", e.target.value)} value={answers.residenceCity}>
                  <option value="">Choose your city</option>
                  {JOINING_FORM_GOVERNORATES.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </Field>
              {hasAreaList && answers.residenceArea === JOINING_FORM_OTHER_AREA ? (
                <div className="sm:col-span-2">
                  <Field error={errors.residenceAreaOther} htmlFor={ref("residenceAreaOther")} label="Your area">
                    <input className={inputClass} id={ref("residenceAreaOther")} onChange={(e) => set("residenceAreaOther", e.target.value)} placeholder="District or neighbourhood" value={answers.residenceAreaOther} />
                  </Field>
                </div>
              ) : null}
              <div className="sm:col-span-2">
                <Field error={errors.residenceAddress} htmlFor={ref("residenceAddress")} label="Residence address">
                  <textarea
                    className={`${inputClass.replace("h-11 ", "")} min-h-[88px] py-2.5`}
                    id={ref("residenceAddress")}
                    onChange={(e) => set("residenceAddress", e.target.value)}
                    placeholder="Building, street, landmark"
                    rows={3}
                    value={answers.residenceAddress}
                  />
                </Field>
              </div>
            </div>
          </Section>

          {failure ? (
            <p className="mt-5 border border-[#b91c1c] bg-white px-4 py-3 text-sm text-[#b91c1c]" role="alert">
              {failure}
            </p>
          ) : null}

          <div className="mt-5 border border-[#dde4e8] bg-white px-4 py-5 sm:px-6">
            <p className="text-sm leading-relaxed">
              By pressing Submit you accept the offer of employment from Sato Pharma and confirm that the details above
              are correct.
            </p>
            <button
              className="mt-4 h-12 w-full rounded-none px-6 text-[15px] font-bold text-white transition-colors disabled:opacity-60 sm:w-auto"
              disabled={busy}
              style={{ background: busy ? INK : BRAND }}
              type="submit"
            >
              {busy ? "Submitting…" : "Submit and accept the offer"}
            </button>
          </div>
        </form>
      </main>
      <SatoFooter />
    </div>
  );
}
