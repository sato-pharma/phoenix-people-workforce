"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, ExternalLink, Loader2, Plus, RefreshCw } from "lucide-react";

import { AdminCallout, AdminSectionHeader, AdminTableShell } from "@/components/admin/admin-design-system";
import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import { buildApplyLink, composeJobAdvert, renderAdvertForChannel } from "@/lib/recruitment/outreach/job-advert";
import type { ApplyChannelKind } from "@/lib/recruitment/outreach/job-advert";
import type { ChannelAttribution, JobPostChannel } from "@/lib/recruitment/outreach/job-post-channels";

type Destinations = { whatsappNumber: string | null; email: string | null };

type LoadedState = {
  channels: JobPostChannel[];
  attribution: ChannelAttribution;
  destinations: Destinations;
};

const COMPANY_NAME = "Sato Pharma";

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

  const destination =
    applyKind === "whatsapp" ? (state?.destinations.whatsappNumber ?? null) : (state?.destinations.email ?? null);

  const linkFor = useCallback(
    (channel: JobPostChannel) =>
      destination
        ? buildApplyLink({ code: channel.code, destination, jobTitle, kind: applyKind, location })
        : null,
    [applyKind, destination, jobTitle, location],
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

  const channels = state?.channels ?? [];
  const activeChannels = channels.filter((channel) => channel.isActive);
  const attributionRows = state?.attribution.rows ?? [];

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

      {loadError ? <AdminCallout tone="warning">{loadError}</AdminCallout> : null}
      {notice ? <AdminCallout tone="success">{notice}</AdminCallout> : null}

      {/* ── 1 · The advert ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <AdminSectionHeader
          description="Write it once. Each group gets the same words with its own apply link on the end."
          title="The post"
        />
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
            className="min-h-20 w-full rounded-md border border-slate-200 p-2 text-sm"
            onChange={(event) => setRequirements(event.target.value)}
            placeholder={"2+ years in pharmaceutical sales\nOwn car preferred"}
            value={requirements}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="font-medium text-slate-700">The post as it will be pasted — edit freely</span>
          <textarea
            className="min-h-40 w-full rounded-md border border-slate-200 p-2 font-mono text-xs"
            onChange={(event) => setBodyOverride(event.target.value)}
            value={body}
          />
        </label>
        {bodyOverride !== null ? (
          <Button onClick={() => setBodyOverride(null)} size="sm" variant="ghost">
            <RefreshCw className="mr-1 h-3 w-3" /> Rebuild from the fields above
          </Button>
        ) : null}
      </section>

      {/* ── 2 · Where applicants land ──────────────────────────────────── */}
      <section className="space-y-3">
        <AdminSectionHeader
          description="The link at the bottom of the post. Whichever you choose, the CV lands in this system automatically."
          title="Where applicants send their CV"
        />
        <div className="flex flex-wrap gap-2">
          {(["whatsapp", "email"] as ApplyChannelKind[]).map((kind) => (
            <Button key={kind} onClick={() => setApplyKind(kind)} size="sm" variant={applyKind === kind ? "default" : "ghost"}>
              {kind === "whatsapp" ? "WhatsApp" : "Email"}
            </Button>
          ))}
        </div>
        {destination ? (
          <p className="text-sm text-slate-600">
            Applicants will reach: <span className="font-medium text-slate-900">{destination}</span>
          </p>
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
      </section>

      {/* ── 3 · The groups ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <AdminSectionHeader
          description="Paste group links, one per line. 'Name | link' works too, and so does a bare link."
          title="Where you post it"
        />
        <textarea
          className="min-h-24 w-full rounded-md border border-slate-200 p-2 font-mono text-xs"
          onChange={(event) => setPaste(event.target.value)}
          placeholder={"https://facebook.com/groups/medical.reps.egypt\nPharma Jobs Cairo | https://facebook.com/groups/123456789"}
          value={paste}
        />
        <Button disabled={busy || paste.trim().length === 0} onClick={addChannels} size="sm">
          {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Plus className="mr-1 h-3 w-3" />} Add these groups
        </Button>

        <AdminTableShell
          description="Copy takes the post plus that group's own link, then opens the group so you can paste."
          title={`Groups (${activeChannels.length} active)`}
        >
          <PortalResponsiveDataList
            empty={<PortalEmptyState message="Paste your Facebook group links above." title="No groups yet" />}
            getKey={(channel: JobPostChannel) => channel.id}
            items={channels}
            renderCard={(channel: JobPostChannel) => (
              <PortalRecordCard title={channel.name}>
                <PortalRecordFields
                  fields={[
                    { label: "Code", value: channel.code },
                    { label: "Status", value: channel.isActive ? "Active" : "Retired" },
                  ]}
                />
                <div className="mt-2 flex gap-2">
                  <Button onClick={() => copyForChannel(channel)} size="sm">
                    <Copy className="mr-1 h-3 w-3" /> Copy &amp; open
                  </Button>
                  <Button disabled={busy} onClick={() => retire(channel)} size="sm" variant="ghost">
                    {channel.isActive ? "Retire" : "Restore"}
                  </Button>
                </div>
              </PortalRecordCard>
            )}
            renderTable={() => (
              <PortalDesktopTable minWidth="720px">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                    <th className="whitespace-nowrap p-2">Group</th>
                    <th className="whitespace-nowrap p-2">Code</th>
                    <th className="whitespace-nowrap p-2">Status</th>
                    <th className="whitespace-nowrap p-2">Post it</th>
                  </tr>
                </thead>
                <tbody>
                  {channels.map((channel) => (
                    <tr className="border-b border-slate-100" key={channel.id}>
                      <td className="whitespace-nowrap p-2 font-medium text-slate-900">{channel.name}</td>
                      <td className="whitespace-nowrap p-2 font-mono text-xs text-slate-600">{channel.code}</td>
                      <td className="whitespace-nowrap p-2 text-slate-600">{channel.isActive ? "Active" : "Retired"}</td>
                      <td className="whitespace-nowrap p-2">
                        <div className="flex gap-2">
                          <Button onClick={() => copyForChannel(channel)} size="sm">
                            <Copy className="mr-1 h-3 w-3" /> Copy &amp; open
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
        </AdminTableShell>
      </section>

      {/* ── 4 · What it produced ───────────────────────────────────────── */}
      <section className="space-y-3">
        <AdminSectionHeader
          description={`Candidates whose CV arrived through each group's own link, over the last ${state?.attribution.sinceDays ?? 90} days.`}
          title="What each group produced"
        />
        <AdminTableShell
          description="Counted per person, not per message — someone who sends their CV three times is one candidate."
          title="Candidates by group"
        >
          <PortalResponsiveDataList
            empty={<PortalEmptyState message="Nothing has come through a tracked link yet." title="No attributed CVs yet" />}
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
              <PortalDesktopTable minWidth="620px">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                    <th className="whitespace-nowrap p-2">Group</th>
                    <th className="whitespace-nowrap p-2">Candidates</th>
                    <th className="whitespace-nowrap p-2">Last CV</th>
                  </tr>
                </thead>
                <tbody>
                  {attributionRows.map((row) => (
                    <tr className="border-b border-slate-100" key={row.code}>
                      <td className="whitespace-nowrap p-2 font-medium text-slate-900">{row.name}</td>
                      <td className="whitespace-nowrap p-2 tabular-nums text-slate-900">{row.candidates}</td>
                      <td className="whitespace-nowrap p-2 text-slate-600">
                        {row.lastCvAt ? formatPhoenixLongDate(row.lastCvAt) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </PortalDesktopTable>
            )}
          />
        </AdminTableShell>
        {state ? (
          <p className="text-sm text-slate-600">
            {state.attribution.untracked} CV{state.attribution.untracked === 1 ? "" : "s"} arrived with no code —
            everything posted before this existed, plus anyone who wrote their own message instead of tapping the link.
          </p>
        ) : null}
      </section>
    </div>
  );
}
