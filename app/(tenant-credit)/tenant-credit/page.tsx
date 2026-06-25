"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { unzipSync } from "fflate";

import { AppShell } from "@/components/app-shell";
import { ConfigGate } from "@/components/config-gate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import {
  ALL_QUARTER_IDS,
  METRIC_LABELS,
  WRITABLE_METRICS,
  quarterLabel,
  type MetricKey,
  type QuarterId,
} from "@/lib/tenant-credit/tracker-layout";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TenantPickerEntry = {
  display_name: string;
  row: number;
  tenant_id: string;
};

type ExtractResponse = {
  tenant_id: string;
  source_entity: string;
  source_period: string;
  line_items: { label: string; amount: number }[];
  normalization_applied: {
    raw_label: string;
    canonical_label: string;
    match_type: "case_or_whitespace" | "alias";
  }[];
  passed_through: string[];
};

type ComputeMetricTrace = {
  metric: MetricKey;
  formula: string;
  contributions: {
    label: string;
    amount_source: number;
    amount_tracker: number;
    reason: string;
  }[];
  total_tracker_unrounded: number;
  result_tracker: number | null;
};

type ComputeResponse = {
  sales: number | null;
  ebitda: number | null;
  interest: number | null;
  rent: number | null;
  cash: number | null;
  cfo: number | null;
  capex: number | null;
  metrics: Record<MetricKey, ComputeMetricTrace>;
  intercompany_observed: {
    income_label: string;
    expense_label: string;
    income_amount_source: number;
    expense_amount_source: number;
    amounts_match: boolean;
  }[];
  unused_labels: string[];
};

type TenantStatus =
  | "idle"           // no PDF yet
  | "loaded"         // PDF attached, not yet extracted
  | "extracting"     // /extract running
  | "computing"      // /compute running
  | "computed"       // extract + compute done
  | "error";

type TenantState = {
  tenant: TenantPickerEntry;
  pdf: File | null;
  pdfName: string | null;
  status: TenantStatus;
  extract: ExtractResponse | null;
  compute: ComputeResponse | null;
  error: string | null;
};

// Files dropped via the zip that didn't match any tenant by name.
type UnassignedPdf = {
  id: string;
  name: string;
  file: File;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Reduce a string to lowercase alphanumeric tokens for loose comparison.
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Score how well a PDF filename matches a tenant display name. Higher
// is better; 0 means no overlap. The score is the length of the
// longest tenant token (4+ chars) that appears in the filename, so
// "Pinnacle_Q1_2026.pdf" matches "Pinnacle Oil & Gas Holdings, Inc."
// via the shared token "pinnacle".
function matchScore(filename: string, tenantName: string): number {
  const fname = normalize(filename);
  const tenant = normalize(tenantName);
  if (!fname || !tenant) return 0;
  let best = 0;
  for (const token of tenant.split(/\s+/)) {
    if (token.length < 4) continue;
    if (fname.includes(token)) best = Math.max(best, token.length);
  }
  return best;
}

// Best-effort guess of which tenant a PDF belongs to. Returns the
// winning tenant + the runner-up so we can flag ambiguous matches.
function matchPdfToTenant(
  filename: string,
  tenants: TenantPickerEntry[],
): { winner: TenantPickerEntry | null; tied: boolean } {
  let bestScore = 0;
  let winner: TenantPickerEntry | null = null;
  let tied = false;
  for (const t of tenants) {
    const score = matchScore(filename, t.display_name);
    if (score === 0) continue;
    if (score > bestScore) {
      bestScore = score;
      winner = t;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }
  return { winner: tied ? null : winner, tied };
}

// Run an async task per item with bounded parallelism. Keeps the
// number of in-flight Claude calls under control when batching 24
// tenants.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function runOne() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => runOne(),
  );
  await Promise.all(workers);
  return results;
}

function guessQuarter(periodHint: string): QuarterId {
  const text = periodHint.toLowerCase();
  for (const id of ALL_QUARTER_IDS) {
    const [q, y] = id.split("_");
    const yy = y.slice(2);
    if (text.includes(`${q.toLowerCase()} ${y}`)) return id;
    if (text.includes(`${q.toLowerCase()} ${yy}`)) return id;
  }
  return "Q1_2026";
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TenantCreditPage() {
  const [trackerFile, setTrackerFile] = useState<File | null>(null);
  const [tenants, setTenants] = useState<TenantPickerEntry[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(false);
  const [quarterId, setQuarterId] = useState<QuarterId>("Q1_2026");
  // Keyed by tenant.row so writes never accidentally collide across
  // tenants who share a display-name prefix.
  const [states, setStates] = useState<Record<number, TenantState>>({});
  const [unassigned, setUnassigned] = useState<UnassignedPdf[]>([]);
  const [running, setRunning] = useState(false);
  const [writing, setWriting] = useState(false);

  const tenantsWithData = useMemo(
    () =>
      Object.values(states).filter(
        (s) => s.status === "computed" && s.compute !== null,
      ),
    [states],
  );

  // ----- Tracker upload --------------------------------------------------

  async function handleTrackerUpload(next: File | null) {
    setTrackerFile(next);
    setTenants([]);
    setStates({});
    setUnassigned([]);
    if (!next) return;
    if (!next.name.toLowerCase().endsWith(".xlsx")) {
      toast.error("Tracker must be an .xlsx file.");
      setTrackerFile(null);
      return;
    }
    setTenantsLoading(true);
    try {
      const form = new FormData();
      form.append("tracker_xlsx", next);
      const res = await fetch("/api/tenant-credit/tenants", {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(
          detail.error ?? `Tracker parse failed (${res.status}).`,
        );
      }
      const data = (await res.json()) as { tenants: TenantPickerEntry[] };
      setTenants(data.tenants);
      const seeded: Record<number, TenantState> = {};
      for (const t of data.tenants) {
        seeded[t.row] = {
          tenant: t,
          pdf: null,
          pdfName: null,
          status: "idle",
          extract: null,
          compute: null,
          error: null,
        };
      }
      setStates(seeded);
      toast.success(`Loaded ${data.tenants.length} tenants.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Tracker parse failed.");
      setTrackerFile(null);
    } finally {
      setTenantsLoading(false);
    }
  }

  // ----- Per-tenant PDF drop -------------------------------------------

  function assignPdfToTenant(row: number, file: File) {
    setStates((prev) => {
      const cur = prev[row];
      if (!cur) return prev;
      return {
        ...prev,
        [row]: {
          ...cur,
          pdf: file,
          pdfName: file.name,
          status: "loaded",
          extract: null,
          compute: null,
          error: null,
        },
      };
    });
  }

  function clearTenantPdf(row: number) {
    setStates((prev) => {
      const cur = prev[row];
      if (!cur) return prev;
      return {
        ...prev,
        [row]: {
          ...cur,
          pdf: null,
          pdfName: null,
          status: "idle",
          extract: null,
          compute: null,
          error: null,
        },
      };
    });
  }

  // ----- Zip handling ---------------------------------------------------

  async function handleZipUpload(zipFile: File | null) {
    if (!zipFile) return;
    if (!zipFile.name.toLowerCase().endsWith(".zip")) {
      toast.error("Bulk upload must be a .zip file.");
      return;
    }
    let entries: Record<string, Uint8Array>;
    try {
      const bytes = new Uint8Array(await zipFile.arrayBuffer());
      entries = unzipSync(bytes);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not unzip.");
      return;
    }
    let assigned = 0;
    const newUnassigned: UnassignedPdf[] = [];
    setStates((prev) => {
      const next = { ...prev };
      for (const [path, bytes] of Object.entries(entries)) {
        // unzipSync includes directory entries as zero-byte "names ending
        // in /". Skip them and non-PDFs.
        if (path.endsWith("/") || bytes.byteLength === 0) continue;
        if (!path.toLowerCase().endsWith(".pdf")) continue;
        // macOS adds hidden resource-fork entries to every zip it
        // creates: __MACOSX/<name>/._<filename> and plain ._<filename>
        // alongside the real PDF. They have a .pdf extension but their
        // bytes are AppleDouble metadata, not a PDF, and Anthropic
        // rejects them as "not a valid PDF". Skip them.
        const basename = path.split("/").pop() ?? path;
        if (path.startsWith("__MACOSX/") || basename.startsWith("._")) continue;
        // Magic-byte check: a real PDF starts with "%PDF". Anything
        // else is some other file with a .pdf extension. Drop it
        // rather than wasting a Claude call on it.
        if (
          bytes[0] !== 0x25 ||
          bytes[1] !== 0x50 ||
          bytes[2] !== 0x44 ||
          bytes[3] !== 0x46
        ) {
          continue;
        }
        const filename = basename;
        const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
        const file = new File([blob], filename, { type: "application/pdf" });
        const { winner, tied } = matchPdfToTenant(filename, tenants);
        if (winner && !tied && next[winner.row]) {
          next[winner.row] = {
            ...next[winner.row],
            pdf: file,
            pdfName: filename,
            status: "loaded",
            extract: null,
            compute: null,
            error: null,
          };
          assigned++;
        } else {
          newUnassigned.push({
            id: `${filename}-${Math.random().toString(36).slice(2, 8)}`,
            name: filename,
            file,
          });
        }
      }
      return next;
    });
    setUnassigned((cur) => [...cur, ...newUnassigned]);
    if (assigned > 0) toast.success(`Routed ${assigned} PDF${assigned === 1 ? "" : "s"} from the zip.`);
    if (newUnassigned.length > 0) {
      toast.warning(
        `${newUnassigned.length} PDF${newUnassigned.length === 1 ? "" : "s"} couldn't be matched; drag them to the right tenant.`,
      );
    }
  }

  function assignUnassigned(unassignedId: string, row: number) {
    const entry = unassigned.find((u) => u.id === unassignedId);
    if (!entry) return;
    assignPdfToTenant(row, entry.file);
    setUnassigned((cur) => cur.filter((u) => u.id !== unassignedId));
  }

  // ----- Batch extract + compute ---------------------------------------

  async function handleRunAll() {
    const ready = Object.values(states).filter(
      (s) => s.pdf !== null && s.status !== "computed",
    );
    if (ready.length === 0) {
      toast.info("Every tenant with a PDF is already computed.");
      return;
    }
    setRunning(true);
    try {
      await mapWithConcurrency(ready, 4, async (entry) => {
        const file = entry.pdf;
        if (!file) return;
        setStates((prev) => ({
          ...prev,
          [entry.tenant.row]: { ...prev[entry.tenant.row], status: "extracting", error: null },
        }));
        try {
          const form = new FormData();
          form.append("file", file);
          form.append("tenant_id", entry.tenant.tenant_id);
          const extractRes = await fetch("/api/tenant-credit/extract", {
            method: "POST",
            body: form,
          });
          if (!extractRes.ok) {
            const detail = await extractRes.json().catch(() => ({}));
            throw new Error(
              detail.error ?? `Extract failed (${extractRes.status}).`,
            );
          }
          const extractData = (await extractRes.json()) as ExtractResponse;

          setStates((prev) => ({
            ...prev,
            [entry.tenant.row]: { ...prev[entry.tenant.row], status: "computing" },
          }));
          const computeRes = await fetch("/api/tenant-credit/compute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tenant_id: entry.tenant.tenant_id,
              line_items: extractData.line_items,
            }),
          });
          if (!computeRes.ok) {
            const detail = await computeRes.json().catch(() => ({}));
            throw new Error(
              detail.error ?? `Compute failed (${computeRes.status}).`,
            );
          }
          const computeData = (await computeRes.json()) as ComputeResponse;

          // Update the global quarter picker once, based on the first
          // tenant's source period if it parses cleanly. Subsequent
          // tenants don't overwrite the analyst's manual choice.
          setQuarterId((cur) => {
            if (cur !== "Q1_2026") return cur;
            return guessQuarter(extractData.source_period);
          });

          setStates((prev) => ({
            ...prev,
            [entry.tenant.row]: {
              ...prev[entry.tenant.row],
              status: "computed",
              extract: extractData,
              compute: computeData,
              error: null,
            },
          }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Run failed.";
          setStates((prev) => ({
            ...prev,
            [entry.tenant.row]: { ...prev[entry.tenant.row], status: "error", error: msg },
          }));
          toast.error(`${entry.tenant.display_name}: ${msg}`);
        }
      });
      toast.success("Batch complete. Review the results table below.");
    } finally {
      setRunning(false);
    }
  }

  // ----- Batch writeback ------------------------------------------------

  async function handleWriteAll() {
    if (!trackerFile) {
      toast.error("Upload the tracker first.");
      return;
    }
    if (tenantsWithData.length === 0) {
      toast.error("No tenants have been computed yet.");
      return;
    }
    setWriting(true);
    try {
      const entries = await Promise.all(
        tenantsWithData.map(async (s) => {
          const c = s.compute!;
          const e = s.extract;
          const pdfHash = s.pdf ? await sha256Hex(s.pdf) : "";
          return {
            tenant_id: s.tenant.tenant_id,
            tenant_display_name: s.tenant.display_name,
            tracker_row: s.tenant.row,
            sales: c.sales,
            ebitda: c.ebitda,
            interest: c.interest,
            rent: c.rent,
            cash: c.cash,
            cfo: c.cfo,
            capex: c.capex,
            source_pdf_filename: s.pdfName ?? "",
            source_pdf_hash: pdfHash,
            source_entity: e?.source_entity ?? "",
            source_period: e?.source_period ?? "",
            line_items: e?.line_items ?? [],
            normalization_applied: e?.normalization_applied ?? [],
            passed_through: e?.passed_through ?? [],
            unused_labels: c.unused_labels,
            intercompany_observed: c.intercompany_observed,
            calculations: {
              sales: traceToAudit(c.metrics.sales),
              ebitda: traceToAudit(c.metrics.ebitda),
            },
          };
        }),
      );

      const form = new FormData();
      form.append("tracker_xlsx", trackerFile);
      form.append("payload", JSON.stringify({ quarter_id: quarterId, entries }));
      const res = await fetch("/api/tenant-credit/writeback", {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        if (Array.isArray(detail.failures)) {
          for (const f of detail.failures) {
            toast.error(`${f.tenant_display_name}: ${f.reasons.join("; ")}`);
          }
        }
        throw new Error(detail.error ?? `Writeback failed (${res.status}).`);
      }
      const warningsRaw = res.headers.get("X-Worker-Warnings");
      if (warningsRaw) {
        try {
          const list = JSON.parse(warningsRaw) as string[];
          for (const w of list) toast.warning(w);
        } catch {
          toast.warning(warningsRaw);
        }
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const cd = res.headers.get("Content-Disposition") ?? "";
      const match = cd.match(/filename="([^"]+)"/);
      a.download = match?.[1] ?? "tracker.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Downloaded ${a.download}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Writeback failed.");
    } finally {
      setWriting(false);
    }
  }

  // ----- Render --------------------------------------------------------

  const allTenants = Object.values(states).sort((a, b) => a.tenant.row - b.tenant.row);
  const readyCount = allTenants.filter((s) => s.status === "computed").length;
  const loadedCount = allTenants.filter((s) => s.pdf !== null).length;

  return (
    <ConfigGate>
      <AppShell title="Tenant Credit Tracker">
        <p className="text-sm text-muted-foreground">
          Upload the corporate financials tracker, then a PDF per tenant.
          Each PDF goes through Claude for line-item extraction and a
          generic compute rule for Sales, EBITDA, Interest, Rent, Cash,
          CFO, and Capex. Numbers land in the right cells when you click
          Write at the bottom.
        </p>

        <TrackerCard
          file={trackerFile}
          loading={tenantsLoading}
          tenantCount={tenants.length}
          onFileChange={handleTrackerUpload}
        />

        {tenants.length > 0 && (
          <>
            <QuarterAndZipCard
              quarterId={quarterId}
              onQuarterChange={setQuarterId}
              onZipUpload={handleZipUpload}
              loadedCount={loadedCount}
              totalCount={allTenants.length}
            />

            <TenantGrid
              tenants={allTenants}
              running={running}
              onAssign={assignPdfToTenant}
              onClear={clearTenantPdf}
            />

            {unassigned.length > 0 && (
              <UnassignedCard
                items={unassigned}
                tenants={tenants}
                onAssign={assignUnassigned}
              />
            )}

            <ActionsCard
              loadedCount={loadedCount}
              readyCount={readyCount}
              running={running}
              writing={writing}
              onRunAll={handleRunAll}
              onWriteAll={handleWriteAll}
              quarterLabel={quarterLabel(quarterId)}
            />

            {readyCount > 0 && <ResultsTable rows={tenantsWithData} />}
          </>
        )}
      </AppShell>
    </ConfigGate>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TrackerCard(props: {
  file: File | null;
  loading: boolean;
  tenantCount: number;
  onFileChange: (next: File | null) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Step 1 — Upload tracker</CardTitle>
        <CardDescription>
          Drop the latest{" "}
          <span className="font-mono">Corporate_Financials_and_P_Ls.xlsx</span>{" "}
          here. We read column A of the{" "}
          <span className="font-mono">Corp Financials</span> sheet to
          populate the tenant cards below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => props.onFileChange(e.target.files?.[0] ?? null)}
          disabled={props.loading}
        />
        {props.file && (
          <p className="text-xs text-neutral-500">
            {props.file.name} · {formatBytes(props.file.size)}
            {props.loading
              ? " · parsing..."
              : props.tenantCount > 0
                ? ` · ${props.tenantCount} tenants found`
                : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function QuarterAndZipCard(props: {
  quarterId: QuarterId;
  onQuarterChange: (id: QuarterId) => void;
  onZipUpload: (file: File | null) => void;
  loadedCount: number;
  totalCount: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Step 2 — Pick quarter, attach PDFs</CardTitle>
        <CardDescription>
          One quarter for the whole batch. Drag PDFs onto each tenant
          card below, or drop a zip here to auto-route by filename.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <label htmlFor="quarter" className="text-sm font-medium text-neutral-700">
              Quarter
            </label>
            <Select
              value={props.quarterId}
              onValueChange={(v) => {
                if (v) props.onQuarterChange(v as QuarterId);
              }}
            >
              <SelectTrigger id="quarter" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALL_QUARTER_IDS.map((q) => (
                  <SelectItem key={q} value={q}>
                    {quarterLabel(q)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <label htmlFor="zip" className="text-sm font-medium text-neutral-700">
              Bulk PDF zip (optional)
            </label>
            <Input
              id="zip"
              type="file"
              accept=".zip,application/zip"
              onChange={(e) => props.onZipUpload(e.target.files?.[0] ?? null)}
            />
            <p className="text-xs text-neutral-500">
              Files like{" "}
              <span className="font-mono">Pinnacle_Q1_2026.pdf</span>{" "}
              route to the matching tenant card automatically. Unmatched
              files surface in the Unassigned bucket below.
            </p>
          </div>
        </div>
        <p className="text-xs text-neutral-500">
          {props.loadedCount} of {props.totalCount} tenants have a PDF attached.
        </p>
      </CardContent>
    </Card>
  );
}

function TenantGrid(props: {
  tenants: TenantState[];
  running: boolean;
  onAssign: (row: number, file: File) => void;
  onClear: (row: number) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Step 3 — Tenants</CardTitle>
        <CardDescription>
          One card per tenant from column A of the tracker. Drop the
          tenant&rsquo;s quarterly PDF on its card.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {props.tenants.map((s) => (
            <TenantCard
              key={s.tenant.row}
              state={s}
              running={props.running}
              onAssign={props.onAssign}
              onClear={props.onClear}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function TenantCard(props: {
  state: TenantState;
  running: boolean;
  onAssign: (row: number, file: File) => void;
  onClear: (row: number) => void;
}) {
  const { state } = props;
  const [dragOver, setDragOver] = useState(false);

  function handleFile(file: File | null) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      toast.error(`${file.name} is not a PDF.`);
      return;
    }
    props.onAssign(state.tenant.row, file);
  }

  const statusBadge = (() => {
    switch (state.status) {
      case "idle":
        return <Badge variant="outline">no PDF</Badge>;
      case "loaded":
        return <Badge variant="secondary">ready</Badge>;
      case "extracting":
        return <Badge>extracting…</Badge>;
      case "computing":
        return <Badge>computing…</Badge>;
      case "computed":
        return <Badge variant="secondary">computed</Badge>;
      case "error":
        return <Badge variant="destructive">error</Badge>;
    }
  })();

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        handleFile(e.dataTransfer.files?.[0] ?? null);
      }}
      className={`rounded-lg border p-3 transition-colors ${
        dragOver ? "border-primary bg-blue-50" : "border-neutral-200"
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{state.tenant.display_name}</p>
          <p className="font-mono text-xs text-neutral-500">row {state.tenant.row}</p>
        </div>
        {statusBadge}
      </div>

      {state.pdf ? (
        <div className="flex items-center justify-between gap-2 rounded border bg-neutral-50 px-2.5 py-1.5">
          <span className="truncate text-xs text-neutral-700">
            {state.pdfName} · {formatBytes(state.pdf.size)}
          </span>
          <button
            type="button"
            className="text-xs text-neutral-500 hover:text-foreground"
            onClick={() => props.onClear(state.tenant.row)}
            disabled={props.running}
          >
            remove
          </button>
        </div>
      ) : (
        <label className="block cursor-pointer rounded border border-dashed border-neutral-300 px-3 py-2 text-center text-xs text-neutral-500 hover:bg-neutral-50">
          Drop a PDF here, or click to browse
          <input
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
          />
        </label>
      )}

      {state.status === "computed" && state.compute && (
        <div className="mt-2 grid grid-cols-2 gap-1 text-xs">
          <span className="text-neutral-500">Sales</span>
          <span className="text-right font-mono tabular-nums">
            {fmtMetric(state.compute.sales)}
          </span>
          <span className="text-neutral-500">EBITDA</span>
          <span className="text-right font-mono tabular-nums">
            {fmtMetric(state.compute.ebitda)}
          </span>
        </div>
      )}

      {state.status === "error" && state.error && (
        <p className="mt-2 text-xs text-red-600">{state.error}</p>
      )}
    </div>
  );
}

function UnassignedCard(props: {
  items: UnassignedPdf[];
  tenants: TenantPickerEntry[];
  onAssign: (unassignedId: string, row: number) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Unassigned PDFs</CardTitle>
        <CardDescription>
          These came out of the zip but didn&rsquo;t match a tenant
          name. Pick the right tenant from the dropdown for each one.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {props.items.map((u) => (
            <li
              key={u.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border bg-neutral-50 px-3 py-2"
            >
              <span className="font-mono text-xs">
                {u.name} · {formatBytes(u.file.size)}
              </span>
              <Select
                onValueChange={(v) => {
                  if (v) props.onAssign(u.id, Number(v));
                }}
              >
                <SelectTrigger className="w-72">
                  <SelectValue placeholder="Assign to tenant" />
                </SelectTrigger>
                <SelectContent>
                  {props.tenants.map((t) => (
                    <SelectItem key={t.row} value={String(t.row)}>
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-xs text-neutral-500">
                          row {t.row}
                        </span>
                        {t.display_name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ActionsCard(props: {
  loadedCount: number;
  readyCount: number;
  running: boolean;
  writing: boolean;
  onRunAll: () => void;
  onWriteAll: () => void;
  quarterLabel: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Step 4 — Run + write</CardTitle>
        <CardDescription>
          Extract + compute every loaded PDF in one click. Then review
          the results table below and download the filled-in tracker.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <Button
          onClick={props.onRunAll}
          disabled={props.running || props.writing || props.loadedCount === 0}
        >
          {props.running ? "Running…" : `Extract & compute (${props.loadedCount} loaded)`}
        </Button>
        <Button
          onClick={props.onWriteAll}
          disabled={props.running || props.writing || props.readyCount === 0}
          variant={props.readyCount > 0 ? "default" : "outline"}
        >
          {props.writing
            ? "Writing…"
            : `Write ${props.readyCount} tenant${props.readyCount === 1 ? "" : "s"} to ${props.quarterLabel}`}
        </Button>
      </CardContent>
    </Card>
  );
}

function ResultsTable(props: { rows: TenantState[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Step 5 — Review</CardTitle>
        <CardDescription>
          All values in $000s. EBITDA Margin is computed inline as a
          sanity check; the tracker recomputes it from Sales and EBITDA
          once you write.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tenant</TableHead>
              {WRITABLE_METRICS.map((m) => (
                <TableHead key={m} className="text-right">
                  {METRIC_LABELS[m]}
                </TableHead>
              ))}
              <TableHead className="text-right">Margin</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.rows.map((s) => {
              const c = s.compute!;
              const margin =
                c.sales !== null && c.sales !== 0 && c.ebitda !== null
                  ? (c.ebitda / c.sales) * 100
                  : null;
              return (
                <TableRow key={s.tenant.row}>
                  <TableCell className="max-w-64 truncate">
                    {s.tenant.display_name}
                  </TableCell>
                  {WRITABLE_METRICS.map((m) => (
                    <TableCell key={m} className="text-right font-mono tabular-nums">
                      {fmtMetric(c[m])}
                    </TableCell>
                  ))}
                  <TableCell className="text-right font-mono tabular-nums">
                    {margin === null ? "—" : `${margin.toFixed(1)}%`}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function fmtMetric(n: number | null): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString();
}

function traceToAudit(trace: ComputeMetricTrace) {
  return {
    formula: trace.formula,
    inputs: trace.contributions.map((c) => ({
      label: c.label,
      amount_source: c.amount_source,
      amount_tracker: c.amount_tracker,
    })),
    total_tracker_unrounded: trace.total_tracker_unrounded,
    result: trace.result_tracker ?? 0,
  };
}

