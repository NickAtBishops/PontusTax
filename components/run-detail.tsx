"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  collection,
  doc,
  documentId,
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";
import {
  ArrowLeft,
  Download,
  ExternalLink,
  OctagonX,
  RotateCcw,
  TerminalSquare,
} from "lucide-react";
import { toast } from "sonner";
import { db } from "@/lib/firebase";
import { readError } from "@/lib/api";
import {
  COLLECTIONS,
  type AccountRecord,
  type RowDoc,
  type RunDoc,
} from "@/lib/types";
import { fmtDateTime, fmtMoney } from "@/lib/format";
import { AppShell } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { StatCard } from "@/components/stat-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function RunDetail({ runId }: { runId: string }) {
  const [run, setRun] = useState<RunDoc | null | undefined>(undefined);
  const [rows, setRows] = useState<RowDoc[]>([]);
  const [selected, setSelected] = useState<RowDoc | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const unsubRun = onSnapshot(
      doc(db, COLLECTIONS.runs, runId),
      (snap) =>
        setRun(snap.exists() ? ({ ...(snap.data() as RunDoc), id: snap.id }) : null),
    );
    // Row keys are zero-padded (`s00_r0003`) so documentId order == sheet/row order.
    const unsubRows = onSnapshot(
      query(
        collection(db, COLLECTIONS.runs, runId, "rows"),
        orderBy(documentId()),
      ),
      (snap) =>
        setRows(snap.docs.map((d) => ({ ...(d.data() as RowDoc), id: d.id }))),
    );
    return () => {
      unsubRun();
      unsubRows();
    };
  }, [runId]);

  const totals = run?.totals;
  const progress =
    totals && totals.rows > 0 ? (totals.processed / totals.rows) * 100 : 0;
  const open =
    (totals?.unpaid ?? 0) + (totals?.partial ?? 0) + (totals?.delinquent ?? 0);
  const isActive = ["queued", "running", "writing_back"].includes(
    run?.status ?? "",
  );
  const isTerminal = ["done", "done_with_errors", "failed", "canceled"].includes(
    run?.status ?? "",
  );

  const owedNow = useMemo(
    () =>
      rows
        .flatMap((r) => r.accounts ?? [])
        .reduce((sum, a) => sum + (a.amount_due ?? 0), 0),
    [rows],
  );

  async function act(path: string, label: string) {
    setBusy(path);
    try {
      const res = await fetch(path, { method: "POST" });
      if (!res.ok) toast.error(await readError(res));
      else toast.success(label);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  async function download() {
    setBusy("download");
    try {
      const res = await fetch(`/api/runs/${runId}/download`);
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      const { url } = await res.json();
      window.open(url, "_blank");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Download failed");
    } finally {
      setBusy(null);
    }
  }

  if (run === null) {
    return (
      <AppShell title="Run not found">
        <BackLink />
        <p className="text-sm text-muted-foreground">
          This run doesn’t exist (or was deleted).
        </p>
      </AppShell>
    );
  }

  return (
    <AppShell
      title={run?.file_name ?? "Loading…"}
      actions={
        <>
          {isActive && run?.status !== "queued" && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null || run?.cancel_requested}
              onClick={() => act(`/api/runs/${runId}/cancel`, "Cancel requested")}
            >
              <OctagonX className="h-4 w-4" />
              {run?.cancel_requested ? "Canceling…" : "Cancel"}
            </Button>
          )}
          {isTerminal && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => act(`/api/runs/${runId}/retry`, "Retry queued")}
            >
              <RotateCcw className="h-4 w-4" />
              Retry failed rows
            </Button>
          )}
          {run?.output_path && (
            <Button size="sm" disabled={busy !== null} onClick={download}>
              <Download className="h-4 w-4" />
              Download checked workbook
            </Button>
          )}
        </>
      }
    >
      <BackLink />

      {run?.trigger_error && run.status === "queued" && (
        <Alert>
          <TerminalSquare className="h-4 w-4" />
          <AlertTitle>Queued — worker not auto-started</AlertTitle>
          <AlertDescription className="font-mono text-xs">
            {run.trigger_error}
          </AlertDescription>
        </Alert>
      )}
      {run?.error && (
        <Alert variant="destructive">
          <AlertTitle>Run error</AlertTitle>
          <AlertDescription>{run.error}</AlertDescription>
        </Alert>
      )}

      <Card className="gap-4 p-5 shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <StatusBadge status={run?.status} />
            <span className="text-sm text-muted-foreground">
              started {fmtDateTime(run?.started_at ?? run?.created_at)}
              {run?.finished_at ? ` · finished ${fmtDateTime(run.finished_at)}` : ""}
            </span>
          </div>
          <span className="font-mono text-sm tabular-nums text-muted-foreground">
            {totals?.processed ?? 0} / {totals?.rows ?? "—"} rows checked
          </span>
        </div>
        <Progress value={progress} className="h-1.5" />
      </Card>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Left to pay"
          value={fmtMoney(totals?.amount_due ?? owedNow)}
          valueClassName={
            (totals?.amount_due ?? owedNow) > 0
              ? "text-red-600"
              : "text-emerald-600"
          }
          sub={
            open > 0
              ? `${open} ${open === 1 ? "property owes" : "properties owe"} money`
              : "nothing owed in checked rows"
          }
        />
        <StatCard label="Paid" value={totals?.paid ?? 0} />
        <StatCard label="Needs review" value={totals?.needs_review ?? 0} />
        <StatCard label="Unreachable" value={totals?.unreachable ?? 0} />
      </div>

      <OutstandingCard rows={rows} onSelect={setSelected} />

      <RowsTable rows={rows} onSelect={setSelected} />

      {run?.sheets && run.sheets.length > 0 && <MappingCard run={run} />}
      {run?.summary && <SummaryCard run={run} />}

      <RowSheet row={selected} onClose={() => setSelected(null)} />
    </AppShell>
  );
}

function BackLink() {
  return (
    <Link
      href="/"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      All runs
    </Link>
  );
}

function OutstandingCard({
  rows,
  onSelect,
}: {
  rows: RowDoc[];
  onSelect: (r: RowDoc) => void;
}) {
  const owed = rows
    .map((row) => ({
      row,
      due: (row.accounts ?? []).reduce((s, a) => s + (a.amount_due ?? 0), 0),
    }))
    .filter((x) => x.due > 0.005)
    .sort((a, b) => b.due - a.due);
  const total = owed.reduce((s, x) => s + x.due, 0);

  return (
    <Card className="gap-0 overflow-hidden border-red-200 p-0 shadow-none">
      <div className="border-b border-red-200 bg-red-50/60 px-5 py-3.5">
        <h2 className="text-sm font-semibold text-red-900">
          Outstanding balances — left to pay
        </h2>
        <p className="text-xs text-red-700/80">
          Live amounts owed right now (incl. penalties/interest) as shown by
          each county portal.
        </p>
      </div>
      {owed.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted-foreground">
          No outstanding balances in the rows checked so far.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Address</TableHead>
              <TableHead>County</TableHead>
              <TableHead>Account</TableHead>
              <TableHead className="text-right">Year</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Amount due</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {owed.map(({ row, due }) => (
              <TableRow
                key={row.id}
                className="cursor-pointer"
                onClick={() => onSelect(row)}
              >
                <TableCell className="max-w-56">
                  <span className="block truncate font-medium">
                    {row.input?.address ?? "—"}
                  </span>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {row.input?.county ?? "—"}
                </TableCell>
                <TableCell className="max-w-36">
                  <span className="block truncate font-mono text-xs tabular-nums">
                    {row.input?.accounts?.join(", ") || "—"}
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {row.input?.tax_year ?? "—"}
                </TableCell>
                <TableCell>
                  <StatusBadge status={row.row_status ?? row.state} />
                </TableCell>
                <TableCell className="text-right font-mono text-sm font-semibold tabular-nums text-red-600">
                  {fmtMoney(due)}
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="bg-red-50/40 hover:bg-red-50/40">
              <TableCell colSpan={5} className="text-sm font-semibold">
                Total still owed
              </TableCell>
              <TableCell className="text-right font-mono text-base font-bold tabular-nums text-red-700">
                {fmtMoney(total)}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

function rowAmount(row: RowDoc): string {
  const accounts = row.accounts ?? [];
  if (accounts.length === 0) return "—";
  if (row.row_status === "PAID") return fmtMoney(0);
  const due = accounts.reduce((s, a) => s + (a.amount_due ?? 0), 0);
  return due > 0 ? fmtMoney(due) : "—";
}

function RowsTable({
  rows,
  onSelect,
}: {
  rows: RowDoc[];
  onSelect: (r: RowDoc) => void;
}) {
  return (
    <Card className="gap-0 overflow-hidden p-0 shadow-none">
      <div className="border-b px-5 py-3.5">
        <h2 className="text-sm font-semibold">Properties</h2>
      </div>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-12 text-right">Row</TableHead>
            <TableHead>Address</TableHead>
            <TableHead>County</TableHead>
            <TableHead>Account</TableHead>
            <TableHead className="text-right">Year</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Left to pay</TableHead>
            <TableHead className="text-right">Conf.</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={8}
                className="py-8 text-center text-sm text-muted-foreground"
              >
                Rows appear here as soon as the worker reads the workbook.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow
                key={row.id}
                className="cursor-pointer"
                onClick={() => onSelect(row)}
              >
                <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {row.row_number}
                </TableCell>
                <TableCell className="max-w-56">
                  <span className="block truncate font-medium">
                    {row.input?.address ?? "—"}
                  </span>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {row.input?.county ?? "—"}
                </TableCell>
                <TableCell className="max-w-36">
                  <span className="block truncate font-mono text-xs tabular-nums">
                    {row.input?.accounts?.join(", ") || "—"}
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {row.input?.tax_year ?? "—"}
                </TableCell>
                <TableCell>
                  <StatusBadge status={row.row_status ?? row.state} />
                </TableCell>
                <TableCell className="text-right font-mono text-sm tabular-nums">
                  {rowAmount(row)}
                </TableCell>
                <TableCell className="text-right text-xs text-muted-foreground">
                  {row.confidence ? row.confidence[0] : "—"}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      <p className="text-sm break-words">{value ?? "—"}</p>
    </div>
  );
}

function AccountBlock({ acc }: { acc: AccountRecord }) {
  const due = acc.status === "PAID" ? 0 : acc.amount_due;
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-3.5">
      <div className="min-w-0 space-y-1">
        <p className="truncate font-mono text-sm font-medium tabular-nums">
          {acc.account_searched}
        </p>
        {acc.source_url && (
          <a
            href={acc.source_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            Portal page <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      <div className="flex items-center gap-3 text-right">
        <StatusBadge status={acc.status} />
        <p
          className={`font-mono text-lg font-semibold tabular-nums ${
            due === null || due === undefined
              ? "text-muted-foreground"
              : due > 0
                ? "text-red-600"
                : "text-emerald-600"
          }`}
        >
          {fmtMoney(due)}
        </p>
      </div>
    </div>
  );
}

function RowSheet({
  row,
  onClose,
}: {
  row: RowDoc | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={row !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-xl">
        {row && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2.5">
                <span className="truncate">{row.input?.address ?? row.id}</span>
                <StatusBadge status={row.row_status ?? row.state} />
              </SheetTitle>
              <SheetDescription>
                {row.sheet_name} · row {row.row_number}
                {row.input?.county ? ` · ${row.input.county} County` : ""}
                {row.input?.state ? `, ${row.input.state}` : ""}
              </SheetDescription>
            </SheetHeader>
            <ScrollArea className="h-[calc(100vh-7rem)] px-4">
              <div className="space-y-5 pb-10">
                {row.status_note && (
                  <p className="rounded-lg border bg-accent/50 p-3 text-sm font-medium">
                    {row.status_note}
                  </p>
                )}
                {row.needs_review_reason && (
                  <Alert>
                    <AlertTitle>Why review is needed</AlertTitle>
                    <AlertDescription>
                      {row.needs_review_reason}
                    </AlertDescription>
                  </Alert>
                )}

                <div>
                  <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    From the spreadsheet
                  </h3>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Owner entity" value={row.input?.owner_entity} />
                    <Field label="Internal ID" value={row.input?.internal_id} />
                    <Field
                      label="Accounts"
                      value={
                        <span className="font-mono text-xs tabular-nums">
                          {row.input?.accounts?.join(", ") || "—"}
                        </span>
                      }
                    />
                    <Field label="Tax year" value={row.input?.tax_year} />
                    <Field
                      label="Responsible party"
                      value={row.input?.responsible_party}
                    />
                    <Field
                      label="Portal URL"
                      value={
                        row.input?.url ? (
                          <a
                            href={row.input.url}
                            target="_blank"
                            rel="noreferrer"
                            className="break-all text-primary hover:underline"
                          >
                            {row.input.url}
                          </a>
                        ) : (
                          "— (portal discovered by search)"
                        )
                      }
                    />
                  </div>
                </div>

                <Separator />

                <div className="space-y-3">
                  <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    What the portal showed
                  </h3>
                  {(row.accounts ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Not checked yet.
                    </p>
                  ) : (
                    row.accounts.map((acc, i) => (
                      <AccountBlock key={`${acc.account_searched}-${i}`} acc={acc} />
                    ))
                  )}
                </div>

                {row.skyvern && row.skyvern.recording_urls.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                      Browser recordings
                    </h3>
                    <div className="space-y-1">
                      {row.skyvern.recording_urls.map((u, i) => (
                        <a
                          key={u}
                          href={u}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          Recording {i + 1} <ExternalLink className="h-3 w-3" />
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function MappingCard({ run }: { run: RunDoc }) {
  return (
    <Card className="gap-0 overflow-hidden p-0 shadow-none">
      <div className="border-b px-5 py-3.5">
        <h2 className="text-sm font-semibold">Column mapping (audit)</h2>
        <p className="text-xs text-muted-foreground">
          How the workbook’s headers were interpreted. Formula columns are
          protected and never overwritten.
        </p>
      </div>
      <div className="space-y-4 p-5">
        {run.sheets!.map((sheet) => (
          <div key={sheet.name} className="space-y-2">
            <p className="text-sm font-medium">
              {sheet.name}
              <span className="ml-2 font-mono text-xs tabular-nums text-muted-foreground">
                header row {sheet.header_row} · {sheet.data_row_count} data rows
              </span>
            </p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(sheet.mapping).map(([field, col]) => (
                <span
                  key={field}
                  className="inline-flex items-center gap-1.5 rounded-md border bg-accent/40 px-2 py-1 text-xs"
                >
                  <span className="text-muted-foreground">{field}</span>
                  <span className="font-mono font-medium tabular-nums">{col}</span>
                </span>
              ))}
            </div>
            {sheet.protected_columns.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Protected (formulas):{" "}
                <span className="font-mono tabular-nums">
                  {sheet.protected_columns.join(", ")}
                </span>
              </p>
            )}
            {sheet.ambiguous.length > 0 && (
              <p className="text-xs text-amber-700">
                Ambiguous: {sheet.ambiguous.join("; ")}
              </p>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function SummaryCard({ run }: { run: RunDoc }) {
  const s = run.summary!;
  return (
    <Card className="gap-0 overflow-hidden p-0 shadow-none">
      <div className="border-b px-5 py-3.5">
        <h2 className="text-sm font-semibold">Run summary</h2>
      </div>
      <div className="space-y-4 p-5 text-sm">
        <div className="flex flex-wrap gap-2">
          {Object.entries(s.status_counts).map(([status, count]) => (
            <span key={status} className="inline-flex items-center gap-1.5">
              <StatusBadge status={status} />
              <span className="font-mono text-sm tabular-nums">{count}</span>
            </span>
          ))}
        </div>
        {s.status_column_header && (
          <p className="text-muted-foreground">
            Columns added to the workbook:{" "}
            {s.amount_column_header && (
              <>
                <span className="font-medium text-foreground">
                  “{s.amount_column_header}”
                </span>{" "}
                and{" "}
              </>
            )}
            <span className="font-medium text-foreground">
              “{s.status_column_header}”
            </span>
          </p>
        )}
        {s.new_playbooks.length > 0 && (
          <div>
            <p className="mb-1 font-medium">New vendor playbooks learned</p>
            <ul className="list-inside list-disc text-muted-foreground">
              {s.new_playbooks.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}
        {s.review_rows.length > 0 && (
          <div>
            <p className="mb-1 font-medium">Rows needing human review</p>
            <ul className="space-y-1 text-muted-foreground">
              {s.review_rows.map((r, i) => (
                <li key={i}>
                  <span className="font-mono text-xs tabular-nums">
                    {r.sheet} · row {r.row}
                  </span>{" "}
                  — {r.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        {s.mapping_notes.length > 0 && (
          <div>
            <p className="mb-1 font-medium">Mapping notes</p>
            <ul className="list-inside list-disc text-muted-foreground">
              {s.mapping_notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </div>
        )}
        {s.notes.length > 0 && (
          <div>
            <p className="mb-1 font-medium">Notes</p>
            <ul className="list-inside list-disc text-muted-foreground">
              {s.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
