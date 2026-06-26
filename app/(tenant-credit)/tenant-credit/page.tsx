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

type Mode = "quick" | "triage";

// Tenant-side vs corporate-side classification per file. Recorded in
// the audit log so future you can see whether a Q1 26 Sales number
// came from the tenant entity directly or from a parent rollup.
// Compute treats both the same today.
type FileLevel = "tenant" | "corporate";

type TenantPickerEntry = {
  display_name: string;
  row: number;
  tenant_id: string;
};

type TenantFile = {
  id: string;
  file: File;
  name: string;
  // "pdf" or "xlsx". Used to render the right badge and to decide the
  // server-side extraction path.
  kind: "pdf" | "xlsx";
  level: FileLevel;
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
  | "idle"        // no files yet
  | "loaded"     // at least one file attached
  | "extracting" // running /extract on each file
  | "computing"  // running /compute on the merged line items
  | "computed"   // done
  | "error";

type TenantState = {
  tenant: TenantPickerEntry;
  files: TenantFile[];
  status: TenantStatus;
  extracts: ExtractResponse[];
  compute: ComputeResponse | null;
  error: string | null;
};

// Files dropped via zip in triage mode that haven't been assigned to a
// tenant yet. The recommendation comes from the filename matcher; the
// analyst either accepts or overrides via the picker.
type TriageEntry = {
  id: string;
  file: File;
  name: string;
  kind: "pdf" | "xlsx";
  recommended_tenant_id: string | null;
  assigned_tenant_id: string | null;
  level: FileLevel;
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

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

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

function fileKind(name: string): "pdf" | "xlsx" | null {
  const n = name.toLowerCase();
  if (n.endsWith(".pdf")) return "pdf";
  if (n.endsWith(".xlsx")) return "xlsx";
  return null;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Merge line items from N extracts into one list. When two files
// report the same label with different amounts, pick the one with the
// largest absolute value. The intuition: a full P&L usually has bigger
// magnitudes than a partial schedule, so largest-wins picks the
// authoritative source most of the time. The audit log records every
// contribution so the analyst can spot the rare wrong-pick.
function mergeLineItems(
  extracts: ExtractResponse[],
): { label: string; amount: number }[] {
  const winners = new Map<string, { amount: number; absAmount: number }>();
  for (const ex of extracts) {
    for (const item of ex.line_items) {
      const key = item.label.trim();
      if (!key) continue;
      const abs = Math.abs(item.amount);
      const cur = winners.get(key);
      if (cur === undefined || abs > cur.absAmount) {
        winners.set(key, { amount: item.amount, absAmount: abs });
      }
    }
  }
  return Array.from(winners.entries()).map(([label, v]) => ({
    label,
    amount: v.amount,
  }));
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TenantCreditPage() {
  const [mode, setMode] = useState<Mode>("quick");
  const [trackerFile, setTrackerFile] = useState<File | null>(null);
  const [tenants, setTenants] = useState<TenantPickerEntry[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(false);
  const [quarterId, setQuarterId] = useState<QuarterId>("Q1_2026");
  const [states, setStates] = useState<Record<number, TenantState>>({});
  const [triage, setTriage] = useState<TriageEntry[]>([]);
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
    setTriage([]);
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
          files: [],
          status: "idle",
          extracts: [],
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

  // ----- Per-tenant files -----------------------------------------------

  function addFileToTenant(row: number, file: File, level: FileLevel = "tenant") {
    const kind = fileKind(file.name);
    if (!kind) {
      toast.error(`${file.name} is not a PDF or .xlsx.`);
      return;
    }
    setStates((prev) => {
      const cur = prev[row];
      if (!cur) return prev;
      const tf: TenantFile = {
        id: randomId(),
        file,
        name: file.name,
        kind,
        level,
      };
      return {
        ...prev,
        [row]: {
          ...cur,
          files: [...cur.files, tf],
          status: "loaded",
          extracts: [],
          compute: null,
          error: null,
        },
      };
    });
  }

  function removeFile(row: number, fileId: string) {
    setStates((prev) => {
      const cur = prev[row];
      if (!cur) return prev;
      const nextFiles = cur.files.filter((f) => f.id !== fileId);
      return {
        ...prev,
        [row]: {
          ...cur,
          files: nextFiles,
          status: nextFiles.length === 0 ? "idle" : "loaded",
          extracts: [],
          compute: null,
          error: null,
        },
      };
    });
  }

  function toggleFileLevel(row: number, fileId: string) {
    setStates((prev) => {
      const cur = prev[row];
      if (!cur) return prev;
      return {
        ...prev,
        [row]: {
          ...cur,
          files: cur.files.map((f) =>
            f.id === fileId
              ? { ...f, level: f.level === "tenant" ? "corporate" : "tenant" }
              : f,
          ),
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

    // Build a normalized list of {file, recommendation} from the zip,
    // ignoring directories, macOS resource forks, and unsupported
    // extensions. Both modes consume this list; they differ in where
    // the files land.
    const candidates: {
      file: File;
      kind: "pdf" | "xlsx";
      filename: string;
      recommended: TenantPickerEntry | null;
    }[] = [];
    for (const [path, bytes] of Object.entries(entries)) {
      if (path.endsWith("/") || bytes.byteLength === 0) continue;
      const basename = path.split("/").pop() ?? path;
      if (path.startsWith("__MACOSX/") || basename.startsWith("._")) continue;
      const kind = fileKind(basename);
      if (!kind) continue;
      // PDF magic byte check; xlsx zips start with PK\x03\x04 which is
      // the ZIP signature so we don't enforce it here (the server
      // validates via ExcelJS).
      if (kind === "pdf") {
        if (
          bytes[0] !== 0x25 ||
          bytes[1] !== 0x50 ||
          bytes[2] !== 0x44 ||
          bytes[3] !== 0x46
        ) {
          continue;
        }
      }
      const mime =
        kind === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      const blob = new Blob([new Uint8Array(bytes)], { type: mime });
      const file = new File([blob], basename, { type: mime });
      const { winner, tied } = matchPdfToTenant(basename, tenants);
      candidates.push({
        file,
        kind,
        filename: basename,
        recommended: tied ? null : winner,
      });
    }

    if (candidates.length === 0) {
      toast.warning("Zip had no PDFs or .xlsx files we could read.");
      return;
    }

    if (mode === "quick") {
      // Quick mode: auto-route confident matches to the tenant cards.
      // Anything ambiguous lands in triage as an unsorted entry.
      let assigned = 0;
      const newTriage: TriageEntry[] = [];
      setStates((prev) => {
        const next = { ...prev };
        for (const c of candidates) {
          if (c.recommended && next[c.recommended.row]) {
            const tf: TenantFile = {
              id: randomId(),
              file: c.file,
              name: c.filename,
              kind: c.kind,
              level: "tenant",
            };
            next[c.recommended.row] = {
              ...next[c.recommended.row],
              files: [...next[c.recommended.row].files, tf],
              status: "loaded",
              extracts: [],
              compute: null,
              error: null,
            };
            assigned++;
          } else {
            newTriage.push({
              id: randomId(),
              file: c.file,
              name: c.filename,
              kind: c.kind,
              recommended_tenant_id: null,
              assigned_tenant_id: null,
              level: "tenant",
            });
          }
        }
        return next;
      });
      setTriage((cur) => [...cur, ...newTriage]);
      if (assigned > 0) toast.success(`Routed ${assigned}.`);
      if (newTriage.length > 0) {
        toast.warning(`${newTriage.length} unmatched. Assign below.`);
      }
    } else {
      // Triage mode: every file goes through the triage table for
      // confirmation, even the high-confidence ones.
      const newTriage: TriageEntry[] = candidates.map((c) => ({
        id: randomId(),
        file: c.file,
        name: c.filename,
        kind: c.kind,
        recommended_tenant_id: c.recommended?.tenant_id ?? null,
        assigned_tenant_id: c.recommended?.tenant_id ?? null,
        level: "tenant",
      }));
      setTriage((cur) => [...cur, ...newTriage]);
      toast.success(`Imported ${newTriage.length}. Confirm assignments below.`);
    }
  }

  function updateTriageEntry(id: string, patch: Partial<TriageEntry>) {
    setTriage((cur) => cur.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  function removeTriageEntry(id: string) {
    setTriage((cur) => cur.filter((e) => e.id !== id));
  }

  function confirmTriage() {
    // Commit every triage row that has an assigned tenant; leave the
    // un-assigned rows behind for the analyst to deal with.
    const assignable = triage.filter(
      (e) => e.assigned_tenant_id !== null && e.assigned_tenant_id !== "",
    );
    if (assignable.length === 0) {
      toast.error("No rows have a tenant assigned.");
      return;
    }
    setStates((prev) => {
      const next = { ...prev };
      for (const e of assignable) {
        const tenant = tenants.find((t) => t.tenant_id === e.assigned_tenant_id);
        if (!tenant || !next[tenant.row]) continue;
        const tf: TenantFile = {
          id: randomId(),
          file: e.file,
          name: e.name,
          kind: e.kind,
          level: e.level,
        };
        next[tenant.row] = {
          ...next[tenant.row],
          files: [...next[tenant.row].files, tf],
          status: "loaded",
          extracts: [],
          compute: null,
          error: null,
        };
      }
      return next;
    });
    const committedIds = new Set(assignable.map((e) => e.id));
    setTriage((cur) => cur.filter((e) => !committedIds.has(e.id)));
    toast.success(`Committed ${assignable.length}.`);
  }

  // ----- Batch extract + compute ----------------------------------------

  async function handleRunAll() {
    const ready = Object.values(states).filter(
      (s) => s.files.length > 0 && s.status !== "computed",
    );
    if (ready.length === 0) {
      toast.info("Nothing to run.");
      return;
    }
    setRunning(true);
    try {
      // Concurrency cap of 2 keeps us under Anthropic rate limits with
      // breathing room. Within one tenant, all files extract serially
      // to keep the worker-side memory bounded.
      await mapWithConcurrency(ready, 2, async (entry) => {
        const row = entry.tenant.row;
        setStates((prev) => ({
          ...prev,
          [row]: { ...prev[row], status: "extracting", error: null },
        }));
        try {
          const extracts: ExtractResponse[] = [];
          for (const tf of entry.files) {
            const form = new FormData();
            form.append("file", tf.file);
            form.append("tenant_id", entry.tenant.tenant_id);
            const res = await fetch("/api/tenant-credit/extract", {
              method: "POST",
              body: form,
            });
            if (!res.ok) {
              const detail = await res.json().catch(() => ({}));
              throw new Error(
                detail.error ?? `Extract failed for ${tf.name} (${res.status}).`,
              );
            }
            extracts.push((await res.json()) as ExtractResponse);
          }

          setStates((prev) => ({
            ...prev,
            [row]: { ...prev[row], status: "computing", extracts },
          }));
          const merged = mergeLineItems(extracts);
          const computeRes = await fetch("/api/tenant-credit/compute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tenant_id: entry.tenant.tenant_id,
              line_items: merged,
            }),
          });
          if (!computeRes.ok) {
            const detail = await computeRes.json().catch(() => ({}));
            throw new Error(
              detail.error ?? `Compute failed (${computeRes.status}).`,
            );
          }
          const computeData = (await computeRes.json()) as ComputeResponse;

          setQuarterId((cur) => {
            if (cur !== "Q1_2026") return cur;
            return guessQuarter(extracts[0]?.source_period ?? "");
          });

          setStates((prev) => ({
            ...prev,
            [row]: {
              ...prev[row],
              status: "computed",
              extracts,
              compute: computeData,
              error: null,
            },
          }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Run failed.";
          setStates((prev) => ({
            ...prev,
            [row]: { ...prev[row], status: "error", error: msg },
          }));
          toast.error(`${entry.tenant.display_name}: ${msg}`);
        }
      });
      toast.success("Done.");
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
      toast.error("Nothing computed yet.");
      return;
    }
    setWriting(true);
    try {
      const entries = await Promise.all(
        tenantsWithData.map(async (s) => {
          const c = s.compute!;
          const first = s.extracts[0] ?? null;
          const merged = mergeLineItems(s.extracts);
          const filenames = s.files.map((f) => f.name).join(", ");
          const hashes = await Promise.all(
            s.files.map((f) => sha256Hex(f.file).catch(() => "")),
          );
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
            source_pdf_filename: filenames,
            source_pdf_hash: hashes.join(","),
            source_entity: first?.source_entity ?? "",
            source_period: first?.source_period ?? "",
            line_items: merged,
            normalization_applied: first?.normalization_applied ?? [],
            passed_through: first?.passed_through ?? [],
            unused_labels: c.unused_labels,
            intercompany_observed: c.intercompany_observed,
            // Per-file metadata for the audit log. Kept verbatim so a
            // future schema can move it into its own Firestore field
            // without changing the route contract.
            files: s.files.map((f) => ({
              name: f.name,
              kind: f.kind,
              level: f.level,
            })),
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
  const loadedCount = allTenants.filter((s) => s.files.length > 0).length;

  return (
    <ConfigGate>
      <AppShell title="Tenant Credit Tracker">
        <ModeToggle mode={mode} onChange={setMode} />

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
              mode={mode}
            />

            {mode === "triage" && triage.length > 0 && (
              <TriageCard
                entries={triage}
                tenants={tenants}
                onChange={updateTriageEntry}
                onRemove={removeTriageEntry}
                onConfirm={confirmTriage}
              />
            )}

            {mode === "quick" && triage.length > 0 && (
              <UnassignedCard
                entries={triage}
                tenants={tenants}
                onAssign={(id, tenant_id) => {
                  updateTriageEntry(id, { assigned_tenant_id: tenant_id });
                }}
                onCommit={confirmTriage}
              />
            )}

            <TenantGrid
              tenants={allTenants}
              running={running}
              onAddFile={addFileToTenant}
              onRemoveFile={removeFile}
              onToggleLevel={toggleFileLevel}
            />

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

function ModeToggle(props: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="flex gap-2">
      <Button
        size="sm"
        variant={props.mode === "quick" ? "default" : "outline"}
        onClick={() => props.onChange("quick")}
      >
        Quick
      </Button>
      <Button
        size="sm"
        variant={props.mode === "triage" ? "default" : "outline"}
        onClick={() => props.onChange("triage")}
      >
        Triage
      </Button>
    </div>
  );
}

function TrackerCard(props: {
  file: File | null;
  loading: boolean;
  tenantCount: number;
  onFileChange: (next: File | null) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>1. Tracker</CardTitle>
        <CardDescription>
          Drop{" "}
          <span className="font-mono">Corporate_Financials_and_P_Ls.xlsx</span>.
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
                ? ` · ${props.tenantCount} tenants`
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
  mode: Mode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>2. Quarter &amp; files</CardTitle>
        <CardDescription>
          {props.mode === "quick"
            ? "Confident matches auto-route to cards. Ambiguous ones surface for review."
            : "Every file from the zip lands in the triage table for confirmation."}
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
              Bulk zip
            </label>
            <Input
              id="zip"
              type="file"
              accept=".zip,application/zip"
              onChange={(e) => props.onZipUpload(e.target.files?.[0] ?? null)}
            />
            <p className="text-xs text-neutral-500">
              PDFs and .xlsx supported.
            </p>
          </div>
        </div>
        <p className="text-xs text-neutral-500">
          {props.loadedCount} / {props.totalCount} attached.
        </p>
      </CardContent>
    </Card>
  );
}

function TriageCard(props: {
  entries: TriageEntry[];
  tenants: TenantPickerEntry[];
  onChange: (id: string, patch: Partial<TriageEntry>) => void;
  onRemove: (id: string) => void;
  onConfirm: () => void;
}) {
  const [previewId, setPreviewId] = useState<string | null>(
    props.entries[0]?.id ?? null,
  );
  const preview = props.entries.find((e) => e.id === previewId) ?? null;
  const previewUrl = useMemo(
    () => (preview ? URL.createObjectURL(preview.file) : ""),
    [preview],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Triage</CardTitle>
        <CardDescription>
          Confirm each file&rsquo;s tenant and tag.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {props.entries.map((e) => (
                  <TableRow
                    key={e.id}
                    onClick={() => setPreviewId(e.id)}
                    className={`cursor-pointer ${
                      previewId === e.id ? "bg-accent/40" : ""
                    }`}
                  >
                    <TableCell className="max-w-56">
                      <span className="flex items-center gap-2">
                        <Badge variant="outline" className="uppercase">
                          {e.kind}
                        </Badge>
                        <span className="truncate font-mono text-xs">
                          {e.name}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell
                      onClick={(ev) => ev.stopPropagation()}
                      className="min-w-56"
                    >
                      <Select
                        value={e.assigned_tenant_id ?? ""}
                        onValueChange={(v) =>
                          props.onChange(e.id, { assigned_tenant_id: v })
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Pick tenant" />
                        </SelectTrigger>
                        <SelectContent>
                          {props.tenants.map((t) => (
                            <SelectItem key={t.row} value={t.tenant_id}>
                              <span className="flex items-center gap-2">
                                <span className="font-mono text-xs text-neutral-500">
                                  row {t.row}
                                </span>
                                {t.display_name}
                                {t.tenant_id === e.recommended_tenant_id && (
                                  <Badge variant="secondary" className="ml-1">
                                    suggested
                                  </Badge>
                                )}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell onClick={(ev) => ev.stopPropagation()}>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant={e.level === "tenant" ? "default" : "outline"}
                          onClick={() => props.onChange(e.id, { level: "tenant" })}
                        >
                          T
                        </Button>
                        <Button
                          size="sm"
                          variant={e.level === "corporate" ? "default" : "outline"}
                          onClick={() => props.onChange(e.id, { level: "corporate" })}
                        >
                          C
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell onClick={(ev) => ev.stopPropagation()}>
                      <button
                        type="button"
                        className="text-xs text-neutral-500 hover:text-red-600"
                        onClick={() => props.onRemove(e.id)}
                      >
                        ×
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="rounded border bg-neutral-50 p-2">
            <p className="mb-2 text-xs text-neutral-500">
              Preview
              {preview ? ` · ${preview.name}` : ""}
            </p>
            {preview && preview.kind === "pdf" ? (
              <iframe
                key={previewId}
                src={previewUrl}
                className="h-96 w-full rounded border bg-white"
                title={preview.name}
              />
            ) : preview ? (
              <p className="text-xs text-neutral-500">
                {preview.name} ({formatBytes(preview.file.size)}). Excel
                preview not rendered inline.
              </p>
            ) : (
              <p className="text-xs text-neutral-500">Pick a row.</p>
            )}
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={props.onConfirm}>Confirm assignments</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function UnassignedCard(props: {
  entries: TriageEntry[];
  tenants: TenantPickerEntry[];
  onAssign: (id: string, tenant_id: string) => void;
  onCommit: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Unassigned</CardTitle>
        <CardDescription>Pick a tenant for each.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-2">
          {props.entries.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border bg-neutral-50 px-3 py-2"
            >
              <span className="flex items-center gap-2 font-mono text-xs">
                <Badge variant="outline" className="uppercase">
                  {e.kind}
                </Badge>
                {e.name}
              </span>
              <Select
                value={e.assigned_tenant_id ?? ""}
                onValueChange={(v) => props.onAssign(e.id, v)}
              >
                <SelectTrigger className="w-72">
                  <SelectValue placeholder="Assign to tenant" />
                </SelectTrigger>
                <SelectContent>
                  {props.tenants.map((t) => (
                    <SelectItem key={t.row} value={t.tenant_id}>
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
        <div className="flex justify-end">
          <Button onClick={props.onCommit} size="sm">
            Commit assignments
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TenantGrid(props: {
  tenants: TenantState[];
  running: boolean;
  onAddFile: (row: number, file: File, level?: FileLevel) => void;
  onRemoveFile: (row: number, fileId: string) => void;
  onToggleLevel: (row: number, fileId: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>3. Tenants</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {props.tenants.map((s) => (
            <TenantCard
              key={s.tenant.row}
              state={s}
              running={props.running}
              onAddFile={props.onAddFile}
              onRemoveFile={props.onRemoveFile}
              onToggleLevel={props.onToggleLevel}
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
  onAddFile: (row: number, file: File, level?: FileLevel) => void;
  onRemoveFile: (row: number, fileId: string) => void;
  onToggleLevel: (row: number, fileId: string) => void;
}) {
  const { state } = props;
  const [dragOver, setDragOver] = useState(false);

  function handleFiles(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      props.onAddFile(state.tenant.row, file);
    }
  }

  const statusBadge = (() => {
    switch (state.status) {
      case "idle":
        return <Badge variant="outline">empty</Badge>;
      case "loaded":
        return <Badge variant="secondary">ready</Badge>;
      case "extracting":
        return <Badge>extracting…</Badge>;
      case "computing":
        return <Badge>computing…</Badge>;
      case "computed":
        return <Badge variant="secondary">done</Badge>;
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
        handleFiles(e.dataTransfer.files);
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

      {state.files.length > 0 && (
        <ul className="mb-2 space-y-1">
          {state.files.map((f) => (
            <li
              key={f.id}
              className="flex items-center justify-between gap-2 rounded border bg-neutral-50 px-2.5 py-1.5"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Badge variant="outline" className="uppercase">
                  {f.kind}
                </Badge>
                <span className="truncate text-xs text-neutral-700">{f.name}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  className="text-[10px] uppercase text-neutral-500 hover:text-foreground"
                  onClick={() => props.onToggleLevel(state.tenant.row, f.id)}
                  title="Toggle tenant / corporate level"
                  disabled={props.running}
                >
                  {f.level === "corporate" ? "Corp" : "Tenant"}
                </button>
                <button
                  type="button"
                  className="text-xs text-neutral-500 hover:text-red-600"
                  onClick={() => props.onRemoveFile(state.tenant.row, f.id)}
                  disabled={props.running}
                >
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <label className="block cursor-pointer rounded border border-dashed border-neutral-300 px-3 py-2 text-center text-xs text-neutral-500 hover:bg-neutral-50">
        Drop PDFs / .xlsx, or click to add
        <input
          type="file"
          accept="application/pdf,.pdf,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </label>

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
        <CardTitle>4. Run &amp; write</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <Button
          onClick={props.onRunAll}
          disabled={props.running || props.writing || props.loadedCount === 0}
        >
          {props.running ? "Running…" : `Extract & compute (${props.loadedCount})`}
        </Button>
        <Button
          onClick={props.onWriteAll}
          disabled={props.running || props.writing || props.readyCount === 0}
          variant={props.readyCount > 0 ? "default" : "outline"}
        >
          {props.writing ? "Writing…" : `Write ${props.readyCount} to ${props.quarterLabel}`}
        </Button>
      </CardContent>
    </Card>
  );
}

function ResultsTable(props: { rows: TenantState[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>5. Review</CardTitle>
        <CardDescription>All values in $000s.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tenant</TableHead>
              <TableHead className="text-right">Files</TableHead>
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
              const corpCount = s.files.filter((f) => f.level === "corporate").length;
              return (
                <TableRow key={s.tenant.row}>
                  <TableCell className="max-w-64 truncate">
                    {s.tenant.display_name}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums text-neutral-500">
                    {s.files.length}
                    {corpCount > 0 ? ` (${corpCount}C)` : ""}
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
