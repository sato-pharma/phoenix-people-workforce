import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import {
  LandingBar,
  LandingCta,
  LandingEmpty,
  LandingFigure,
  LandingMeta,
  LandingNavyBoard,
  LandingNavyBoardLoading,
  LandingPanel,
  LandingPanelLoading,
  LandingRailLine,
  LandingRow,
  landingActionClassName,
  landingTone,
} from "./landing-kit";

/**
 * The landing kit, part by part. Sample words only — no story names a real employee or shows a
 * real figure (the redesign programme's rule: never expose production HR data).
 */
const meta: Meta = {
  title: "Portal/Landing kit",
};

export default meta;

type Story = StoryObj;

const SAMPLE_PCTS = [112, 96, 81, 54];

export const Panel: Story = {
  render: () => (
    <LandingPanel right={<LandingMeta items={["OCT 2026", "9 REPS"]} />} title="Sales vs target">
      <LandingRow label="Sales" value="1,240,500" />
      <LandingRow label="Target" value="1,300,000" />
      <LandingRow label="Achievement" tone={landingTone(95.4).text} value="95.4%" />
      <LandingRow label="A label long enough to wrap onto a second line on a small phone" sub="One quiet line under it" value="12 of 14" />
    </LandingPanel>
  ),
};

export const NavyBoard: Story = {
  render: () => (
    <LandingNavyBoard label="This month" right={<LandingMeta items={["OCT 2026"]} onNavy />}>
      <div className="grid grid-cols-2 gap-1.5">
        {SAMPLE_PCTS.map((pct, index) => (
          <div className="min-w-0 bg-[#0d1828] px-3 py-3" key={pct}>
            <p className="text-phx-xs font-bold uppercase tracking-[0.1em] text-white/55">Sample {index + 1}</p>
            <div className="mt-2">
              <LandingFigure onNavy tone={landingTone(pct).onNavyText} unit="%">
                {pct}
              </LandingFigure>
            </div>
            <div className="mt-2.5">
              <LandingBar onNavy pct={pct} />
            </div>
          </div>
        ))}
      </div>
    </LandingNavyBoard>
  ),
};

export const ToneScale: Story = {
  render: () => (
    <LandingPanel title="The one tone scale">
      <div className="space-y-4 px-3 py-4 sm:px-4">
        {SAMPLE_PCTS.map((pct) => (
          <div className="space-y-1.5" key={pct}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-phx-sm font-bold uppercase tracking-[0.08em] text-slate-500">Attainment</span>
              <span className={`text-phx-md font-bold tabular-nums ${landingTone(pct).text}`}>{pct}%</span>
            </div>
            <LandingBar pct={pct} />
          </div>
        ))}
      </div>
    </LandingPanel>
  ),
};

export const Actions: Story = {
  render: () => (
    <LandingPanel title="Actions">
      <div className="flex flex-wrap gap-2 px-3 py-4 sm:px-4">
        <LandingCta href="#">Open the report</LandingCta>
        <LandingCta href="#" variant="solid">
          Plan the week
        </LandingCta>
        <button className={landingActionClassName("outline")} type="button">
          A button in the same shape
        </button>
        <button className={landingActionClassName("solid")} disabled type="button">
          Disabled
        </button>
      </div>
    </LandingPanel>
  ),
};

export const StatesAndLoading: Story = {
  render: () => (
    <>
      <LandingPanel title="Rail lines">
        <LandingRailLine rail="bg-emerald-500">All clear: nothing waits on you today.</LandingRailLine>
        <LandingRailLine rail="bg-amber-400">Two requests are close to their deadline.</LandingRailLine>
        <LandingRailLine rail="bg-rose-500">The figures could not be read just now.</LandingRailLine>
      </LandingPanel>
      <LandingPanel title="Empty">
        <LandingEmpty>Nobody yet.</LandingEmpty>
      </LandingPanel>
      <LandingPanelLoading title="Loading panel" />
      <LandingNavyBoardLoading label="Loading board" />
    </>
  ),
};
