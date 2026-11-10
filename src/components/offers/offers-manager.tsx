"use client";

// The job-offer workspace.
//
// THREE TABS, ONE MODULE. Compose an offer, design the letter it is printed from, and keep the
// job-title catalogue that drives cost of living. They are one screen because they are one job:
// you cannot send an offer for a title that has no cost-of-living figure, and you cannot judge a
// figure without seeing the letter it lands in.
//
// WHY THIS IS NOT PART OF RECRUITMENT. The owner asked for it separately, and the reason is
// operational: the recruitment module's offer stage only exists for somebody who entered the ATS
// as a candidate. An offer here can go to anybody — a referral, a direct approach, a rehire —
// without first manufacturing a fake application to hang it on.
//
// The design identity is taken from HR Forms next door: the same rounded shell, the same
// hero, the same field labels and button sizes. The two produce the two documents a new hire
// signs, in order.

import { AlertTriangle, CheckCircle2, FileSignature, LayoutTemplate, Mail, Tags } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { AdminCallout, AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { OfferComposer } from "@/components/offers/offer-composer";
import { OfferJobTitleCatalogue } from "@/components/offers/offer-job-titles";
import { OfferTemplateDesigner } from "@/components/offers/offer-template-designer";
import { cn } from "@/lib/utils";
import type { OfferJobTitle, OfferRecord, OfferTemplate, OfferVacancyOption } from "@/lib/offers/types";
import type { OfferSenderInfo } from "@/components/offers/offer-ui";

type Tab = "compose" | "design" | "titles";

const TABS: { icon: ReactNode; label: string; value: Tab }[] = [
  { icon: <Mail className="h-4 w-4" />, label: "Offers", value: "compose" },
  { icon: <LayoutTemplate className="h-4 w-4" />, label: "Letter designer", value: "design" },
  { icon: <Tags className="h-4 w-4" />, label: "Job titles", value: "titles" },
];

export function OffersManager({
  canApprove,
  canDelete,
  canManage,
  initialError,
  jobTitles: initialJobTitles,
  offers: initialOffers,
  sender,
  templates: initialTemplates,
  vacancies,
}: {
  /**
   * `offers:delete` — a narrower grant than `canManage` (`offers:create`). HR Advisory,
   * the role that holds the `offers` grant, holds create/update but not delete, so the two
   * cannot be collapsed into one flag without showing it buttons that answer 403.
   */
  canDelete: boolean;
  /** `offers:approve` — the HR Manager. Without it, Send goes to him for approval (owner, 2026-11-10). */
  canApprove: boolean;
  canManage: boolean;
  initialError: string | null;
  jobTitles: OfferJobTitle[];
  offers: OfferRecord[];
  sender: OfferSenderInfo;
  templates: OfferTemplate[];
  /**
   * The open seats an offer can be written against. Loaded once with the workspace and passed
   * straight through — this shell owns no state of its own about them, because nothing on this
   * screen creates or closes a seat. A hire does that, on the employees screen.
   */
  vacancies: OfferVacancyOption[];
}) {
  const [tab, setTab] = useState<Tab>("compose");
  const [offers, setOffers] = useState(initialOffers);
  const [templates, setTemplates] = useState(initialTemplates);
  const [jobTitles, setJobTitles] = useState(initialJobTitles);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);

  const report = useCallback((message: string | null, kind: "error" | "success") => {
    if (kind === "error") {
      setError(message);
      setNotice(null);
    } else {
      setNotice(message);
      setError(null);
    }
  }, []);

  const sentCount = useMemo(() => offers.filter((offer) => offer.status !== "draft" && offer.status !== "pending_approval").length, [offers]);
  const draftCount = offers.length - sentCount;

  return (
    <div className="relative overflow-hidden rounded-[34px] border border-phx-line bg-phx-paper p-4 shadow-[0_24px_70px_rgba(15,23,42,0.1)] sm:p-6">
      <div className="flex flex-col gap-5">
        <AdminPageHero
          badges={
            <>
              <AdminInsightChip tone="orange">{draftCount} drafts</AdminInsightChip>
              <AdminInsightChip>{sentCount} issued</AdminInsightChip>
              <AdminInsightChip>{templates.length} templates</AdminInsightChip>
              <AdminInsightChip>{jobTitles.length} job titles</AdminInsightChip>
            </>
          }
          description="Fill the fields once, and the letter, the salary breakdown and the email write themselves. Offers go out as Sato Pharmaceuticals — never as Phoenix."
          eyebrow="Hiring"
          icon={<FileSignature className="h-5 w-5" />}
          title="Job Offers"
        />

        {/* The sender identity is stated on screen, not buried in configuration. It is the one
            thing the owner was explicit about, and an unconfigured address is a real problem: the
            candidate would receive an offer from a placeholder mailbox. */}
        {sender.refusedFrom ? (
          <AdminCallout tone="warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <code className="mr-1 rounded bg-amber-100 px-1.5 py-0.5 font-mono text-xs">JOB_OFFER_EMAIL_FROM</code>
              holds <strong>{sender.refusedFrom}</strong>, which is not a mailbox an offer may be sent from. Offers
              are going out from <strong>{sender.from}</strong> instead. An offer fires only from
              <strong> {sender.allowedFrom.join(" or ")}</strong>.
            </span>
          </AdminCallout>
        ) : !sender.isConfigured ? (
          <AdminCallout tone="warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Offers will be sent from <strong>{sender.from}</strong>, the built-in default. Set
              <code className="mx-1 rounded bg-amber-100 px-1.5 py-0.5 font-mono text-xs">JOB_OFFER_EMAIL_FROM</code>
              to <strong>{sender.allowedFrom.join(" or ")}</strong> — the only two an offer may fire from — and make
              sure replies to <strong>{sender.replyTo}</strong> are read.
            </span>
          </AdminCallout>
        ) : null}

        {error ? (
          <AdminCallout tone="danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </AdminCallout>
        ) : null}
        {notice ? (
          <AdminCallout tone="success">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{notice}</span>
          </AdminCallout>
        ) : null}

        <div
          aria-label="Job offer sections"
          className="flex flex-wrap gap-1 rounded-2xl border border-phx-line bg-white/95 p-1 shadow-sm"
          role="tablist"
        >
          {TABS.map((entry) => {
            const active = entry.value === tab;
            return (
              <button
                aria-selected={active}
                className={cn(
                  "inline-flex items-center gap-2 whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-bold transition-all",
                  active
                    ? "bg-gradient-to-r from-orange-500 to-amber-400 text-white shadow-[0_8px_20px_rgba(249,115,22,0.28)]"
                    : "text-phx-ink-soft hover:bg-slate-100 hover:text-slate-900",
                )}
                key={entry.value}
                onClick={() => setTab(entry.value)}
                role="tab"
                type="button"
              >
                {entry.icon}
                {entry.label}
              </button>
            );
          })}
        </div>

        {tab === "compose" ? (
          <OfferComposer
            canApprove={canApprove}
            canManage={canManage}
            jobTitles={jobTitles}
            offers={offers}
            onOffers={setOffers}
            onReport={report}
            sender={sender}
            templates={templates}
            vacancies={vacancies}
          />
        ) : null}
        {tab === "design" ? (
          <OfferTemplateDesigner
            canDelete={canDelete}
            canManage={canManage}
            onReport={report}
            onTemplates={setTemplates}
            templates={templates}
          />
        ) : null}
        {tab === "titles" ? (
          <OfferJobTitleCatalogue
            canDelete={canDelete}
            canManage={canManage}
            jobTitles={jobTitles}
            onJobTitles={setJobTitles}
            onReport={report}
            templates={templates}
          />
        ) : null}
      </div>
    </div>
  );
}
