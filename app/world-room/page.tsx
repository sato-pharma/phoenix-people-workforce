import type { Metadata } from "next";

import { WorldRoomClient } from "@/components/world-room/world-room-client";

export const metadata: Metadata = {
  title: "World Room | Realtime Audio Worldbuilding",
  description: "A realtime audio worldbuilding companion powered by OpenAI Realtime.",
};

export default function WorldRoomPage() {
  return <WorldRoomClient />;
}
