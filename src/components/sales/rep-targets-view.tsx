"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, CalendarClock, CalendarRange, Info, Package } from "lucide-react";

import { CountUpNumber } from "@/components/ui/count-up";
import {
  AchievementMeter,
  AchievementRing,
  BandChoice,
  BandStat,
  CommandBand,
  LABEL_CLASS,
  ProportionBar,
  SURFACE_CLASS,
  SectionCard,
  TABLE_HEAD_CLASS,
  TABLE_ROW_CLASS,
  TARGET_COLOR,
  achievementHex,
  achievementTone,
  formatEgp,
  formatEgpFull,
  formatNumber,
  formatPct,
  formatPeriod,
} from "@/components/sales/target-visuals";
import type {
  RepTargetsData,
  RepTargetsMonth,
  RepTargetsMonthStatus,
  RepTargetsProduct,
} from "@/lib/sales/rep-targets";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Targets — a Medical Rep's own view (owner, 2026-09-16).
//
// The manager workspace answers "how is my territory doing, area by area". A rep holds one or two
// areas, so the same grid would be a table of one row per product with the area repeated down it.
// This view answers the rep's questions instead, in the order they ask them: what is my target this
// month, what is it product by product, how many days are left, and — once a month's closing is
// published — how far did I get.
//
// It speaks the sales modules' one visual language (`target-visuals.tsx`): the same command band,
// ring, meters, tones and square edges as Sales vs Target and the manager Targets screen.
//
// Every number arrives computed from src/lib/sales/rep-targets.ts. Nothing here adds, divides or
// decides publication — in particular nothing here may add units of two different products, which
// is why the only cross-product totals below are values.
// ─────────────────────────────────────────────────────────────────────────────

type RepTargetsViewProps = {
  data: RepTargetsData;
  /** Route the month picker navigates to. */
  basePath?: string;
  /** The rep's Sales vs Target page, where a published month's bricks live. */
  salesVsTargetHref?: string;
};

const OUTLINE_ACTION_CLASS =
  "inline-flex h-8 items-center gap-1.5 border border-slate-200 bg-white px-3 text-phx-xs font-bold text-slate-700 transition-colors hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-orange-500";

const CARD_FACT_CLASS = "flex flex-wrap items-baseline justify-between gap-x-2";

const STATUS_LABEL: Record<RepTargetsMonthStatus, string> = {
  published: "Published",
  in_progress: "In progress",
  awaiting_closing: "Awaiting closing",
  upcoming: "Upcoming",
};

const STATUS_CHIP_CLASS: Record<RepTargetsMonthStatus, string> = {
  published: "border-emerald-200 bg-emerald-50 text-emerald-700",
  in_progress: "border-orange-200 bg-orange-50 text-orange-700",
  awaiting_closing: "border-amber-200 bg-amber-50 text-amber-700",
  upcoming: "border-sky-200 bg-sky-50 text-sky-700",
};

/** What a month tile says where a published month shows its achievement. */
const STATUS_HINT: Record<Exclude<RepTargetsMonthStatus, "published">, string> = {
  in_progress: "Measured once this month's closing is published",
  awaiting_closing: "Monthly Closing not published yet",
  upcoming: "Loaded ahead of the month",
};

/** "September 2026" — the band chips keep the short form, sentences read the full one. */
function formatMonthLong(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return period;
  return new Date(Number(match[1]), Number(match[2]) - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function plural(count: number, one: string, many: string): string {
  return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

function unitsLabel(units: number | null): string {
  return units == null ? "—" : plural(units, "unit", "units");
}

function StatusChip({ status }: { status: RepTargetsMonthStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap border px-1.5 py-0.5 text-phx-2xs font-black uppercase tracking-[0.12em]",
        STATUS_CHIP_CLASS[status],
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * Sold minus target for one product, in words.
 *
 * Direction comes from VALUE, because value is what achievement measures. The units half is added
 * only when it points the same way and does not round to zero — "short by 0 units", or units
 * pointing up beside a value pointing down, would contradict the meter printed next to it.
 */
function GapText({ product }: { product: RepTargetsProduct }) {
  if (product.gapValue == null) return <span className="text-slate-400">—</span>;
  const gap = product.gapValue;
  const units = product.gapUnits;
  const showUnits =
    units != null && Math.round(Math.abs(units)) > 0 && Math.sign(units) === Math.sign(gap);
  const tone = achievementTone(product.achievementValue);
  if (gap === 0) return <span className={cn("font-bold", tone)}>On target</span>;
  return (
    <span className={cn("font-bold", tone)}>
      {`${gap < 0 ? "Short by" : "Above by"} ${formatEgp(Math.abs(gap))}`}
      {showUnits ? (
        <span className="block text-phx-xs font-semibold text-slate-500">{unitsLabel(Math.abs(units!))}</span>
      ) : null}
    </span>
  );
}

function Notice({
  tone,
  icon: Icon,
  title,
  children,
}: {
  tone: "orange" | "amber" | "sky";
  icon: typeof Info;
  title: string;
  children: React.ReactNode;
}) {
  const palette = {
    orange: { box: "border-slate-200 border-l-orange-500 bg-white", icon: "text-orange-600", text: "text-slate-700", title: "text-slate-900" },
    amber: { box: "border-amber-200 border-l-amber-500 bg-amber-50", icon: "text-amber-600", text: "text-amber-900", title: "text-amber-900" },
    sky: { box: "border-sky-200 border-l-sky-500 bg-sky-50", icon: "text-sky-600", text: "text-sky-900", title: "text-sky-900" },
  }[tone];
  return (
    <div className={cn("flex items-start gap-3 border border-l-[3px] px-4 py-3", palette.box)}>
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", palette.icon)} />
      <div className={cn("min-w-0 text-xs leading-5", palette.text)}>
        <p className={cn("font-bold", palette.title)}>{title}</p>
        <p>{children}</p>
      </div>
    </div>
  );
}

/**
 * One month, as a LINK rather than a button: a tile holds block content (the shared meter renders a
 * `<div>` and a `<p>`), which a `<button>` may not contain and an `<a>` may. A plain click goes
 * through the view's transition so the page dims while the month loads; a modified click keeps the
 * browser's own behaviour, so a rep can still open a month in a new tab.
 */
function MonthTile({
  month,
  href,
  selected,
  onSelect,
}: {
  month: RepTargetsMonth;
  href: string;
  selected: boolean;
  onSelect: (period: string) => void;
}) {
  return (
    <Link
      href={href}
      aria-current={selected ? "page" : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        onSelect(month.period);
      }}
      className={cn(
        "flex min-w-0 flex-col border bg-white p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-orange-500",
        selected
          ? "border-orange-500 bg-orange-50/40 shadow-[inset_0_0_0_1px_#F97316]"
          : "border-slate-200 hover:border-orange-300 hover:bg-orange-50/40",
      )}
    >
      <span className="flex flex-wrap items-center justify-between gap-1.5">
        <span className="whitespace-nowrap text-sm font-black text-slate-900">{formatPeriod(month.period)}</span>
        <StatusChip status={month.status} />
      </span>
      <span className={cn(LABEL_CLASS, "mt-2.5 block")}>Target</span>
      <span className="block whitespace-nowrap text-base font-black tabular-nums text-sky-600">
        {month.hasTarget ? formatEgp(month.targetValue) : "—"}
      </span>
      {month.status === "published" ? (
        <span className="mt-2 block">
          <AchievementMeter value={month.achievementValue} align="left" />
          <span className="mt-1 block text-phx-xs tabular-nums text-slate-500">
            {`Sales ${formatEgp(month.actualValue ?? 0)}`}
          </span>
        </span>
      ) : (
        <span className="mt-2 block text-phx-xs leading-4 text-slate-500">{STATUS_HINT[month.status]}</span>
      )}
    </Link>
  );
}

export function RepTargetsView({
  data,
  basePath = "/employee-portals/targets",
  salesVsTargetHref = "/employee-portals/sales-vs-target",
}: RepTargetsViewProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const published = data.status === "published";
  const monthLong = formatMonthLong(data.period);
  const { totals } = data;
  const hasTarget = totals.targetedProducts > 0;

  const hrefFor = (period: string) => `${basePath}?period=${encodeURIComponent(period)}`;

  function navigate(period: string) {
    if (period === data.period) return;
    startTransition(() => router.push(hrefFor(period)));
  }

  const subtitle = [data.lineNames.join(" · "), data.areaNames.join(", "), monthLong]
    .filter((part) => part.length > 0)
    .join(" · ");

  const targetStat = (
    <BandStat
      label="Target"
      tone="sky"
      value={hasTarget ? <CountUpNumber value={totals.targetValue} format={formatEgp} /> : "—"}
      note={hasTarget ? plural(totals.targetedProducts, "product with a target", "products with a target") : "no target loaded"}
    />
  );

  let stats: React.ReactNode = null;
  if (!data.isEmptyScope) {
    if (published) {
      stats = (
        <>
          {targetStat}
          <BandStat
            label="Sales"
            value={<CountUpNumber value={totals.actualValue ?? 0} format={formatEgp} />}
            note="from the published Monthly Closing"
          />
          {totals.gapValue != null ? (
            totals.gapValue < 0 ? (
              <BandStat
                label="Short of target"
                tone="amber"
                value={<CountUpNumber value={-totals.gapValue} format={formatEgp} />}
                note="still to reach 100%"
              />
            ) : (
              <BandStat
                label="Above target"
                value={<CountUpNumber value={totals.gapValue} format={formatEgp} />}
                note="past 100%"
              />
            )
          ) : null}
        </>
      );
    } else {
      stats = (
        <>
          {targetStat}
          {data.status === "in_progress" && data.daysLeft != null ? (
            <BandStat
              label="Days left"
              value={<CountUpNumber value={data.daysLeft} format={formatNumber} />}
              note="this month, today included"
            />
          ) : null}
          {data.status === "awaiting_closing" ? (
            <BandStat label="Sales" value="—" note="awaiting the Monthly Closing" />
          ) : null}
        </>
      );
    }
  }

  const ring =
    published && hasTarget ? (
      <AchievementRing value={totals.achievementValue} size={150} stroke={13} label="Achievement" premium />
    ) : undefined;

  const aside =
    published && hasTarget && totals.productsAtTarget != null ? (
      <div className="border-l border-slate-100 pl-6">
        <p className={LABEL_CLASS}>At target</p>
        <p className="mt-1 whitespace-nowrap text-2xl font-black tabular-nums text-slate-900">
          {`${formatNumber(totals.productsAtTarget)} of ${formatNumber(totals.targetedProducts)}`}
        </p>
        <p className="mt-1 max-w-[13rem] text-phx-xs leading-4 text-slate-500">
          of your targeted products reached 100% or more
        </p>
      </div>
    ) : undefined;

  const footer =
    data.months.length > 1 ? (
      <BandChoice
        label="Month"
        options={data.months.map((month) => ({ value: month.period, label: formatPeriod(month.period) }))}
        selected={data.period}
        onSelect={navigate}
      />
    ) : undefined;

  return (
    <div className={cn("space-y-4 p-3 transition-opacity sm:p-4", isPending ? "opacity-60" : undefined)} aria-busy={isPending}>
      <CommandBand
        surface="portal"
        kicker="Field Performance · Your targets"
        title="Targets"
        subtitle={data.isEmptyScope ? "No areas are assigned to you yet" : subtitle}
        stats={stats}
        ring={ring}
        aside={aside}
        footer={footer}
        besideFrom="xl"
      />

      {data.isEmptyScope ? (
        <div className={cn(SURFACE_CLASS, "px-4 py-12 text-center")}>
          <p className="text-sm font-bold text-slate-900">No targets are assigned to you yet.</p>
          <p className="mx-auto mt-1.5 max-w-xl text-xs leading-5 text-slate-500">
            Your targets appear here once an area is assigned to you and its targets are loaded. If an area should
            already be yours, raise it with your District Manager.
          </p>
        </div>
      ) : (
        <>
          {data.status === "in_progress" && hasTarget ? (
            <Notice tone="orange" icon={CalendarClock} title={`${monthLong} is in progress.`}>
              Your sales are measured against this target once the Monthly Closing for this month is published. A
              closing is never released during the month it covers, so your achievement appears here after the month
              ends.
            </Notice>
          ) : null}

          {data.status === "awaiting_closing" ? (
            <Notice tone="amber" icon={AlertTriangle} title={`Monthly Closing for ${monthLong} has not been published yet.`}>
              This is not a zero. Sales for this month are not final until reconciled and published, so there is
              nothing to measure against target yet.
            </Notice>
          ) : null}

          {data.status === "upcoming" ? (
            <Notice tone="sky" icon={Info} title={`${monthLong} has not started yet.`}>
              This target is loaded ahead of the month so you can plan for it. It is measured once the Monthly Closing
              for that month is published.
            </Notice>
          ) : null}

          {published && !hasTarget ? (
            <Notice tone="sky" icon={Info} title={`No target was loaded for you in ${monthLong}.`}>
              Your published sales for the month are listed below, but a month without a target is not graded, so
              there is no achievement to show.
            </Notice>
          ) : null}

          {published && totals.achievementValue != null && totals.noTargetSalesValue !== 0 ? (
            <Notice
              tone="amber"
              icon={AlertTriangle}
              title={`${formatEgpFull(totals.noTargetSalesValue)} of your sales this month has no target behind it.`}
            >
              It still counts toward your achievement — every pound sold in a month you carry a target counts, exactly
              as the Monthly Closing counts it.
            </Notice>
          ) : null}

          <ProductsSection
            data={data}
            monthLong={monthLong}
            salesVsTargetHref={salesVsTargetHref}
          />

          {data.months.length > 0 ? (
            <SectionCard
              title="Month by month"
              subtitle="Your target each month, and your achievement once its closing is published"
              icon={CalendarRange}
            >
              <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                {data.months.map((month) => (
                  <MonthTile
                    key={month.period}
                    month={month}
                    href={hrefFor(month.period)}
                    selected={month.period === data.period}
                    onSelect={navigate}
                  />
                ))}
              </div>
            </SectionCard>
          ) : null}
        </>
      )}
    </div>
  );
}

function ProductsSection({
  data,
  monthLong,
  salesVsTargetHref,
}: {
  data: RepTargetsData;
  monthLong: string;
  salesVsTargetHref: string;
}) {
  const published = data.status === "published";
  const { totals } = data;

  const actions = published ? (
    <Link href={`${salesVsTargetHref}?period=${encodeURIComponent(data.period)}`} className={OUTLINE_ACTION_CLASS}>
      Your bricks in Sales vs Target
      <ArrowRight className="h-3.5 w-3.5" />
    </Link>
  ) : undefined;

  if (data.products.length === 0) {
    return (
      <SectionCard title="Your products" subtitle={monthLong} icon={Package} actions={actions}>
        <div className="px-4 py-10 text-center">
          <p className="text-sm font-bold text-slate-900">{`No target is loaded for ${monthLong} yet.`}</p>
          <p className="mx-auto mt-1.5 max-w-xl text-xs leading-5 text-slate-500">
            Targets are loaded a quarter at a time. This page fills in on its own as soon as yours arrive.
          </p>
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Your products"
      subtitle={
        published
          ? `${monthLong} · your target and published sales for each product`
          : `${monthLong} · your target for each product`
      }
      icon={Package}
      actions={actions}
    >
      {/* Phone: one card per product. Units and value sit side by side because they belong to ONE
          product; nothing on a card adds units across products. */}
      <div className="space-y-2 p-3 md:hidden">
        {data.products.map((product) => (
          <div className="flex border border-slate-200 bg-white" key={product.key}>
            <span
              className="w-1 shrink-0"
              style={{ backgroundColor: published ? achievementHex(product.achievementValue) : TARGET_COLOR }}
              aria-hidden
            />
            <div className="min-w-0 flex-1 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-black text-slate-900">{product.productName}</p>
                  {product.hasTarget ? (
                    <>
                      <p className="text-phx-xs text-slate-500">{`${formatPct(product.targetShare)} of your target`}</p>
                      <div className="mt-1.5 max-w-[10rem]">
                        <ProportionBar fraction={product.targetShare ?? 0} color={TARGET_COLOR} />
                      </div>
                    </>
                  ) : (
                    <p className="text-phx-xs font-semibold text-amber-700">No target this month</p>
                  )}
                </div>
                {published && product.hasTarget ? (
                  <div className="w-24 shrink-0">
                    <AchievementMeter value={product.achievementValue} />
                  </div>
                ) : null}
              </div>

              <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-slate-100 pt-2.5 text-phx-xs">
                <div className={CARD_FACT_CLASS}>
                  <dt className="text-slate-500">Target units</dt>
                  <dd className="whitespace-nowrap tabular-nums text-slate-700">
                    {product.targetUnits == null ? "—" : formatNumber(product.targetUnits)}
                  </dd>
                </div>
                <div className={CARD_FACT_CLASS}>
                  <dt className="text-slate-500">Target value</dt>
                  <dd className="whitespace-nowrap font-black tabular-nums text-sky-600">
                    {product.targetValue == null ? "—" : formatEgp(product.targetValue)}
                  </dd>
                </div>
                {published ? (
                  <>
                    <div className={CARD_FACT_CLASS}>
                      <dt className="text-slate-500">Sold units</dt>
                      <dd className="whitespace-nowrap tabular-nums text-slate-700">
                        {product.actualUnits == null ? "—" : formatNumber(product.actualUnits)}
                      </dd>
                    </div>
                    <div className={CARD_FACT_CLASS}>
                      <dt className="text-slate-500">Sales value</dt>
                      <dd className="whitespace-nowrap font-black tabular-nums text-slate-900">
                        {product.actualValue == null ? "—" : formatEgp(product.actualValue)}
                      </dd>
                    </div>
                  </>
                ) : null}
              </dl>

              {published && product.gapValue != null ? (
                <p className="mt-2 border-t border-slate-100 pt-2 text-phx-xs">
                  <GapText product={product} />
                </p>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      {/* Desktop. `table-fixed` with an explicit colgroup and no min-width: the page fits its screen
          by MERGING — each money cell carries its units beneath it — never by scrolling sideways.
          The footer totals VALUE only; a units total across products would add unlike things. */}
      <div className="hidden md:block">
        <table className="w-full table-fixed border-collapse text-sm" data-portal-desktop-table>
          {published ? (
            <colgroup>
              <col style={{ width: "30%" }} />
              <col style={{ width: "17%" }} />
              <col style={{ width: "17%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "20%" }} />
            </colgroup>
          ) : (
            <colgroup>
              <col style={{ width: "50%" }} />
              <col style={{ width: "22%" }} />
              <col style={{ width: "28%" }} />
            </colgroup>
          )}
          <thead>
            <tr className={`text-left ${TABLE_HEAD_CLASS}`}>
              <th className="px-4 py-2.5">Product</th>
              {published ? (
                <>
                  <th className="px-3 py-2.5 text-right">Target</th>
                  <th className="px-3 py-2.5 text-right">Sales</th>
                  <th className="px-3 py-2.5 text-right">Gap</th>
                  <th className="px-4 py-2.5 text-right">Achievement</th>
                </>
              ) : (
                <>
                  <th className="px-3 py-2.5 text-right">Target units</th>
                  <th className="px-4 py-2.5 text-right">Target value</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {data.products.map((product) => (
              <tr className={TABLE_ROW_CLASS} key={product.key}>
                <td className="px-4 py-3 align-top">
                  <p className="break-words font-bold text-slate-900">{product.productName}</p>
                  {product.hasTarget ? (
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="block w-24 shrink-0">
                        <ProportionBar fraction={product.targetShare ?? 0} color={TARGET_COLOR} />
                      </span>
                      <span className="min-w-0 text-phx-xs text-slate-500">{`${formatPct(product.targetShare)} of your target`}</span>
                    </div>
                  ) : (
                    <p className="text-phx-xs font-semibold text-amber-700">No target this month</p>
                  )}
                </td>
                {published ? (
                  <>
                    <td className="px-3 py-3 text-right align-top tabular-nums">
                      <p className="font-bold text-sky-600">{product.targetValue == null ? "—" : formatEgpFull(product.targetValue)}</p>
                      {product.targetUnits != null ? (
                        <p className="text-phx-xs text-slate-500">{unitsLabel(product.targetUnits)}</p>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-right align-top tabular-nums">
                      <p className="font-bold text-slate-900">{product.actualValue == null ? "—" : formatEgpFull(product.actualValue)}</p>
                      {product.actualUnits != null ? (
                        <p className="text-phx-xs text-slate-500">{unitsLabel(product.actualUnits)}</p>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-right align-top tabular-nums">
                      <GapText product={product} />
                    </td>
                    <td className="px-4 py-3 align-top">
                      <AchievementMeter value={product.achievementValue} />
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-3 py-3 text-right align-top tabular-nums text-slate-700">
                      {product.targetUnits == null ? "—" : formatNumber(product.targetUnits)}
                    </td>
                    <td className="px-4 py-3 text-right align-top font-bold tabular-nums text-sky-600">
                      {product.targetValue == null ? "—" : formatEgpFull(product.targetValue)}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-200 bg-slate-50/70">
              <td className="px-4 py-3 align-top">
                <p className="font-black text-slate-900">All products</p>
                <p className="text-phx-xs text-slate-500">in value — units differ from product to product</p>
              </td>
              {published ? (
                <>
                  <td className="px-3 py-3 text-right align-top font-black tabular-nums text-sky-600">
                    {formatEgpFull(totals.targetValue)}
                  </td>
                  <td className="px-3 py-3 text-right align-top font-black tabular-nums text-slate-900">
                    {formatEgpFull(totals.actualValue ?? 0)}
                  </td>
                  <td className="px-3 py-3 text-right align-top tabular-nums">
                    {totals.gapValue == null ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <span className={cn("font-black", achievementTone(totals.achievementValue))}>
                        {totals.gapValue === 0
                          ? "On target"
                          : `${totals.gapValue < 0 ? "Short by" : "Above by"} ${formatEgp(Math.abs(totals.gapValue))}`}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <AchievementMeter value={totals.achievementValue} />
                  </td>
                </>
              ) : (
                <>
                  <td className="px-3 py-3" />
                  <td className="px-4 py-3 text-right align-top font-black tabular-nums text-sky-600">
                    {formatEgpFull(totals.targetValue)}
                  </td>
                </>
              )}
            </tr>
          </tfoot>
        </table>
      </div>
    </SectionCard>
  );
}
