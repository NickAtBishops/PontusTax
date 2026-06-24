"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/app-shell";
import { ConfigGate } from "@/components/config-gate";
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
import { Badge } from "@/components/ui/badge";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type { ComputeResult } from "@/lib/tenant-credit/methodology";
import {
  ALL_QUARTER_IDS,
  quarterLabel,
  writableQuartersForTenant,
  type QuarterId,
} from "@/lib/tenant-credit/tracker-layout";

// Mirrors the /api/extract response. Defined here rather than imported
// from the route so the client doesn't pull server modules into its
// bundle.
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

// Shape of the picker entry returned by /api/tenant-credit/tenants.
// Mirrors the route's TenantPickerEntry; redeclared here so the client
// bundle doesn't pull the server route module.
type TenantPickerEntry = {
  display_name: string;
  row: number;
  tenant_id: string;
};

// Shape of the Past Runs entries returned by /api/runs.
type RunSummary = {
  id: string;
  tenant_id: string;
  quarter: string;
  source_entity: string;
  source_period: string;
  source_pdf_filename: string;
  computed_sales: number;
  computed_ebitda: number;
  status: "writeback_success" | "writeback_failed";
  worker_warnings: string[];
  error: string | null;
  written_by: string;
  written_filename: string;
  created_at: number | null;
};

// Compute SHA-256 of file bytes and return a lowercase hex string. Uses
// the browser's SubtleCrypto so no extra dependency is needed.
async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Best-effort guess of the target quarter from the extracted period
// string. Falls back to Q1_2026 (the current quarter when the project
// was built) if no match — the analyst can still override via the
// picker before writing.
function guessQuarter(sourcePeriod: string): QuarterId {
  const text = sourcePeriod.toLowerCase();
  type Probe = { id: QuarterId; needles: string[] };
  const probes: Probe[] = ALL_QUARTER_IDS.map((id) => {
    const [q, y] = id.split("_");
    const yy = y.slice(2);
    const months = {
      Q1: ["jan", "feb", "mar"],
      Q2: ["apr", "may", "jun"],
      Q3: ["jul", "aug", "sep"],
      Q4: ["oct", "nov", "dec"],
    }[q as "Q1" | "Q2" | "Q3" | "Q4"];
    return {
      id,
      needles: [
        `${q.toLowerCase()} ${y}`,
        `${q.toLowerCase()} ${yy}`,
        `${q.toLowerCase()}/${y}`,
        ...months.map((m) => `${m} ${y}`),
      ],
    };
  });
  for (const probe of probes) {
    for (const needle of probe.needles) {
      if (text.includes(needle)) return probe.id;
    }
  }
  return "Q1_2026";
}

export default function DashboardPage() {
  // Tracker is uploaded once per session; the browser holds the original
  // File and re-sends it on writeback. We never persist it server-side
  // between requests.
  const [trackerFile, setTrackerFile] = useState<File | null>(null);
  const [tenants, setTenants] = useState<TenantPickerEntry[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState<boolean>(false);
  const [tenantId, setTenantId] = useState<string>("");
  const [file, setFile] = useState<File | null>(null);
  const [running, setRunning] = useState<boolean>(false);
  const [extract, setExtract] = useState<ExtractResponse | null>(null);
  const [compute, setCompute] = useState<ComputeResult | null>(null);
  const [quarterId, setQuarterId] = useState<QuarterId>("Q1_2026");
  const [writing, setWriting] = useState<boolean>(false);
  const [runs, setRuns] = useState<RunSummary[]>([]);

  // The picker uses tenant_id as its value (matches what the recipe
  // registry keys by). Look up the full entry for downstream calls.
  const selectedTenant = tenants.find((t) => t.tenant_id === tenantId) ?? null;

  // Pull Past Runs on mount and after each successful writeback. Errors
  // are swallowed because the section is informational; a noisy toast
  // every time Firestore isn't configured would be more annoying than
  // useful in local dev.
  const refreshRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/tenant-credit/runs?limit=20");
      if (!res.ok) return;
      const data = (await res.json()) as { runs: RunSummary[] };
      setRuns(data.runs);
    } catch {
      // ignore
    }
  }, []);
  // The lint rule react-hooks/set-state-in-effect flags calling a setter
  // synchronously inside an effect body. Wrapping in an IIFE with a
  // cancellation flag schedules the state update for the next tick, which
  // satisfies the rule and also prevents a setState-after-unmount warning
  // if the user navigates away during the fetch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/tenant-credit/runs?limit=20");
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as { runs: RunSummary[] };
        if (!cancelled) setRuns(data.runs);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Upload the corporate-financials tracker and ask the server for the
  // roster in column A. We keep the File object in component state so
  // the writeback step can re-send the same bytes; storing it on the
  // server between requests would mean session state we don't have.
  async function handleTrackerUpload(next: File | null) {
    setTrackerFile(next);
    setTenants([]);
    setTenantId("");
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
      if (data.tenants.length === 0) {
        toast.warning("No tenants found in column A of the tracker.");
      } else {
        // Pre-select the first tenant so the picker isn't blank.
        setTenantId(data.tenants[0].tenant_id);
        toast.success(`Loaded ${data.tenants.length} tenants.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Tracker parse failed.";
      toast.error(msg);
      setTrackerFile(null);
    } finally {
      setTenantsLoading(false);
    }
  }

  async function handleRun() {
    if (!file) {
      toast.error("Select a PDF first.");
      return;
    }
    if (!tenantId) {
      toast.error("Pick a tenant first.");
      return;
    }
    setRunning(true);
    setExtract(null);
    setCompute(null);

    try {
      // Step 1 - extract from PDF via Claude.
      const form = new FormData();
      form.append("file", file);
      form.append("tenant_id", tenantId);
      const extractRes = await fetch("/api/tenant-credit/extract", {
        method: "POST",
        body: form,
      });
      if (!extractRes.ok) {
        const detail = await extractRes.json().catch(() => ({}));
        throw new Error(detail.error ?? `Extract failed (${extractRes.status}).`);
      }
      const extractData = (await extractRes.json()) as ExtractResponse;

      // Step 2 - compute Sales and EBITDA from the normalized line items.
      const computeRes = await fetch("/api/tenant-credit/compute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenant_id: tenantId,
          line_items: extractData.line_items,
        }),
      });
      if (!computeRes.ok) {
        const detail = await computeRes.json().catch(() => ({}));
        throw new Error(
          detail.error ?? `Compute failed (${computeRes.status}).`,
        );
      }
      const computeData = (await computeRes.json()) as ComputeResult;

      setExtract(extractData);
      setCompute(computeData);
      setQuarterId(guessQuarter(extractData.source_period));
      toast.success("Extracted and computed.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Run failed.";
      toast.error(msg);
    } finally {
      setRunning(false);
    }
  }

  async function handleWriteback() {
    if (!compute || !extract || !file) return;
    if (!trackerFile) {
      toast.error("Upload the corporate financials tracker first.");
      return;
    }
    if (!selectedTenant) {
      toast.error("Pick a tenant first.");
      return;
    }
    setWriting(true);
    try {
      // Hash the PDF in the browser so the audit record records what
      // file produced these numbers. SubtleCrypto is fast: the Q1 26
      // PDF (30 KB) digests in under a millisecond.
      const sourcePdfHash = await sha256Hex(file);

      const payload = {
        tenant_id: tenantId,
        // tenant_display_name is column-A text from the analyst's own
        // tracker; the writeback uses its first whitespace/comma-
        // separated token as the substring the server checks against
        // column A of the target row.
        tenant_display_name: selectedTenant.display_name,
        quarter_id: quarterId,
        // tracker_row is authoritative: it comes from the user's own
        // file (column A row index), not a per-recipe default.
        tracker_row: selectedTenant.row,
        sales: compute.sales,
        ebitda: compute.ebitda,
        // Audit payload (Phase 6).
        source_pdf_filename: file.name,
        source_pdf_hash: sourcePdfHash,
        source_entity: extract.source_entity,
        source_period: extract.source_period,
        line_items: extract.line_items,
        normalization_applied: extract.normalization_applied,
        passed_through: extract.passed_through,
        unused_labels: compute.unused_labels,
        intercompany_observed: compute.intercompany_observed,
        calculations: {
          sales: {
            formula: compute.calculations.sales.formula,
            inputs: compute.calculations.sales.inputs,
            total_tracker_unrounded:
              compute.calculations.sales.total_tracker_unrounded,
            result: compute.calculations.sales.result_tracker,
          },
          ebitda: {
            formula: compute.calculations.ebitda.formula,
            inputs: compute.calculations.ebitda.inputs,
            total_tracker_unrounded:
              compute.calculations.ebitda.total_tracker_unrounded,
            result: compute.calculations.ebitda.result_tracker,
          },
        },
      };

      const writebackForm = new FormData();
      writebackForm.append("tracker_xlsx", trackerFile);
      writebackForm.append("payload", JSON.stringify(payload));
      const res = await fetch("/api/tenant-credit/writeback", {
        method: "POST",
        body: writebackForm,
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.error ?? `Writeback failed (${res.status}).`);
      }
      // Soft warnings (e.g. the AI3 header typo) come back on a header.
      const warningsRaw = res.headers.get("X-Worker-Warnings");
      if (warningsRaw) {
        try {
          const list = JSON.parse(warningsRaw) as string[];
          for (const w of list) toast.warning(w);
        } catch {
          // Header was present but not parseable JSON; surface raw.
          toast.warning(warningsRaw);
        }
      }
      // Trigger the download.
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      // Prefer the server's filename when present.
      const cd = res.headers.get("Content-Disposition") ?? "";
      const match = cd.match(/filename="([^"]+)"/);
      a.download = match?.[1] ?? "tracker.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Downloaded ${a.download}.`);
      refreshRuns();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Writeback failed.";
      toast.error(msg);
    } finally {
      setWriting(false);
    }
  }

  return (
    <ConfigGate>
      <AppShell title="Tenant Credit Tracker">
        <p className="text-sm text-muted-foreground">
          Preview Sales and EBITDA from a quarterly income statement before
          writing them to the corporate tracker.
        </p>

        <TrackerCard
          file={trackerFile}
          loading={tenantsLoading}
          tenants={tenants}
          onFileChange={handleTrackerUpload}
        />

        {trackerFile && tenants.length > 0 && (
          <UploadCard
            tenants={tenants}
            tenantId={tenantId}
            onTenantChange={setTenantId}
            file={file}
            onFileChange={setFile}
            running={running}
            onRun={handleRun}
          />
        )}

        {extract && compute && (
          <ResultCard extract={extract} compute={compute} />
        )}

        {extract && compute && (
          <WritebackCard
            extract={extract}
            compute={compute}
            quarterId={quarterId}
            onQuarterChange={setQuarterId}
            writing={writing}
            onWrite={handleWriteback}
          />
        )}

        {extract && compute && (
          <AuditCard extract={extract} compute={compute} />
        )}

        <PastRunsCard runs={runs} />
      </AppShell>
    </ConfigGate>
  );
}

function TrackerCard(props: {
  file: File | null;
  loading: boolean;
  tenants: TenantPickerEntry[];
  onFileChange: (next: File | null) => void;
}) {
  const total = props.tenants.length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Step 1 — Upload tracker</CardTitle>
        <CardDescription>
          Drop the latest <span className="font-mono">Corporate_Financials_and_P_Ls.xlsx</span>{" "}
          here. We read column A of the{" "}
          <span className="font-mono">Corp Financials</span> sheet to
          populate the tenant picker below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Input
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) =>
            props.onFileChange(e.target.files?.[0] ?? null)
          }
          disabled={props.loading}
        />
        {props.file && (
          <p className="text-xs text-neutral-500">
            {props.file.name} - {formatBytes(props.file.size)}
            {props.loading
              ? " - parsing..."
              : total > 0
                ? ` - ${total} tenants found`
                : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function PastRunsCard({ runs }: { runs: RunSummary[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Past runs</CardTitle>
        <CardDescription>
          Every write-back attempt, newest first. Reads from the
          <span className="font-mono"> tenant_tracker_runs </span>
          Firestore collection. Empty when Firebase isn&rsquo;t configured
          locally (see <span className="font-mono">docs/firebase-setup.md</span>).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {runs.length === 0 ? (
          <p className="rounded border border-dashed border-neutral-200 px-4 py-6 text-center text-sm text-neutral-500">
            No runs recorded yet. Set up Firebase to start logging.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Tenant</TableHead>
                <TableHead>Quarter</TableHead>
                <TableHead className="text-right">Sales</TableHead>
                <TableHead className="text-right">EBITDA</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell className="font-mono text-xs">
                    {run.created_at != null
                      ? new Date(run.created_at).toLocaleString()
                      : "-"}
                  </TableCell>
                  <TableCell>{run.tenant_id}</TableCell>
                  <TableCell>{run.quarter}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {run.computed_sales.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {run.computed_ebitda.toLocaleString()}
                  </TableCell>
                  <TableCell>
                    {run.status === "writeback_success" ? (
                      <Badge variant="secondary">OK</Badge>
                    ) : (
                      <Badge variant="destructive">Failed</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-neutral-600">
                    {run.written_by}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function WritebackCard(props: {
  extract: ExtractResponse;
  compute: ComputeResult;
  quarterId: QuarterId;
  onQuarterChange: (id: QuarterId) => void;
  writing: boolean;
  onWrite: () => void;
}) {
  // Show only quarters whose target cells are currently empty for this
  // tenant. The worker also refuses to overwrite populated cells; this
  // filter prevents the analyst from triggering that refusal in the UI.
  const writable = writableQuartersForTenant(props.extract.tenant_id);
  const options =
    writable.length > 0 ? writable : (ALL_QUARTER_IDS as QuarterId[]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Write to tracker</CardTitle>
        <CardDescription>
          Confirm the target quarter, then download a timestamped copy of
          the tracker with these two cells written. The master file in
          <span className="font-mono"> samples/</span> is never modified.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <label
              htmlFor="quarter"
              className="text-sm font-medium text-neutral-700"
            >
              Target quarter
            </label>
            <Select
              value={props.quarterId}
              onValueChange={(value) => {
                if (value !== null) props.onQuarterChange(value as QuarterId);
              }}
            >
              <SelectTrigger id="quarter" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((q) => (
                  <SelectItem key={q} value={q}>
                    {quarterLabel(q)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 md:col-span-2">
            <div className="text-sm font-medium text-neutral-700">
              Source PDF says
            </div>
            <div className="rounded border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
              {props.extract.source_period}
            </div>
            <p className="text-xs text-neutral-500">
              The picker default is inferred from this. Override if it&rsquo;s
              wrong.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <p className="text-xs text-neutral-500">
            Sales{" "}
            <span className="font-mono tabular-nums">
              {props.compute.sales.toLocaleString()}
            </span>{" "}
            and EBITDA{" "}
            <span className="font-mono tabular-nums">
              {props.compute.ebitda.toLocaleString()}
            </span>{" "}
            (both in $000s) will be written into the row for{" "}
            <span className="font-medium">
              {props.extract.source_entity}
            </span>
            .
          </p>
          <Button
            onClick={props.onWrite}
            disabled={props.writing}
            size="lg"
          >
            {props.writing ? "Writing..." : "Write to tracker"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function UploadCard(props: {
  tenants: TenantPickerEntry[];
  tenantId: string;
  onTenantChange: (id: string) => void;
  file: File | null;
  onFileChange: (file: File | null) => void;
  running: boolean;
  onRun: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Step 2 — Upload statement</CardTitle>
        <CardDescription>
          Pick the tenant, attach the quarter&rsquo;s income statement PDF,
          then run. The PDF is sent to Anthropic Claude for extraction.
          The compute step uses a generic rule that classifies each line
          by keyword (operating revenue, net income, addbacks); audit the
          numbers before writing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <label
              htmlFor="tenant"
              className="text-sm font-medium text-neutral-700"
            >
              Tenant
            </label>
            <Select
              value={props.tenantId}
              onValueChange={(value) => {
                if (value) props.onTenantChange(value);
              }}
            >
              <SelectTrigger id="tenant" className="w-full">
                <SelectValue placeholder="Pick a tenant" />
              </SelectTrigger>
              <SelectContent>
                {props.tenants.map((opt) => (
                  <SelectItem key={opt.display_name} value={opt.tenant_id}>
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-xs text-neutral-500">
                        row {opt.row}
                      </span>
                      {opt.display_name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <label
              htmlFor="pdf"
              className="text-sm font-medium text-neutral-700"
            >
              Income statement PDF
            </label>
            <Input
              id="pdf"
              type="file"
              accept="application/pdf"
              onChange={(e) =>
                props.onFileChange(e.target.files?.[0] ?? null)
              }
              disabled={props.running}
            />
            {props.file && (
              <p className="text-xs text-neutral-500">
                {props.file.name} - {formatBytes(props.file.size)}
              </p>
            )}
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            onClick={props.onRun}
            disabled={props.running || !props.file}
            size="lg"
          >
            {props.running ? "Processing..." : "Extract & Compute"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ResultCard({
  extract,
  compute,
}: {
  extract: ExtractResponse;
  compute: ComputeResult;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Computed values (preview)</CardTitle>
        <CardDescription>
          <span className="font-medium text-neutral-700">
            {extract.source_entity}
          </span>{" "}
          - {extract.source_period}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <StatTile
            label="Sales (000s)"
            value={compute.sales}
            formula={compute.calculations.sales.formula}
          />
          <StatTile
            label="EBITDA (000s)"
            value={compute.ebitda}
            formula={compute.calculations.ebitda.formula}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function StatTile({
  label,
  value,
  formula,
}: {
  label: string;
  value: number;
  formula: string;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-5">
      <div className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        {label}
      </div>
      <div className="mt-1 font-mono text-3xl font-semibold tabular-nums tracking-tight">
        {value.toLocaleString()}
      </div>
      <div className="mt-2 text-xs text-neutral-500">{formula}</div>
    </div>
  );
}

function AuditCard({
  extract,
  compute,
}: {
  extract: ExtractResponse;
  compute: ComputeResult;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit details</CardTitle>
        <CardDescription>
          What the engine actually did. Every tab here mirrors a field that
          Phase 6 will persist to the Firestore audit log.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="trace">
          <TabsList className="grid w-full grid-cols-2 md:grid-cols-5">
            <TabsTrigger value="trace">Trace</TabsTrigger>
            <TabsTrigger value="intercompany">
              Intercompany
              <CountBadge n={compute.intercompany_observed.length} />
            </TabsTrigger>
            <TabsTrigger value="rewrites">
              Label rewrites
              <CountBadge n={extract.normalization_applied.length} />
            </TabsTrigger>
            <TabsTrigger value="unused">
              Unused
              <CountBadge n={compute.unused_labels.length} warn />
            </TabsTrigger>
            <TabsTrigger value="raw">All inputs</TabsTrigger>
          </TabsList>

          <TabsContent value="trace" className="space-y-6 pt-4">
            <TraceSection
              title="Sales"
              formula={compute.calculations.sales.formula}
              inputs={compute.calculations.sales.inputs}
              unrounded={compute.calculations.sales.total_tracker_unrounded}
              result={compute.sales}
            />
            <TraceSection
              title="EBITDA"
              formula={compute.calculations.ebitda.formula}
              inputs={compute.calculations.ebitda.inputs}
              unrounded={compute.calculations.ebitda.total_tracker_unrounded}
              result={compute.ebitda}
            />
          </TabsContent>

          <TabsContent value="intercompany" className="pt-4">
            {compute.intercompany_observed.length === 0 ? (
              <Empty text="No intercompany pairs observed in this statement." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Income leg</TableHead>
                    <TableHead>Expense leg</TableHead>
                    <TableHead className="text-right">Income $</TableHead>
                    <TableHead className="text-right">Expense $</TableHead>
                    <TableHead>Match?</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {compute.intercompany_observed.map((pair, i) => (
                    <TableRow key={i}>
                      <TableCell>{pair.income_label}</TableCell>
                      <TableCell>{pair.expense_label}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {fmtDollars(pair.income_amount_source)}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {fmtDollars(pair.expense_amount_source)}
                      </TableCell>
                      <TableCell>
                        {pair.amounts_match ? (
                          <Badge variant="secondary">Match</Badge>
                        ) : (
                          <Badge variant="destructive">Mismatch</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>

          <TabsContent value="rewrites" className="pt-4">
            {extract.normalization_applied.length === 0 ? (
              <Empty text="The extractor returned canonical labels. Nothing was rewritten." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>From the PDF</TableHead>
                    <TableHead>Mapped to</TableHead>
                    <TableHead>Via</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {extract.normalization_applied.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-sm">
                        {r.raw_label}
                      </TableCell>
                      <TableCell>{r.canonical_label}</TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {r.match_type === "alias" ? "alias" : "case/space"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>

          <TabsContent value="unused" className="pt-4">
            {compute.unused_labels.length === 0 ? (
              <Empty text="Every line in the PDF was consumed by the recipe. Nothing left over." />
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-neutral-600">
                  These labels appeared in the source PDF but the recipe
                  didn&rsquo;t use them. Review before writing - a new revenue
                  line (e.g. &ldquo;Diesel Sales&rdquo;) would otherwise
                  silently shrink Sales.
                </p>
                <div className="flex flex-wrap gap-2">
                  {compute.unused_labels.map((label) => (
                    <Badge key={label} variant="outline">
                      {label}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="raw" className="pt-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label (canonical)</TableHead>
                  <TableHead className="text-right">Amount ($)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {extract.line_items.map((item, i) => (
                  <TableRow key={i}>
                    <TableCell>{item.label}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {fmtDollars(item.amount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function TraceSection({
  title,
  formula,
  inputs,
  unrounded,
  result,
}: {
  title: string;
  formula: string;
  inputs: { label: string; amount_source: number; amount_tracker: number }[];
  unrounded: number;
  result: number;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="text-xs text-neutral-500">{formula}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Line item</TableHead>
            <TableHead className="text-right">Amount ($)</TableHead>
            <TableHead className="text-right">($000s)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {inputs.map((inp, i) => (
            <TableRow key={i}>
              <TableCell>{inp.label}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {fmtDollars(inp.amount_source)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {inp.amount_tracker.toFixed(3)}
              </TableCell>
            </TableRow>
          ))}
          <TableRow className="border-t-2 border-neutral-300">
            <TableCell className="font-semibold">
              Total (before rounding)
            </TableCell>
            <TableCell className="text-right" />
            <TableCell className="text-right font-mono font-semibold tabular-nums">
              {unrounded.toFixed(3)}
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell className="font-semibold">
              Rounded ({title} in $000s)
            </TableCell>
            <TableCell className="text-right" />
            <TableCell className="text-right font-mono font-semibold tabular-nums">
              {result.toLocaleString()}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

function CountBadge({ n, warn }: { n: number; warn?: boolean }) {
  if (n === 0) return null;
  return (
    <Badge
      variant={warn ? "destructive" : "secondary"}
      className="ml-1.5 px-1.5 py-0 text-[10px]"
    >
      {n}
    </Badge>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="rounded border border-dashed border-neutral-200 px-4 py-6 text-center text-sm text-neutral-500">
      {text}
    </p>
  );
}

function fmtDollars(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
