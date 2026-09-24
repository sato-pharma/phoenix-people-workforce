// Recruitment / ATS — source-of-hire attribution.
//
// The question this answers is the one the whole tracked-link machinery exists for and no report
// reached: which advert, and which channel, actually produced a HIRE — not a CV, a hire.
//
// ── WHY THIS IS A JOIN NOBODY HAD DONE ──────────────────────────────────────────────────────────
//
// Every physical link in the chain already exists; none of them were ever joined end to end:
//
//   employees.hr_id
//     = ats_applications.converted_employee_hr_id   (the hire)
//     → ats_applications.candidate_id
//     → ats_cv_intake_events.candidate_id           (where a surviving PX- code was stamped)
//     → ats_cv_intake_events.source_channel_code
//     → ats_job_post_channels.code                  (the advert, its name and kind)
//
// `getChannelAttribution` counts CANDIDATES per code and never looks at hire stage; the hiring
// funnel reaches hires but keys on the coarse `whatsapp/email/website` source and has no advert in
// it. So "which advert produced this hire" had no answer.
//
// ── TWO LEVELS, AND WHY THE COVERAGE DIFFERS ────────────────────────────────────────────────────
//
//   • CHANNEL level (WhatsApp / Facebook / Email / …) is ~100% of hires. Every candidate carries a
//     coarse source, so every hire lands in a channel bucket even when no advert is known.
//   • ADVERT level (which specific group) is only as good as what survived. The tracked PX- code
//     rides inside the applicant's own first message, and a forwarded WhatsApp CV — the majority of
//     intake, per the job-advert panel's own warning — drops that message. So most hires have NO
//     automatic advert, and the honest report shows them as "Unknown advert" rather than guessing.
//
// The manual tag closes exactly that gap: an HR person attributes a hire to the real advert when
// they know it, and it overrides the (usually absent) automatic code. Measured on production
// 2026-09-24, ZERO candidates carried a code, so today the manual tag is the ONLY route to
// advert-level attribution — which is why it exists.
//
// ── THIS MODULE IS PURE ─────────────────────────────────────────────────────────────────────────
//
// Only the arithmetic lives here so it can be tested against fixed rows. The database reads live in
// hiring-analytics.ts, which already loads the candidate pool this shares.

import { normalizeChannelCode } from "@/lib/recruitment/outreach/channel-code";

/** One hired application, flattened to just what attribution needs. */
export type HiredApplicationInput = {
  applicationId: string;
  candidateId: string;
  employeeHrId: string | null;
  hiredAt: string | null;
  /** ats_applications.attributed_channel_code — the manually-tagged advert, if any. */
  manualChannelCode: string | null;
  /** ats_candidates.source — the coarse channel (whatsapp / email / website), ~always present. */
  coarseSource: string | null;
  /** The earliest surviving source_channel_code across this candidate's intake events, if any. */
  autoChannelCode: string | null;
};

/** A row from the advert directory, enough to name and group a code. */
export type ChannelDirectoryEntry = { code: string; name: string; kind: string };

/** Where the effective advert came from — surfaced so the report can say "tagged" vs "tracked". */
export type AttributionBasis = "manual" | "auto" | "none";

/**
 * The advert this hire is attributed to, and how.
 *
 * Manual beats automatic on purpose: a person who tagged the hire knows something the tracked link
 * could not carry. `none` is not a failure — it is the honest majority, a hire whose advert the
 * forward dropped and nobody has tagged.
 */
export function resolveEffectiveAdvert(input: HiredApplicationInput): {
  code: string | null;
  basis: AttributionBasis;
} {
  const manual = normalizeChannelCode(input.manualChannelCode);
  if (manual) return { code: manual, basis: "manual" };
  const auto = normalizeChannelCode(input.autoChannelCode);
  if (auto) return { code: auto, basis: "auto" };
  return { code: null, basis: "none" };
}

/**
 * The channel bucket an advert kind belongs to.
 *
 * Coarser than the kind on purpose: "Facebook group" and "Facebook page" are one channel to the
 * person deciding where the next advert goes, and a WhatsApp group and a WhatsApp channel are one
 * place applicants come from. The report's channel level is about spend, not plumbing.
 */
export function channelGroupForKind(kind: string | null | undefined): string {
  switch (String(kind ?? "").trim()) {
    case "facebook_group":
    case "facebook_page":
      return "Facebook";
    case "whatsapp_group":
    case "whatsapp_channel":
      return "WhatsApp";
    case "telegram_group":
    case "telegram_channel":
      return "Telegram";
    case "job_board":
      return "Job board";
    case "referral":
      return "Referral";
    default:
      return "Other";
  }
}

/**
 * The channel bucket a coarse candidate source belongs to.
 *
 * This is the ~100% fallback: it runs for every hire whose advert is unknown, so a hire is never
 * lost from the channel view just because its group could not be recovered.
 */
export function channelGroupForCoarseSource(source: string | null | undefined): string {
  const normalized = String(source ?? "").trim().toLowerCase();
  switch (normalized) {
    case "whatsapp":
      return "WhatsApp";
    case "email":
      return "Email";
    case "website":
      return "Website";
    case "referral":
      return "Referral";
    case "":
      return "Unrecorded";
    default:
      // A free-text source that is not one of the known channels — shown as itself, title-cased,
      // rather than swept into "Other", because an unexpected value is worth seeing, not hiding.
      return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
}

export type SourceOfHireAdvertRow = {
  code: string;
  name: string;
  /** The advert kind's channel group, for grouping and for a kind that has no directory row. */
  channel: string;
  hires: number;
  /** Of `hires`, how many were tagged by a person vs. recovered from a tracked link. */
  manualHires: number;
  autoHires: number;
};

export type SourceOfHireChannelRow = { channel: string; hires: number };

export type SourceOfHire = {
  totalHires: number;
  /** Hires with an effective advert (manual or auto). The rest are channel-only. */
  attributedToAdvert: number;
  /** Of the attributed, how many a person tagged — the manual tag's whole contribution. */
  taggedByAPerson: number;
  channels: SourceOfHireChannelRow[];
  adverts: SourceOfHireAdvertRow[];
  /** Hires that have a channel but no advert — the honest "we don't know which group" bucket. */
  unknownAdvert: number;
};

/**
 * Roll a set of hires up into channel-level and advert-level attribution.
 *
 * Channel level counts EVERY hire (advert kind when the advert is known, coarse source otherwise),
 * so it always totals `totalHires`. Advert level counts only hires with an effective advert, and
 * everything else is one honest `unknownAdvert` figure — never spread across guesses.
 *
 * Sorted by hires then name, so the biggest producer reads first and the order is stable when two
 * tie (a raw hires sort would reorder ties run to run).
 */
export function buildSourceOfHire(
  hires: readonly HiredApplicationInput[],
  directory: readonly ChannelDirectoryEntry[],
): SourceOfHire {
  const byCode = new Map<string, ChannelDirectoryEntry>();
  for (const entry of directory) {
    const code = normalizeChannelCode(entry.code);
    if (code) byCode.set(code, entry);
  }

  const channelHires = new Map<string, number>();
  const advertHires = new Map<string, { name: string; channel: string; hires: number; manual: number; auto: number }>();
  let attributedToAdvert = 0;
  let taggedByAPerson = 0;
  let unknownAdvert = 0;

  for (const hire of hires) {
    const { code, basis } = resolveEffectiveAdvert(hire);

    if (code) {
      attributedToAdvert += 1;
      if (basis === "manual") taggedByAPerson += 1;
      const entry = byCode.get(code) ?? null;
      const channel = channelGroupForKind(entry?.kind);
      // A code with no directory row still counts — it names itself, so a retired-then-purged code
      // never silently drops a hire.
      const name = entry?.name ?? code;
      const bucket = advertHires.get(code) ?? { auto: 0, channel, hires: 0, manual: 0, name };
      bucket.hires += 1;
      if (basis === "manual") bucket.manual += 1;
      else bucket.auto += 1;
      advertHires.set(code, bucket);
      channelHires.set(channel, (channelHires.get(channel) ?? 0) + 1);
    } else {
      unknownAdvert += 1;
      const channel = channelGroupForCoarseSource(hire.coarseSource);
      channelHires.set(channel, (channelHires.get(channel) ?? 0) + 1);
    }
  }

  const channels = [...channelHires.entries()]
    .map(([channel, count]) => ({ channel, hires: count }))
    .sort((left, right) => right.hires - left.hires || left.channel.localeCompare(right.channel));

  const adverts = [...advertHires.entries()]
    .map(([code, value]) => ({
      autoHires: value.auto,
      channel: value.channel,
      code,
      hires: value.hires,
      manualHires: value.manual,
      name: value.name,
    }))
    .sort((left, right) => right.hires - left.hires || left.name.localeCompare(right.name));

  return {
    adverts,
    attributedToAdvert,
    channels,
    taggedByAPerson,
    totalHires: hires.length,
    unknownAdvert,
  };
}
