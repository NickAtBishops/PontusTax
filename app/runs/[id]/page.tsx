"use client";

import { useParams } from "next/navigation";
import { ConfigGate } from "@/components/config-gate";
import { RunDetail } from "@/components/run-detail";

export default function RunPage() {
  const params = useParams<{ id: string }>();
  return (
    <ConfigGate>
      <RunDetail runId={params.id} />
    </ConfigGate>
  );
}
