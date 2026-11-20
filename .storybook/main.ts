import type { StorybookConfig } from "@storybook/nextjs-vite";

/**
 * Storybook for the employee portal's parts (owner, 2026-11-20: "All six tools", for the portal
 * redesign). It shows the landing kit and the portal's shared page parts one by one, at any width,
 * without signing in and without a database — so a part can be judged on its own before a page uses
 * it. Stories carry sample words only, never a real employee's data.
 *
 * Run it on the spare laptop (the dev and test machine), never on the 16 GB one: `pnpm storybook`
 * serves http://localhost:6006, `pnpm build-storybook` writes a static copy.
 *
 * Storybook's own telemetry is off.
 */
const config: StorybookConfig = {
  stories: ["../src/components/employee-portal/**/*.stories.tsx"],
  addons: [],
  framework: {
    name: "@storybook/nextjs-vite",
    options: {},
  },
  core: {
    disableTelemetry: true,
  },
};

export default config;
