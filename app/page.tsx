"use client";

import { useState } from "react";
import { AuthGate } from "@/components/auth-gate";
import { AppShell } from "@/components/app-shell";
import { UploadCard } from "@/components/upload-card";
import { RunsTable } from "@/components/runs-table";
import { StatCard } from "@/components/stat-card";
import { fmtMoney } from "@/lib/format";
import type { RunDoc } from "@/lib/types";

export default function DashboardPage() {
  const [runs, setRuns] = useState<RunDoc[]>([]);

  const active = runs.filter((r) =>
    ["queued", "running", "writing_back"].includes(r.status),
  ).length;
  const latest = runs.find((r) =>
    ["done", "done_with_errors"].includes(r.status),
  );
  const latestReview = latest
    ? (latest.totals?.needs_review ?? 0) + (latest.totals?.unreachable ?? 0)
    : null;
  const latestDue = latest?.totals?.amount_due ?? null;

  return (
    <AuthGate>
      <AppShell title="Dashboard">
        <UploadCard />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard
            label="Left to pay"
            value={latestDue === null ? "—" : fmtMoney(latestDue)}
            valueClassName={
              latestDue !== null && latestDue > 0
                ? "text-red-600"
                : latestDue === 0
                  ? "text-emerald-600"
                  : undefined
            }
            sub={latest ? `last finished: ${latest.file_name}` : undefined}
          />
          <StatCard
            label="Needs review"
            value={latestReview ?? "—"}
            sub={latest ? "in last finished run" : undefined}
          />
          <StatCard label="Active now" value={active} />
          <StatCard label="Runs" value={runs.length} />
        </div>
        <RunsTable onRuns={setRuns} />
      </AppShell>
    </AuthGate>
  );
}
