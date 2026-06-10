"use client";

import { useParams } from "next/navigation";
import { AuthGate } from "@/components/auth-gate";
import { RunDetail } from "@/components/run-detail";

export default function RunPage() {
  const params = useParams<{ id: string }>();
  return (
    <AuthGate>
      <RunDetail runId={params.id} />
    </AuthGate>
  );
}
