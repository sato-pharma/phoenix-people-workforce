import type { Preview } from "@storybook/nextjs-vite";

import "../app/globals.css";

/**
 * Every story stands on the portal's own ground, inside the `employee-portal-shell` class the
 * portal's CSS scopes to (it hides header sentences and zeroes every radius there), at the same
 * 16px phone gutter the portal keeps.
 */
const preview: Preview = {
  decorators: [
    (Story) => (
      <div className="employee-portal-shell min-h-screen bg-[#f8fafc] px-4 py-5 font-sans text-[#08111f]">
        <div className="mx-auto max-w-5xl space-y-5">
          <Story />
        </div>
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
  },
};

export default preview;
