"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { COLLECTIONS, type RunDoc } from "@/lib/types";
import { fmtMoney, fmtRelative } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function RunsTable({
  onRuns,
}: {
  onRuns?: (runs: RunDoc[]) => void;
}) {
  const router = useRouter();
  const [runs, setRuns] = useState<RunDoc[] | null>(null);

  useEffect(() => {
    const q = query(
      collection(db, COLLECTIONS.runs),
      orderBy("created_at", "desc"),
      limit(50),
    );
    // onSnapshot pushes updates in real time — no polling.
    const unsub = onSnapshot(q, (snap) => {
      const docs = snap.docs.map(
        (d) => ({ ...(d.data() as RunDoc), id: d.id }),
      );
      setRuns(docs);
      onRuns?.(docs);
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card className="gap-0 overflow-hidden p-0 shadow-none">
      <div className="border-b px-5 py-3.5">
        <h2 className="text-sm font-semibold">Runs</h2>
      </div>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Workbook</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-44">Progress</TableHead>
            <TableHead className="text-right">Left to pay</TableHead>
            <TableHead className="text-right">Review</TableHead>
            <TableHead className="text-right">Started</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs === null ? (
            <TableRow>
              <TableCell
                colSpan={6}
                className="py-8 text-center text-sm text-muted-foreground"
              >
                Loading…
              </TableCell>
            </TableRow>
          ) : runs.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={6}
                className="py-8 text-center text-sm text-muted-foreground"
              >
                No runs yet — upload a tracker above.
              </TableCell>
            </TableRow>
          ) : (
            runs.map((run) => {
              const total = run.totals?.rows ?? 0;
              const processed = run.totals?.processed ?? 0;
              const review =
                (run.totals?.needs_review ?? 0) +
                (run.totals?.unreachable ?? 0);
              return (
                <TableRow
                  key={run.id}
                  className="cursor-pointer"
                  onClick={() => router.push(`/runs/${run.id}`)}
                >
                  <TableCell className="max-w-64">
                    <span className="block truncate font-medium">
                      {run.file_name}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={run.status} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Progress
                        value={total > 0 ? (processed / total) * 100 : 0}
                        className="h-1.5 w-20"
                      />
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">
                        {processed}/{total || "—"}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell
                    className={`text-right font-mono text-sm tabular-nums ${
                      (run.totals?.amount_due ?? 0) > 0
                        ? "font-semibold text-red-600"
                        : "text-muted-foreground"
                    }`}
                  >
                    {run.totals?.amount_due !== undefined
                      ? fmtMoney(run.totals.amount_due)
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">
                    {review > 0 ? review : "—"}
                  </TableCell>
                  <TableCell className="text-right text-sm whitespace-nowrap text-muted-foreground">
                    {fmtRelative(run.created_at)}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </Card>
  );
}
