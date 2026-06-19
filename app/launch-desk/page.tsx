import type { Metadata } from "next";

import { LaunchDeskClient } from "@/components/launch-desk/launch-desk-client";

export const metadata: Metadata = {
  title: "Launch Desk",
  description: "Turn a rough launch idea into an actionable release plan.",
};

export default function LaunchDeskPage() {
  return <LaunchDeskClient />;
}
