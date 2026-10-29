"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  ClipboardPaste,
  Copy,
  ExternalLink,
  Inbox,
  Link2Off,
  Loader2,
  Mail,
  MessageCircle,
  PenLine,
  Plus,
  Radio,
  RefreshCw,
  Share2,
  Smartphone,
} from "lucide-react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import {
  RecruitmentEmptyState,
  RecruitmentKpiStrip,
  RecruitmentPanel,
  RecruitmentPill,
  RecruitmentTabBar,
  recruitmentToolbarClassName,
} from "@/components/recruitment/recruitment-premium";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import {
  applyDestinationForChannel,
  buildApplyLink,
  composeJobAdvert,
  renderAdvertForChannel,
} from "@/lib/recruitment/outreach/job-advert";
import type { ApplyChannelKind } from "@/lib/recruitment/outreach/job-advert";
import type { ChannelAttribution, JobPostChannel } from "@/lib/recruitment/outreach/job-post-channels";
import {
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

type Destinations = { whatsappNumber: string | null; email: string | null };

type LoadedState = {
  channels: JobPostChannel[];
  attribution: ChannelAttribution;
  destinations: Destinations;
};

const COMPANY_NAME = "Sato Pharma";

/**
 * How each channel kind reads on screen, and whether you can post in it yourself.
 *
 * A WhatsApp or Telegram *channel* is a broadcast feed — only its admins can write to it. Listing
 * one beside a group you can post in, with nothing to tell them apart, is how an afternoon goes
 * into trying to publish somewhere that will never accept a post. So the row says which it is, and
 * a broadcast row offers "Copy & ask" rather than pretending the paste will land.
 *
 * Defined here rather than imported from the service: that module reaches the database, and pulling
 * a value out of it would drag server code into this client bundle.
 */
const PLATFORM_LABELS: Record<string, { label: string; broadcast: boolean }> = {
  facebook_group: { broadcast: false, label: "Facebook group" },
  facebook_page: { broadcast: false, label: "Facebook page" },
  job_board: { broadcast: false, label: "Job board" },
  other: { broadcast: false, label: "Other" },
  referral: { broadcast: false, label: "Referral" },
  telegram_channel: { broadcast: true, label: "Telegram channel" },
  telegram_group: { broadcast: false, label: "Telegram group" },
  whatsapp_channel: { broadcast: true, label: "WhatsApp channel" },
  whatsapp_group: { broadcast: false, label: "WhatsApp group" },
};

function platformOf(kind: string): { label: string; broadcast: boolean } {
  return PLATFORM_LABELS[kind] ?? { broadcast: false, label: "Other" };
}

/**
 * Advertise a vacancy — write the post once, hand every group its own tracked apply link.
 *
 * There is deliberately no "post to Facebook" button, and there cannot be one. Facebook deleted the
 * Groups API from every Graph API version on 2026-04-22, and personal accounts have had no
 * publishing API since 2018. Posting into a group is a human paste, permanently. What this screen
 * removes is everything AROUND the paste: writing twenty variants by hand, and having no idea
 * afterwards which group was worth it.
 */
export function JobAdvertPanel() {
  const [state, setState] = useState<LoadedState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);

  const [jobTitle, setJobTitle] = useState("");
  const [location, setLocation] = useState("");
  const [requirements, setRequirements] = useState("");
  const [bodyOverride, setBodyOverride] = useState<string | null>(null);
  // WhatsApp by default — the owner decided this on 2026-08-25, after being shown what it costs.
  // The advertised handset 01159888247 is where he wants applicants to write, and in Egypt it is
  // where most of them will write whatever a post says.
  //
  // What it costs, and why the warning below stays on screen: measured on production 2026-08-24,
  // WhatsApp intake was 434 events from 11 distinct senders — HR staff forwarding batches off that
  // handset, not applicants — against email at 276 events from 213 senders. A forward carries the
  // CV file but NOT the applicant's own message, and that message is the only place the tracking
  // code lives. So WhatsApp CVs arrive, and arrive unattributed, until Coexistence delivers
  // applicant messages to the webhook direct. Email's code rides in the subject line and survives.
  const [applyKind, setApplyKind] = useState<ApplyChannelKind>("whatsapp");

  const [paste, setPaste] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  // Every setState sits inside the scheduled callback, never the effect body —
  // react-hooks/set-state-in-effect is an error in this repo and blocks the required lint check.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (cancelled) return;
      try {
        const response = await fetch("/api/recruitment/job-post-channels", { cache: "no-store" });
        const json = (await response.json()) as Record<string, unknown>;
        if (cancelled) return;
        if (!response.ok || json.success !== true) {
          setLoadError(typeof json.message === "string" ? json.message : "Could not load advertising channels.");
          return;
        }
        setLoadError(null);
        setState({
          attribution: json.attribution as ChannelAttribution,
          channels: json.channels as JobPostChannel[],
          destinations: json.destinations as Destinations,
        });
      } catch {
        if (!cancelled) setLoadError("Could not reach the server.");
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [reloadKey]);

  const generatedBody = useMemo(
    () =>
      composeJobAdvert({
        bulletPoints: requirements.split(/\r?\n/),
        companyName: COMPANY_NAME,
        jobTitle,
        location,
      }),
    [jobTitle, location, requirements],
  );
  const body = bodyOverride ?? generatedBody;

  const defaultWhatsAppNumber = state?.destinations.whatsappNumber ?? null;
  const email = state?.destinations.email ?? null;
  // The default the top of the screen shows; individual channels may override the WhatsApp number.
  const destination = applyKind === "whatsapp" ? defaultWhatsAppNumber : email;

  const linkFor = useCallback(
    (channel: JobPostChannel) => {
      const channelDestination = applyDestinationForChannel({
        channelApplyWhatsAppNumber: channel.applyWhatsAppNumber,
        defaultWhatsAppNumber,
        email,
        kind: applyKind,
      });
      return channelDestination
        ? buildApplyLink({ code: channel.code, destination: channelDestination, jobTitle, kind: applyKind, location })
        : null;
    },
    [applyKind, defaultWhatsAppNumber, email, jobTitle, location],
  );

  const copyForChannel = useCallback(
    async (channel: JobPostChannel) => {
      const text = renderAdvertForChannel(body, linkFor(channel));
      try {
        await navigator.clipboard.writeText(text);
        setNotice(`Copied the post for ${channel.name}. Paste it into the group.`);
      } catch {
        setNotice("Could not reach the clipboard — select the advert box above and copy it by hand.");
        return;
      }
      if (channel.url) window.open(channel.url, "_blank", "noopener,noreferrer");
    },
    [body, linkFor],
  );

  const addChannels = useCallback(async () => {
    if (paste.trim().length === 0) return;
    setBusy(true);
    try {
      const response = await fetch("/api/recruitment/job-post-channels", {
        body: JSON.stringify({ paste }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const json = (await response.json()) as Record<string, unknown>;
      if (!response.ok || json.success !== true) {
        setNotice(typeof json.message === "string" ? json.message : "Could not add those groups.");
        return;
      }
      const created = Array.isArray(json.created) ? json.created.length : 0;
      const skipped = Array.isArray(json.skipped) ? json.skipped.length : 0;
      setPaste("");
      setNotice(
        skipped > 0
          ? `Added ${created}. Skipped ${skipped} already on the list.`
          : `Added ${created} advertising ${created === 1 ? "channel" : "channels"}.`,
      );
      setReloadKey((key) => key + 1);
    } finally {
      setBusy(false);
    }
  }, [paste]);

  const retire = useCallback(async (channel: JobPostChannel) => {
    setBusy(true);
    try {
      await fetch(`/api/recruitment/job-post-channels/${channel.id}`, {
        body: JSON.stringify({ isActive: !channel.isActive }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      setReloadKey((key) => key + 1);
    } finally {
      setBusy(false);
    }
  }, []);

  // Point one channel's tracked apply link at a specific WhatsApp line, or clear it back to the
  // company default (a blank value). Only writes when the value actually changed, so tabbing through
  // the column without editing costs nothing.
  const setApplyNumber = useCallback(async (channel: JobPostChannel, raw: string) => {
    const next = raw.trim();
    if (next === (channel.applyWhatsAppNumber ?? "")) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/recruitment/job-post-channels/${channel.id}`, {
        body: JSON.stringify({ applyWhatsAppNumber: next.length > 0 ? next : null }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      const json = (await response.json()) as Record<string, unknown>;
      if (!response.ok || json.success !== true) {
        setNotice(typeof json.message === "string" ? json.message : "That is not a usable WhatsApp number.");
        return;
      }
      setNotice(
        next.length > 0
          ? `${channel.name} now sends applicants to ${next}.`
          : `${channel.name} is back on the default apply number.`,
      );
      setReloadKey((key) => key + 1);
    } finally {
      setBusy(false);
    }
  }, []);

  // Tie one relay handset to one advert channel (or clear it with channelCode = null). A code-less
  // forward from that number is then attributed to the channel; the on-CV code always wins.
  const assignForwarder = useCallback(async (identifier: string, channelCode: string | null) => {
    const number = identifier.trim();
    if (number.length === 0) return;
    setBusy(true);
    try {
      const response = await fetch("/api/recruitment/job-post-channels/forwarders", {
        body: JSON.stringify({ channelCode, identifier: number }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const json = (await response.json()) as Record<string, unknown>;
      if (!response.ok || json.success !== true) {
        setNotice(typeof json.message === "string" ? json.message : "Could not update the relay handset.");
        return;
      }
      setReloadKey((key) => key + 1);
    } finally {
      setBusy(false);
    }
  }, []);

  const [newRelay, setNewRelay] = useState("");
  const [newRelayChannel, setNewRelayChannel] = useState("");

  const channels = state?.channels ?? [];
  const activeChannels = channels.filter((channel) => channel.isActive);
  // The number that actually matters once the list runs to forty-odd rows: how many of them will
  // accept a post from you at all. The rest are broadcast feeds you can only ask an admin to carry.
  const postableCount = activeChannels.filter((channel) => !platformOf(channel.kind).broadcast).length;
  const attributionRows = state?.attribution.rows ?? [];
  // One row per configured relay handset, each showing which channel its code-less forwards land on.
  const relayRows = channels.flatMap((channel) =>
    channel.forwarderIdentifiers.map((number) => ({
      channelCode: channel.code,
      channelName: channel.name,
      number,
    })),
  );
  const relaySelectClass =
    `${phxSelectClassName} max-w-[16rem]`;

  // The four figures a recruiter reads before posting anything: how many channels are live, how many
  // of those accept a post from them at all, how many relay handsets are mapped, and how many CVs
  // still arrive with no code. A failed load prints "—", never a misleading zero.
  const advertKpis = [
    {
      description: "Groups and feeds on the list today",
      icon: <Radio aria-hidden="true" className="h-4 w-4" />,
      label: "Active channels",
      tone: "orange" as const,
      value: state ? activeChannels.length : "—",
    },
    {
      description: "The rest are broadcast feeds you can only ask to carry it",
      icon: <Share2 aria-hidden="true" className="h-4 w-4" />,
      label: "You can post in",
      tone: "blue" as const,
      value: state ? postableCount : "—",
    },
    {
      description: "Handsets whose code-less forwards inherit a channel",
      icon: <Smartphone aria-hidden="true" className="h-4 w-4" />,
      label: "Relay handsets",
      tone: "violet" as const,
      value: state ? relayRows.length : "—",
    },
    {
      description: `CVs with no tracking code, last ${state?.attribution.sinceDays ?? 90} days`,
      icon: <Link2Off aria-hidden="true" className="h-4 w-4" />,
      label: "Arrived untracked",
      tone: "rose" as const,
      value: state ? state.attribution.untracked : "—",
    },
  ];

  return (
    <div className="space-y-6">
      <AdminCallout tone="neutral">
        <div>
          <p className="font-semibold">Facebook has no way to post this for you.</p>
          <p className="mt-1">
            Meta deleted the Groups API on 22 April 2024 and personal accounts have had no publishing
            API since 2018, so no tool — this one, Buffer, Hootsuite — can post into a group. Pasting
            by hand is the only way, and automating it from a logged-in account is what gets accounts
            restricted. What this screen does instead: writes the post once, gives every group its own
            apply link, and then tells you which groups actually produced CVs.
          </p>
        </div>
      </AdminCallout>

      <RecruitmentKpiStrip items={advertKpis} />

      {loadError ? <AdminCallout tone="warning">{loadError}</AdminCallout> : null}
      {notice ? <AdminCallout tone="success">{notice}</AdminCallout> : null}

      {/* ── 1 · The advert ─────────────────────────────────────────────── */}
      <RecruitmentPanel
        bodyClassName="space-y-4 p-4 sm:p-5"
        description="Write it once. Each group gets the same words with its own apply link on the end."
        icon={<PenLine aria-hidden="true" className="h-4 w-4" />}
        title="The post"
      >
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="font-medium text-slate-700">Job title</span>
            <Input onChange={(event) => setJobTitle(event.target.value)} placeholder="Medical Representative" value={jobTitle} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium text-slate-700">Location</span>
            <Input onChange={(event) => setLocation(event.target.value)} placeholder="Giza" value={location} />
          </label>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="font-medium text-slate-700">Requirements — one per line</span>
          <textarea
            className={cn(phxTextareaClassName, "min-h-20")}
            onChange={(event) => setRequirements(event.target.value)}
            placeholder={"2+ years in pharmaceutical sales\nOwn car preferred"}
            value={requirements}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="flex flex-wrap items-center gap-2 font-medium text-slate-700">
            The post as it will be pasted — edit freely
            {bodyOverride !== null ? <RecruitmentPill tone="amber">Edited by hand</RecruitmentPill> : null}
          </span>
          <textarea
            className={cn(phxTextareaClassName, "min-h-40 font-mono")}
            onChange={(event) => setBodyOverride(event.target.value)}
            value={body}
          />
        </label>
        {bodyOverride !== null ? (
          <Button onClick={() => setBodyOverride(null)} size="sm" variant="ghost">
            <RefreshCw className="mr-1 h-3 w-3" /> Rebuild from the fields above
          </Button>
        ) : null}
      </RecruitmentPanel>

      {/* ── 2 · Where applicants land ──────────────────────────────────── */}
      <RecruitmentPanel
        bodyClassName="space-y-4 p-4 sm:p-5"
        description="The link at the bottom of the post. Whichever you choose, the CV lands in this system automatically."
        icon={<Inbox aria-hidden="true" className="h-4 w-4" />}
        title="Where applicants send their CV"
      >
        <RecruitmentTabBar<ApplyChannelKind>
          label="Where applicants send their CV"
          onChange={(kind) => setApplyKind(kind)}
          tabs={[
            { icon: <MessageCircle className="h-4 w-4" />, key: "whatsapp", label: "WhatsApp" },
            { icon: <Mail className="h-4 w-4" />, key: "email", label: "Email" },
          ]}
          value={applyKind}
        />
        {applyKind === "whatsapp" ? (
          <AdminCallout tone="warning">
            <div>
              <p className="font-semibold">WhatsApp keeps the tracking when the code rides on the CV</p>
              <p className="mt-1">
                CVs sent to the handset enter this system when someone forwards them, and a forward
                carries the CV file, its caption and its filename — but not the applicant&apos;s
                separate greeting, which is where the code sits by default. Intake now reads the code
                off the caption and the filename as well, so it survives a forward whenever it lands
                on the CV itself. It is lost only when the applicant sends the code as its own message
                and the file is then forwarded alone. Email always keeps the code, because it travels
                in the subject line.
              </p>
            </div>
          </AdminCallout>
        ) : null}
        {destination ? (
          <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 border border-slate-200 border-l-4 border-l-orange-500 bg-slate-50/70 px-3 py-2.5 text-sm text-slate-600 ${adminRecessedDepthClassName}`}>
            <span>Applicants will reach:</span>
            <span className="break-words font-mono text-[13px] font-bold text-slate-950">{destination}</span>
            {applyKind === "whatsapp" ? (
              <span className="basis-full text-[12px] text-slate-500">
                By default — a channel with its own apply line below overrides this for its own link.
              </span>
            ) : null}
          </div>
        ) : (
          <AdminCallout tone="warning">
            <div>
              <p className="font-semibold">
                {applyKind === "whatsapp" ? "No WhatsApp number set" : "No careers mailbox set"}
              </p>
              <p className="mt-1">
                {applyKind === "whatsapp"
                  ? "Set RECRUITMENT_APPLY_WHATSAPP_NUMBER to the number applicants should message. Until then the post copies without an apply link."
                  : "No mailbox is configured in RECRUITMENT_EMAIL_INBOXES_JSON, so there is no address to send applicants to."}
              </p>
            </div>
          </AdminCallout>
        )}
      </RecruitmentPanel>

      {/* ── 3 · The groups ─────────────────────────────────────────────── */}
      <RecruitmentPanel
        bodyClassName="space-y-3 p-4 sm:p-5"
        description="Paste links, one per line — Facebook, WhatsApp or Telegram. 'Name | link' works, a bare link works, and so does a whole copied table."
        icon={<ClipboardPaste aria-hidden="true" className="h-4 w-4" />}
        title="Where you post it"
      >
        <textarea
          className={cn(phxTextareaClassName, "min-h-24 font-mono")}
          onChange={(event) => setPaste(event.target.value)}
          placeholder={"https://facebook.com/groups/medical.reps.egypt\nMedical Reps Cairo | https://chat.whatsapp.com/EF1I33PPgEF3b9XJ7k4pDG\nhttps://t.me/Recruitmentblogs"}
          value={paste}
        />
        <Button disabled={busy || paste.trim().length === 0} onClick={addChannels} size="sm">
          {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Plus className="mr-1 h-3 w-3" />} Add these channels
        </Button>
      </RecruitmentPanel>

      <RecruitmentPanel
        count={`${activeChannels.length} active · ${postableCount} you can post in`}
        description="Copy takes the post plus that channel's own tracked link, then opens the channel so you can paste."
        icon={<Radio aria-hidden="true" className="h-4 w-4" />}
        title="Channels"
      >
        <PortalResponsiveDataList
          empty={
            <RecruitmentEmptyState
              icon={<Radio aria-hidden="true" className="h-5 w-5" />}
              message="Paste your group links above."
              title="No channels yet"
            />
          }
          getKey={(channel: JobPostChannel) => channel.id}
          items={channels}
          renderCard={(channel: JobPostChannel) => (
            <PortalRecordCard title={channel.name}>
              <PortalRecordFields
                fields={[
                  {
                    label: "Where",
                    value: platformOf(channel.kind).broadcast
                      ? `${platformOf(channel.kind).label} — broadcast`
                      : platformOf(channel.kind).label,
                  },
                  { label: "Status", value: channel.isActive ? "Active" : "Retired" },
                ]}
              />
              <label className="mt-2 block text-xs uppercase text-slate-500" htmlFor={`apply-${channel.id}`}>
                Apply line
              </label>
              <Input
                className="mt-1 h-9 font-mono text-xs"
                defaultValue={channel.applyWhatsAppNumber ?? ""}
                disabled={busy}
                id={`apply-${channel.id}`}
                key={`apply-card-${channel.id}-${channel.applyWhatsAppNumber ?? ""}`}
                onBlur={(event) => setApplyNumber(channel, event.target.value)}
                placeholder={defaultWhatsAppNumber ?? "default"}
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <Button onClick={() => copyForChannel(channel)} size="sm">
                  <Copy className="mr-1 h-3 w-3" /> {platformOf(channel.kind).broadcast ? "Copy & ask" : "Copy & open"}
                </Button>
                <Button disabled={busy} onClick={() => retire(channel)} size="sm" variant="ghost">
                  {channel.isActive ? "Retire" : "Restore"}
                </Button>
              </div>
            </PortalRecordCard>
          )}
          renderTable={() => (
            <PortalDesktopTable
              cols={
                <colgroup>
                  <col className="w-[22%]" />
                  <col className="w-[20%]" />
                  <col className="w-[22%]" />
                  <col className="w-[10%]" />
                  <col className="w-[26%]" />
                </colgroup>
              }
            >
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="break-words p-2">Channel</th>
                  <th className="break-words p-2">Where</th>
                  <th className="break-words p-2">Apply line</th>
                  <th className="break-words p-2">Status</th>
                  <th className="break-words p-2">Post it</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((channel) => (
                  <tr className="border-b border-slate-100 align-top transition-colors hover:bg-orange-50/30" key={channel.id}>
                    <td className="break-words p-2 font-semibold text-slate-900">{channel.name}</td>
                    <td className="break-words p-2 text-slate-600">
                      {platformOf(channel.kind).label}
                      {platformOf(channel.kind).broadcast ? (
                        <span className="mt-1 block text-[12px] text-amber-700">Broadcast — ask the admin</span>
                      ) : null}
                    </td>
                    <td className="p-2">
                      <Input
                        aria-label={`Apply line for ${channel.name}`}
                        className="h-9 max-w-[11rem] font-mono text-xs"
                        defaultValue={channel.applyWhatsAppNumber ?? ""}
                        disabled={busy}
                        key={`apply-${channel.id}-${channel.applyWhatsAppNumber ?? ""}`}
                        onBlur={(event) => setApplyNumber(channel, event.target.value)}
                        placeholder={defaultWhatsAppNumber ?? "default"}
                      />
                    </td>
                    <td className="p-2">
                      <ChannelStatusPill active={channel.isActive} />
                    </td>
                    <td className="p-2">
                      <div className="flex flex-wrap gap-2">
                        <Button onClick={() => copyForChannel(channel)} size="sm">
                          <Copy className="mr-1 h-3 w-3" />
                          {platformOf(channel.kind).broadcast ? "Copy & ask" : "Copy & open"}
                          {channel.url ? <ExternalLink className="ml-1 h-3 w-3" /> : null}
                        </Button>
                        <Button disabled={busy} onClick={() => retire(channel)} size="sm" variant="ghost">
                          {channel.isActive ? "Retire" : "Restore"}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </PortalDesktopTable>
          )}
        />
      </RecruitmentPanel>

      {/* ── 4 · Relay handsets ─────────────────────────────────────────── */}
      <RecruitmentPanel
        count={relayRows.length}
        description="Most CVs reach us forwarded from a relay handset, which drops the applicant's code-bearing message. Tie each relay to the channel it forwards from, and its code-less forwards inherit that channel. A CV that still carries its own code always keeps it."
        icon={<Smartphone aria-hidden="true" className="h-4 w-4" />}
        title="Relay handsets"
      >
        <p className="border-b border-slate-100 px-4 py-2.5 text-[12px] text-slate-500 sm:px-5">
          A relay maps to one channel. Move it here whenever a handset&apos;s source changes — no code change needed.
        </p>
        <PortalResponsiveDataList
          empty={
            <RecruitmentEmptyState
              icon={<Smartphone aria-hidden="true" className="h-5 w-5" />}
              message="Add a relay handset number below and pick the channel it forwards from."
              title="No relay handsets mapped"
            />
          }
          getKey={(row: (typeof relayRows)[number]) => row.number}
          items={relayRows}
          renderCard={(row: (typeof relayRows)[number]) => (
            <PortalRecordCard title={row.number}>
              <label className="mt-2 block text-xs uppercase text-slate-500" htmlFor={`relay-${row.number}`}>
                Forwards from
              </label>
              <select
                className={relaySelectClass}
                disabled={busy}
                id={`relay-${row.number}`}
                onChange={(event) => assignForwarder(row.number, event.target.value || null)}
                value={row.channelCode}
              >
                <option value="">— Unassigned —</option>
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.code}>
                    {channel.name}
                    {channel.isActive ? "" : " (retired)"}
                  </option>
                ))}
              </select>
            </PortalRecordCard>
          )}
          renderTable={() => (
            <PortalDesktopTable
              cols={
                <colgroup>
                  <col className="w-[35%]" />
                  <col className="w-[65%]" />
                </colgroup>
              }
            >
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="break-words p-2">Handset</th>
                  <th className="break-words p-2">Forwards from</th>
                </tr>
              </thead>
              <tbody>
                {relayRows.map((row) => (
                  <tr className="border-b border-slate-100 transition-colors hover:bg-orange-50/30" key={row.number}>
                    <td className="break-words p-2 font-mono text-xs font-semibold text-slate-900">{row.number}</td>
                    <td className="p-2">
                      <select
                        aria-label={`Channel for ${row.number}`}
                        className={relaySelectClass}
                        disabled={busy}
                        onChange={(event) => assignForwarder(row.number, event.target.value || null)}
                        value={row.channelCode}
                      >
                        <option value="">— Unassigned —</option>
                        {channels.map((channel) => (
                          <option key={channel.id} value={channel.code}>
                            {channel.name}
                            {channel.isActive ? "" : " (retired)"}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </PortalDesktopTable>
          )}
        />
        <div className={cn("m-4 sm:m-5", recruitmentToolbarClassName)}>
          <div className="min-w-[12rem] flex-1">
            <label className="block text-xs uppercase text-slate-500" htmlFor="new-relay-number">
              Add a relay handset
            </label>
            <Input
              id="new-relay-number"
              onChange={(event) => setNewRelay(event.target.value)}
              placeholder="e.g. 01280955558"
              value={newRelay}
            />
          </div>
          <select
            aria-label="Channel for the new relay handset"
            className={relaySelectClass}
            disabled={busy}
            onChange={(event) => setNewRelayChannel(event.target.value)}
            value={newRelayChannel}
          >
            <option value="">Pick a channel…</option>
            {channels.map((channel) => (
              <option key={channel.id} value={channel.code}>
                {channel.name}
                {channel.isActive ? "" : " (retired)"}
              </option>
            ))}
          </select>
          <Button
            disabled={busy || newRelay.trim().length === 0 || newRelayChannel.length === 0}
            onClick={async () => {
              await assignForwarder(newRelay, newRelayChannel || null);
              setNewRelay("");
              setNewRelayChannel("");
            }}
            size="sm"
          >
            <Plus className="mr-1 h-3 w-3" /> Attach
          </Button>
        </div>
      </RecruitmentPanel>

      {/* ── 5 · What it produced ───────────────────────────────────────── */}
      <RecruitmentPanel
        count={attributionRows.length}
        description={`Candidates whose CV arrived through each group's own link, over the last ${state?.attribution.sinceDays ?? 90} days. Counted per person, not per message — someone who sends their CV three times is one candidate.`}
        icon={<BarChart3 aria-hidden="true" className="h-4 w-4" />}
        title="What each group produced"
      >
        <PortalResponsiveDataList
          empty={
            <RecruitmentEmptyState
              icon={<BarChart3 aria-hidden="true" className="h-5 w-5" />}
              message="Nothing has come through a tracked link yet."
              title="No attributed CVs yet"
            />
          }
          getKey={(row: ChannelAttribution["rows"][number]) => row.code}
          items={attributionRows}
          renderCard={(row: ChannelAttribution["rows"][number]) => (
            <PortalRecordCard title={row.name}>
              <PortalRecordFields
                fields={[
                  { label: "Candidates", value: String(row.candidates) },
                  { label: "Last CV", value: row.lastCvAt ? formatPhoenixLongDate(row.lastCvAt) : "—" },
                ]}
              />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <PortalDesktopTable
              cols={
                <colgroup>
                  <col className="w-[45%]" />
                  <col className="w-[25%]" />
                  <col className="w-[30%]" />
                </colgroup>
              }
            >
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="break-words p-2">Group</th>
                  <th className="break-words p-2">Candidates</th>
                  <th className="break-words p-2">Last CV</th>
                </tr>
              </thead>
              <tbody>
                {attributionRows.map((row) => (
                  <tr className="border-b border-slate-100 transition-colors hover:bg-orange-50/30" key={row.code}>
                    <td className="break-words p-2 font-semibold text-slate-900">{row.name}</td>
                    <td className="p-2 text-base font-black tabular-nums text-slate-950">{row.candidates}</td>
                    <td className="break-words p-2 text-slate-600">
                      {row.lastCvAt ? formatPhoenixLongDate(row.lastCvAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </PortalDesktopTable>
          )}
        />
        {state ? (
          <p className="border-t border-slate-100 px-4 py-3 text-sm text-slate-600 sm:px-5">
            <span className="font-bold tabular-nums text-slate-900">
              {state.attribution.untracked} CV{state.attribution.untracked === 1 ? "" : "s"}
            </span>{" "}
            arrived with no code — everything posted before this existed, plus anyone who wrote their own
            message instead of tapping the link.
          </p>
        ) : null}
      </RecruitmentPanel>
    </div>
  );
}

/** A channel's state as a pill — live in green, retired in grey — so the column reads at a glance. */
function ChannelStatusPill({ active }: { active: boolean }) {
  return <RecruitmentPill tone={active ? "emerald" : "slate"}>{active ? "Active" : "Retired"}</RecruitmentPill>;
}
