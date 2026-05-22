"use client";

import React from "react";
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from "recharts";
import { SafeResponsiveContainer } from "@/components/charts/safe-responsive-container";

export default function TeamPerformanceChart({
  teamRows,
  teamAchievement,
}: {
  teamRows: Array<{
    achievementPercent: number;
    name: string;
  }>;
  teamAchievement: number;
}) {
  return (
    <SafeResponsiveContainer className="h-72" minHeight={288}>
        <BarChart data={teamRows} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis type="number" />
          <YAxis type="category" dataKey="name" width={120} />
          <Tooltip />
          <Legend />
          <ReferenceLine y={teamAchievement} label={{ value: "Team Avg", position: "middle" }} stroke="#94a3b8" strokeDasharray="5 5" />
          <Bar dataKey="achievementPercent" fill="#f97316" radius={[4, 4, 0, 0]}>
            {teamRows.map((entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={
                  entry.achievementPercent >= 90
                    ? "#10b981"
                    : index === 0
                    ? "#f59e0b"
                    : entry.achievementPercent < teamAchievement * 0.8
                    ? "#ef4444"
                    : "#f97316"
                }
              />
            ))}
          </Bar>
        </BarChart>
    </SafeResponsiveContainer>
  );
}
