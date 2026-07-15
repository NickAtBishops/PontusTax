"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { unzipSync } from "fflate";
import { Check, X } from "lucide-react";

import {
  deleteBlob,
  getBlob,
  putBlob,
} from "@/lib/tenant-credit/persistence";

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
import { ExcelPreviewTable } from "@/components/excel-preview-table";

import { matchFileToTenant } from "@/lib/tenant-credit/file-routing";
import { mergeLineItems } from "@/lib/tenant-credit/merge-line-items";
import { inspectZipArchive } from "@/lib/tenant-credit/zip-safety";
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

// Tenant-side vs corporate-side classification per file. Recorded in
// the audit log so future you can see whether a Q1 26 Sales number
// came from the tenant entity directly or from a parent rollup.
// Compute treats both the same today.
type FileLevel = "tenant" | "corporate";
type UnitsOverride = "auto" | "dollars" | "thousands" | "millions";

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
  unitsOverride: UnitsOverride;
};

type ExtractResponse = {
  tenant_id: string;
  source_entity: string;
  source_period: string;
  source_filename: string;
  source_file_hash: string;
  source_units: "dollars" | "thousands" | "millions";
  source_units_evidence: string;
  document_type:
    | "income_statement"
    | "balance_sheet"
    | "cash_flow_statement"
    | "combined_financial_statements"
    | "other";
  source_scope: string;
  source_scope_type:
    | "entity_wide"
    | "component_subset"
    | "single_component"
    | "unknown";
  source_scope_identifiers: string[];
  period_selection:
    | "printed_quarter_total"
    | "summed_months"
    | "single_period_column"
    | "point_in_time";
  line_items: {
    label: string;
    printed_amount: number;
    amount: number;
    source_reference: string;
  }[];
  normalization_applied: {
    raw_label: string;
    canonical_label: string;
    match_type: "case_or_whitespace" | "alias";
  }[];
  passed_through: string[];
  client_file_id?: string;
  // Set only when this extract was accepted despite its period not
  // matching the selected quarter, via the "Include anyway" retry
  // (see retryWithPeriodOverride). Threaded through to the writeback
  // payload so the merge layer waives its own quarter-match check for
  // this extract specifically and the audit trail records the reason.
  period_override_reason?: string;
};

type ExcludedFile = {
  file_id: string;
  filename: string;
  file_hash: string;
  source_period: string;
  reason: string;
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
  approved: boolean;
  excludedFiles: ExcludedFile[];
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
  unitsOverride: UnitsOverride;
};

// Persistent snapshot shape. Stored in per-tab sessionStorage as JSON; the raw
// file Blobs live in IndexedDB keyed by file.id. The version field
// makes it safe to evolve the schema later (older snapshots get
// ignored when v doesn't match what the code expects).
type SnapshotV2 = {
  v: 2;
  quarterId: QuarterId;
  analystName: string;
  tracker: { name: string; size: number; idbKey: string } | null;
  tenants: TenantPickerEntry[];
  states: Record<
    string,
    {
      tenant: TenantPickerEntry;
      filesMeta: {
        id: string;
        name: string;
        kind: "pdf" | "xlsx";
        level: FileLevel;
        unitsOverride: UnitsOverride;
      }[];
      status: TenantStatus;
      extracts: ExtractResponse[];
      compute: ComputeResponse | null;
      error: string | null;
      approved: boolean;
      excludedFiles: ExcludedFile[];
    }
  >;
  triage: {
    id: string;
    name: string;
    kind: "pdf" | "xlsx";
    recommended_tenant_id: string | null;
    assigned_tenant_id: string | null;
    level: FileLevel;
    unitsOverride: UnitsOverride;
  }[];
};

const SNAPSHOT_STORAGE_PREFIX = "pontus-tenant-credit-snapshot";
const WORKSPACE_SESSION_KEY = "pontus-tenant-credit-workspace";

// One row of write-back history. Mirrors the route's RunSummary; the
// audit module on the server persists these to Firestore so reloads
// don't lose them.
type RunSummary = {
  id: string;
  tenant_id: string;
  quarter: string;
  source_entity: string;
  source_period: string;
  source_pdf_filename: string;
  computed_sales: number;
  computed_ebitda: number;
  status: "writeback_pending" | "writeback_success" | "writeback_failed";
  worker_warnings: string[];
  unused_labels: string[];
  error: string | null;
  written_by: string;
  written_filename: string;
  created_at: number | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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

function fileKind(name: string): "pdf" | "xlsx" | null {
  const n = name.toLowerCase();
  if (n.endsWith(".pdf")) return "pdf";
  if (n.endsWith(".xlsx")) return "xlsx";
  return null;
}

function browserWorkspaceId(): string {
  if (typeof window === "undefined") return "server";
  const existing = window.sessionStorage.getItem(WORKSPACE_SESSION_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  window.sessionStorage.setItem(WORKSPACE_SESSION_KEY, created);
  return created;
}

function randomId(workspaceId: string): string {
  return `${workspaceId}:${crypto.randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TenantCreditPage() {
  const [workspaceId] = useState(browserWorkspaceId);
  const snapshotStorageKey = `${SNAPSHOT_STORAGE_PREFIX}:${workspaceId}`;
  const [trackerIdbKey, setTrackerIdbKey] = useState(() =>
    randomId(workspaceId),
  );
  const [trackerFile, setTrackerFile] = useState<File | null>(null);
  const [tenants, setTenants] = useState<TenantPickerEntry[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(false);
  const [quarterId, setQuarterId] = useState<QuarterId>("Q1_2026");
  const [analystName, setAnalystName] = useState("");
  const [states, setStates] = useState<Record<number, TenantState>>({});
  const [triage, setTriage] = useState<TriageEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [writing, setWriting] = useState(false);
  // A file the analyst clicked to preview. Renders in a slide-out
  // Sheet at the page root so any file in any list can be viewed
  // without disturbing the rest of the layout.
  const [previewing, setPreviewing] = useState<TenantFile | null>(null);
  // Hydration flag: while true, we've started reading the saved
  // snapshot from storage. We don't write back to storage until
  // hydration completes, otherwise the empty initial state would
  // wipe the saved snapshot before we can read it.
  const [hydrated, setHydrated] = useState(false);
  // Persistent write-back history pulled from Firestore. Survives
  // reloads because it isn't in-memory — every committed write-back
  // lands in the audit log via /api/tenant-credit/writeback and the
  // /runs endpoint reads it back.
  const [history, setHistory] = useState<RunSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch("/api/tenant-credit/runs?limit=50");
      if (!res.ok) return;
      const data = (await res.json()) as { runs: RunSummary[] };
      setHistory(data.runs);
    } catch {
      // Silent: the section is informational. A network blip
      // shouldn't surface a toast.
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setHistoryLoading(true);
      try {
        const res = await fetch("/api/tenant-credit/runs?limit=50");
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as { runs: RunSummary[] };
        if (!cancelled) setHistory(data.runs);
      } catch {
        // ignore
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ----- Tab-survival persistence ---------------------------------------
  // On mount: load the snapshot from sessionStorage + reconstruct File
  // objects from IndexedDB. On every state change after that: persist
  // the snapshot back. The hydrated flag prevents the first synchronous
  // empty state from being saved over the real saved snapshot before
  // we've had a chance to read it.

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = window.sessionStorage.getItem(snapshotStorageKey);
        if (!raw) return;
        const snap = JSON.parse(raw) as SnapshotV2;
        if (snap?.v !== 2) return;

        const trackerMime =
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

        let restoredTracker: File | null = null;
        if (snap.tracker) {
          setTrackerIdbKey(snap.tracker.idbKey);
          const blob = await getBlob(snap.tracker.idbKey);
          if (blob) {
            restoredTracker = new File([blob], snap.tracker.name, {
              type: trackerMime,
            });
          }
        }

        const restoredStates: Record<number, TenantState> = {};
        for (const [rowKey, s] of Object.entries(snap.states)) {
          const row = Number(rowKey);
          const files: TenantFile[] = [];
          for (const fm of s.filesMeta) {
            const blob = await getBlob(fm.id);
            if (!blob) continue;
            const mime =
              fm.kind === "pdf" ? "application/pdf" : trackerMime;
            files.push({
              id: fm.id,
              file: new File([blob], fm.name, { type: mime }),
              name: fm.name,
              kind: fm.kind,
              level: fm.level,
              unitsOverride: fm.unitsOverride ?? "auto",
            });
          }
          restoredStates[row] = {
            tenant: s.tenant,
            files,
            // If IDB had been cleared (or a file was deleted out from
            // under us), reset the run status. The numeric compute
            // results stay for reference.
            status: files.length === 0 ? "idle" : s.status,
            extracts: s.extracts,
            compute: s.compute,
            error: s.error,
            approved: false,
            excludedFiles: s.excludedFiles ?? [],
          };
        }

        const restoredTriage: TriageEntry[] = [];
        for (const t of snap.triage) {
          const blob = await getBlob(t.id);
          if (!blob) continue;
          const mime = t.kind === "pdf" ? "application/pdf" : trackerMime;
          restoredTriage.push({
            id: t.id,
            file: new File([blob], t.name, { type: mime }),
            name: t.name,
            kind: t.kind,
            recommended_tenant_id: t.recommended_tenant_id,
            assigned_tenant_id: t.assigned_tenant_id,
            level: t.level,
            unitsOverride: t.unitsOverride ?? "auto",
          });
        }

        if (cancelled) return;
        setQuarterId(snap.quarterId);
        setAnalystName(snap.analystName ?? "");
        setTrackerFile(restoredTracker);
        setTenants(snap.tenants);
        setStates(restoredStates);
        setTriage(restoredTriage);
      } catch {
        // Corrupted snapshot: ignore and start fresh.
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshotStorageKey]);

  useEffect(() => {
    if (!hydrated) return;
    const handle = window.setTimeout(async () => {
      try {
        const snap: SnapshotV2 = {
          v: 2,
          quarterId,
          analystName,
          tracker: trackerFile
            ? {
                name: trackerFile.name,
                size: trackerFile.size,
                idbKey: trackerIdbKey,
              }
            : null,
          tenants,
          states: Object.fromEntries(
            Object.entries(states).map(([row, s]) => [
              row,
              {
                tenant: s.tenant,
                filesMeta: s.files.map((f) => ({
                  id: f.id,
                  name: f.name,
                  kind: f.kind,
                  level: f.level,
                  unitsOverride: f.unitsOverride,
                })),
                status: s.status,
                extracts: s.extracts,
                compute: s.compute,
                error: s.error,
                approved: s.approved,
                excludedFiles: s.excludedFiles,
              },
            ]),
          ),
          triage: triage.map((e) => ({
            id: e.id,
            name: e.name,
            kind: e.kind,
            recommended_tenant_id: e.recommended_tenant_id,
            assigned_tenant_id: e.assigned_tenant_id,
            level: e.level,
            unitsOverride: e.unitsOverride,
          })),
        };

        const writes: Promise<void>[] = [];
        if (trackerFile) writes.push(putBlob(trackerIdbKey, trackerFile));
        for (const s of Object.values(states)) {
          for (const f of s.files) writes.push(putBlob(f.id, f.file));
        }
        for (const e of triage) writes.push(putBlob(e.id, e.file));
        await Promise.all(writes);

        window.sessionStorage.setItem(
          snapshotStorageKey,
          JSON.stringify(snap),
        );
      } catch {
        // ignore; next save will retry
      }
    }, 500);
    return () => window.clearTimeout(handle);
  }, [
    hydrated,
    analystName,
    quarterId,
    snapshotStorageKey,
    trackerFile,
    trackerIdbKey,
    tenants,
    states,
    triage,
  ]);

  // Hard reset: clear this tab's session snapshot and IDB blobs.
  // Useful when the persisted snapshot is interfering with a fresh
  // upload (or just to start over). Exposed via the Reset button at the
  // top of the page.
  async function resetAll() {
    window.sessionStorage.removeItem(snapshotStorageKey);
    await Promise.all([
      deleteBlob(trackerIdbKey),
      ...Object.values(states).flatMap((state) =>
        state.files.map((file) => deleteBlob(file.id)),
      ),
      ...triage.map((entry) => deleteBlob(entry.id)),
    ]);
    setTrackerFile(null);
    setTenants([]);
    setStates({});
    setTriage([]);
    setQuarterId("Q1_2026");
    setAnalystName("");
    setPreviewing(null);
    toast.success("Cleared.");
  }

  const computedTenants = useMemo(
    () =>
      Object.values(states).filter(
        (s) => s.status === "computed" && s.compute !== null,
      ),
    [states],
  );
  const tenantsWithData = useMemo(
    () => computedTenants.filter((state) => state.approved),
    [computedTenants],
  );

  function handleQuarterChange(nextQuarter: QuarterId) {
    if (nextQuarter === quarterId) return;
    setQuarterId(nextQuarter);
    setStates((previous) =>
      Object.fromEntries(
        Object.entries(previous).map(([row, state]) => [
          row,
          {
            ...state,
            status: state.files.length > 0 ? "loaded" : "idle",
            extracts: [],
            compute: null,
            error: null,
            approved: false,
            excludedFiles: [],
          },
        ]),
      ),
    );
  }

  // ----- Tracker upload --------------------------------------------------

  async function handleTrackerUpload(next: File | null) {
    void deleteBlob(trackerIdbKey);
    setTrackerIdbKey(randomId(workspaceId));
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
          approved: false,
          excludedFiles: [],
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
        id: randomId(workspaceId),
        file,
        name: file.name,
        kind,
        level,
        unitsOverride: "auto",
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
          approved: false,
          excludedFiles: [],
        },
      };
    });
  }

  function removeFile(row: number, fileId: string) {
    // Drop the blob from IDB too so it doesn't linger as an orphan.
    // Fire-and-forget: a failed delete just wastes a bit of disk;
    // it doesn't break the UI.
    void deleteBlob(fileId);
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
          approved: false,
          excludedFiles: [],
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
          status: "loaded",
          extracts: [],
          compute: null,
          error: null,
          approved: false,
          excludedFiles: [],
        },
      };
    });
  }

  function setFileUnits(
    row: number,
    fileId: string,
    unitsOverride: UnitsOverride,
  ) {
    setStates((prev) => {
      const cur = prev[row];
      if (!cur) return prev;
      return {
        ...prev,
        [row]: {
          ...cur,
          files: cur.files.map((file) =>
            file.id === fileId ? { ...file, unitsOverride } : file,
          ),
          status: "loaded",
          extracts: [],
          compute: null,
          error: null,
          approved: false,
          excludedFiles: [],
        },
      };
    });
  }

  function setTenantApproval(row: number, approved: boolean) {
    setStates((previous) => {
      const state = previous[row];
      if (
        !state ||
        state.status !== "computed" ||
        !state.compute ||
        state.compute.sales == null ||
        state.compute.ebitda == null
      ) {
        return previous;
      }
      return { ...previous, [row]: { ...state, approved } };
    });
  }

  // ----- Zip handling ---------------------------------------------------

  async function handleZipUpload(zipFile: File | null) {
    if (!zipFile) return;
    if (!zipFile.name.toLowerCase().endsWith(".zip")) {
      toast.error("Bulk upload must be a .zip file.");
      return;
    }
    if (zipFile.size > 128 * 1024 * 1024) {
      toast.error("Bulk zip must be 128 MB or smaller.");
      return;
    }
    let entries: Record<string, Uint8Array>;
    try {
      const bytes = new Uint8Array(await zipFile.arrayBuffer());
      inspectZipArchive(bytes);
      entries = unzipSync(bytes);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not unzip.");
      return;
    }

    // Build a normalized list of review candidates. Known metadata files are
    // ignored; any other unsupported or malformed member blocks the import so
    // a partial zip never looks complete on the surface.
    const candidates: {
      file: File;
      kind: "pdf" | "xlsx";
      filename: string;
      recommended: TenantPickerEntry | null;
    }[] = [];
    const rejected: string[] = [];
    for (const [path, bytes] of Object.entries(entries)) {
      if (path.endsWith("/") || bytes.byteLength === 0) continue;
      const basename = path.split("/").pop() ?? path;
      if (
        path.startsWith("__MACOSX/") ||
        basename.startsWith("._") ||
        basename === ".DS_Store"
      ) continue;
      const kind = fileKind(basename);
      if (!kind) {
        rejected.push(`${basename} (unsupported type)`);
        continue;
      }
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
          rejected.push(`${basename} (invalid PDF header)`);
          continue;
        }
      }
      const mime =
        kind === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      const blob = new Blob([new Uint8Array(bytes)], { type: mime });
      const file = new File([blob], basename, { type: mime });
      // Route on the FULL zip path: in real quarterly zips the tenant
      // identity lives in the folder name ("Kraf/JANUARY.pdf"), not
      // the basename.
      const { winner, tied } = matchFileToTenant(path, tenants);
      candidates.push({
        file,
        kind,
        filename: basename,
        recommended: tied ? null : winner,
      });
    }

    if (rejected.length > 0) {
      toast.error(
        `Zip import stopped: ${rejected.slice(0, 5).join(", ")}` +
          (rejected.length > 5 ? ` and ${rejected.length - 5} more` : ""),
      );
      return;
    }

    if (candidates.length === 0) {
      toast.warning("Zip had no PDFs or .xlsx files we could read.");
      return;
    }

    const newTriage: TriageEntry[] = candidates.map((candidate) => ({
      id: randomId(workspaceId),
      file: candidate.file,
      name: candidate.filename,
      kind: candidate.kind,
      recommended_tenant_id: candidate.recommended?.tenant_id ?? null,
      assigned_tenant_id: candidate.recommended?.tenant_id ?? null,
      level: "tenant",
      unitsOverride: "auto",
    }));
    setTriage((current) => [...current, ...newTriage]);
    toast.success(`Imported ${newTriage.length}. Confirm assignments below.`);
  }

  function updateTriageEntry(id: string, patch: Partial<TriageEntry>) {
    setTriage((cur) => cur.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  function removeTriageEntry(id: string) {
    void deleteBlob(id);
    setTriage((cur) => cur.filter((e) => e.id !== id));
  }

  // Accept a single triage row: move its file onto the chosen tenant,
  // then pop the row off the triage queue. Called by TenantCombobox's
  // green check (and by clicking a suggestion) so the analyst gets
  // one-click commits instead of doing the bulk "Confirm assignments"
  // step.
  function acceptOneTriage(entryId: string, tenantId: string) {
    const entry = triage.find((e) => e.id === entryId);
    if (!entry) return;
    const tenant = tenants.find((t) => t.tenant_id === tenantId);
    if (!tenant) {
      toast.error("Unknown tenant.");
      return;
    }
    setStates((prev) => {
      if (!prev[tenant.row]) return prev;
      const tf: TenantFile = {
        id: entry.id,
        file: entry.file,
        name: entry.name,
        kind: entry.kind,
        level: entry.level,
        unitsOverride: entry.unitsOverride,
      };
      return {
        ...prev,
        [tenant.row]: {
          ...prev[tenant.row],
          files: [...prev[tenant.row].files, tf],
          status: "loaded",
          extracts: [],
          compute: null,
          error: null,
          approved: false,
          excludedFiles: [],
        },
      };
    });
    setTriage((cur) => cur.filter((e) => e.id !== entryId));
    toast.success(`→ ${tenant.display_name}`);
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
          id: e.id,
          file: e.file,
          name: e.name,
          kind: e.kind,
          level: e.level,
          unitsOverride: e.unitsOverride,
        };
        next[tenant.row] = {
          ...next[tenant.row],
          files: [...next[tenant.row].files, tf],
          status: "loaded",
          extracts: [],
          compute: null,
          error: null,
          approved: false,
          excludedFiles: [],
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
          [row]: {
            ...prev[row],
            status: "extracting",
            error: null,
            approved: false,
            excludedFiles: [],
          },
        }));
        try {
          const extracts: ExtractResponse[] = [];
          const excludedFiles: ExcludedFile[] = [];
          const fileFailures: string[] = [];
          for (const tf of entry.files) {
            try {
              const form = new FormData();
              form.append("file", tf.file);
              form.append("tenant_id", entry.tenant.tenant_id);
              form.append("quarter_id", quarterId);
              form.append("source_units_override", tf.unitsOverride);
              const res = await fetch("/api/tenant-credit/extract", {
                method: "POST",
                body: form,
              });
              if (!res.ok) {
                const detail = await res.json().catch(() => ({}));
                if (
                  detail.code === "SOURCE_PERIOD_OUTSIDE_QUARTER" &&
                  typeof detail.source_file_hash === "string" &&
                  typeof detail.source_period === "string"
                ) {
                  const reason =
                    detail.error ?? `${tf.name} is outside the selected quarter.`;
                  excludedFiles.push({
                    file_id: tf.id,
                    filename: tf.name,
                    file_hash: detail.source_file_hash,
                    source_period: detail.source_period,
                    reason,
                  });
                  toast.warning(`${entry.tenant.display_name}: ${reason}`);
                  continue;
                }
                throw new Error(
                  detail.error ?? `Extract failed (${res.status}).`,
                );
              }
              extracts.push({
                ...((await res.json()) as ExtractResponse),
                client_file_id: tf.id,
              });
            } catch (err) {
              // One bad file shouldn't kill the rest of the tenant's
              // run. Surface the per-file error as a toast so the
              // analyst can fix it, then keep going. The tenant
              // succeeds as long as at least one file extracted.
              const msg = err instanceof Error ? err.message : "Extract failed.";
              fileFailures.push(`${tf.name}: ${msg}`);
              toast.error(`${entry.tenant.display_name} · ${tf.name}: ${msg}`);
            }
          }
          if (fileFailures.length > 0) {
            throw new Error(
              `Blocked writeback: ${fileFailures.length} of ` +
                `${entry.files.length} attached file(s) failed extraction. ` +
                fileFailures.join(" | "),
            );
          }
          if (extracts.length === 0) {
            throw new Error(
              fileFailures.length > 0
                ? `All ${entry.files.length} file(s) failed.`
                : "No extracts produced.",
            );
          }

          setStates((prev) => ({
            ...prev,
            [row]: { ...prev[row], status: "computing", extracts },
          }));
          const {
            merged,
            conflicts: mergeConflicts,
            excludedExtracts,
          } = mergeLineItems(extracts, quarterId);
          for (const exclusion of excludedExtracts) {
            toast.warning(
              `${entry.tenant.display_name}: ${exclusion.extract.source_filename} ` +
                exclusion.reason,
            );
          }
          for (const c of mergeConflicts) {
            toast.warning(`${entry.tenant.display_name}: ${c}`);
          }
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

          setStates((prev) => ({
            ...prev,
            [row]: {
              ...prev[row],
              status: "computed",
              extracts,
              compute: computeData,
              error: null,
              approved: false,
              excludedFiles,
            },
          }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Run failed.";
          setStates((prev) => ({
            ...prev,
            [row]: {
              ...prev[row],
              status: "error",
              error: msg,
              approved: false,
            },
          }));
          toast.error(`${entry.tenant.display_name}: ${msg}`);
        }
      });
      toast.success("Done.");
    } finally {
      setRunning(false);
    }
  }

  // Re-run merge + compute for one tenant against whatever extracts are
  // currently in state. Shared by handleRunAll's tail and
  // retryWithPeriodOverride below so "include this file anyway" doesn't
  // duplicate the merge/compute wiring.
  async function recomputeTenant(row: number, extracts: ExtractResponse[]) {
    const tenant = states[row]?.tenant;
    if (!tenant) return;
    const { merged, conflicts: mergeConflicts, excludedExtracts } =
      mergeLineItems(extracts, quarterId);
    for (const exclusion of excludedExtracts) {
      toast.warning(
        `${tenant.display_name}: ${exclusion.extract.source_filename} ` +
          exclusion.reason,
      );
    }
    for (const c of mergeConflicts) {
      toast.warning(`${tenant.display_name}: ${c}`);
    }
    const computeRes = await fetch("/api/tenant-credit/compute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenant_id: tenant.tenant_id, line_items: merged }),
    });
    if (!computeRes.ok) {
      const detail = await computeRes.json().catch(() => ({}));
      throw new Error(detail.error ?? `Compute failed (${computeRes.status}).`);
    }
    return (await computeRes.json()) as ComputeResponse;
  }

  // "Include anyway" escape hatch (per-file, per CLAUDE.md's
  // period_override_reason design): re-submits ONE previously-excluded
  // file's extraction with an analyst-supplied reason, folds the
  // resulting extract into that tenant's extracts on success, and
  // recomputes. This is a distinct, explicit user action — never
  // automatic — exactly like the existing entity-mismatch override
  // requires an explicit reason before writeback proceeds.
  async function retryWithPeriodOverride(
    row: number,
    excludedFile: ExcludedFile,
    reason: string,
  ) {
    const trimmedReason = reason.trim();
    if (trimmedReason.length === 0) {
      toast.error("Enter a reason before including this file.");
      return;
    }
    const state = states[row];
    if (!state) return;
    const tf = state.files.find((f) => f.id === excludedFile.file_id);
    if (!tf) {
      toast.error(`${excludedFile.filename}: original file is no longer attached.`);
      return;
    }
    setStates((prev) => ({
      ...prev,
      [row]: { ...prev[row], status: "extracting", error: null },
    }));
    try {
      const form = new FormData();
      form.append("file", tf.file);
      form.append("tenant_id", state.tenant.tenant_id);
      form.append("quarter_id", quarterId);
      form.append("source_units_override", tf.unitsOverride);
      form.append("period_override_reason", trimmedReason);
      const res = await fetch("/api/tenant-credit/extract", {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.error ?? `Extract failed (${res.status}).`);
      }
      const extract: ExtractResponse = {
        ...((await res.json()) as ExtractResponse),
        client_file_id: tf.id,
        period_override_reason: trimmedReason,
      };
      const nextExtracts = [
        ...state.extracts.filter((e) => e.source_file_hash !== extract.source_file_hash),
        extract,
      ];
      const nextExcluded = state.excludedFiles.filter(
        (f) => f.file_id !== excludedFile.file_id,
      );
      setStates((prev) => ({
        ...prev,
        [row]: {
          ...prev[row],
          status: "computing",
          extracts: nextExtracts,
          excludedFiles: nextExcluded,
        },
      }));
      const computeData = await recomputeTenant(row, nextExtracts);
      setStates((prev) => ({
        ...prev,
        [row]: {
          ...prev[row],
          status: "computed",
          extracts: nextExtracts,
          compute: computeData ?? prev[row].compute,
          error: null,
          approved: false,
          excludedFiles: nextExcluded,
        },
      }));
      toast.success(`${state.tenant.display_name}: included ${tf.name} anyway.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Include-anyway retry failed.";
      setStates((prev) => ({
        ...prev,
        [row]: { ...prev[row], status: "error", error: msg },
      }));
      toast.error(`${state.tenant.display_name} · ${tf.name}: ${msg}`);
    }
  }

  // ----- Batch writeback ------------------------------------------------

  async function handleWriteAll() {
    if (!trackerFile) {
      toast.error("Upload the tracker first.");
      return;
    }
    if (analystName.trim().length < 2) {
      toast.error("Enter the analyst name before writeback.");
      return;
    }
    if (triage.length > 0) {
      toast.error("Resolve every triage row before writeback.");
      return;
    }
    const unresolved = Object.values(states).filter(
      (state) => state.files.length > 0 && state.status !== "computed",
    );
    if (unresolved.length > 0) {
      toast.error(
        `Resolve ${unresolved.length} loaded tenant run(s) before writeback.`,
      );
      return;
    }
    if (computedTenants.length === 0) {
      toast.error("Nothing computed yet.");
      return;
    }
    if (tenantsWithData.length !== computedTenants.length) {
      toast.error("Approve every computed tenant in Review before writeback.");
      return;
    }
    setWriting(true);
    try {
      const entries = tenantsWithData.map((s) => {
          const c = s.compute!;
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
            extracts: s.extracts.map((extract, index) => {
              const file =
                s.files.find(
                  (candidate) => candidate.id === extract.client_file_id,
                ) ??
                s.files.find(
                  (candidate) => candidate.name === extract.source_filename,
                ) ??
                s.files[index];
              if (!file) {
                throw new Error(
                  `Lost attached-file metadata for ${extract.source_filename}.`,
                );
              }
              return {
                source_entity: extract.source_entity,
                source_period: extract.source_period,
                source_filename: extract.source_filename,
                source_file_hash: extract.source_file_hash,
                source_units: extract.source_units,
                source_units_evidence: extract.source_units_evidence,
                document_type: extract.document_type,
                source_scope: extract.source_scope,
                source_scope_type: extract.source_scope_type,
                source_scope_identifiers: extract.source_scope_identifiers,
                period_selection: extract.period_selection,
                line_items: extract.line_items,
                level: file.level,
                period_override_reason: extract.period_override_reason ?? "",
              };
            }),
            excluded_files: s.excludedFiles.map((file) => ({
              filename: file.filename,
              file_hash: file.file_hash,
              source_period: file.source_period,
              reason: file.reason,
            })),
            normalization_applied: s.extracts.flatMap(
              (extract) => extract.normalization_applied,
            ),
            entity_override_reason:
              "Analyst reviewed and approved the source assignment and all computed values.",
          };
        });

      const form = new FormData();
      form.append("tracker_xlsx", trackerFile);
      form.append(
        "payload",
        JSON.stringify({
          quarter_id: quarterId,
          analyst_name: analystName.trim(),
          entries,
        }),
      );
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
      // Pull the freshly-written runs into the history table so the
      // analyst sees them appear without a manual reload.
      refreshHistory();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Writeback failed.");
    } finally {
      setWriting(false);
    }
  }

  // ----- Render --------------------------------------------------------

  const allTenants = Object.values(states).sort((a, b) => a.tenant.row - b.tenant.row);
  const readyCount = tenantsWithData.length;
  const computedCount = computedTenants.length;
  const loadedCount = allTenants.filter((s) => s.files.length > 0).length;

  return (
    <ConfigGate>
      <AppShell title="Tenant Credit Tracker">
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={resetAll}>
            Reset
          </Button>
        </div>

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
              onQuarterChange={handleQuarterChange}
              onZipUpload={handleZipUpload}
              loadedCount={loadedCount}
              totalCount={allTenants.length}
            />

            {triage.length > 0 && (
              <TriageCard
                entries={triage}
                tenants={tenants}
                onChange={updateTriageEntry}
                onRemove={removeTriageEntry}
                onConfirm={confirmTriage}
                onAcceptOne={acceptOneTriage}
              />
            )}

            <TenantGrid
              tenants={allTenants}
              running={running}
              onAddFile={addFileToTenant}
              onRemoveFile={removeFile}
              onToggleLevel={toggleFileLevel}
              onSetUnits={setFileUnits}
              onPreviewFile={setPreviewing}
            />

            <ActionsCard
              loadedCount={loadedCount}
              readyCount={readyCount}
              analystName={analystName}
              onAnalystNameChange={setAnalystName}
              running={running}
              writing={writing}
              onRunAll={handleRunAll}
              onWriteAll={handleWriteAll}
              quarterLabel={quarterLabel(quarterId)}
            />

            {computedCount > 0 && (
              <ResultsTable
                rows={computedTenants}
                quarterId={quarterId}
                onApprovalChange={setTenantApproval}
                onIncludeAnyway={retryWithPeriodOverride}
              />
            )}
          </>
        )}

        <HistoryCard
          runs={history}
          loading={historyLoading}
          onRefresh={refreshHistory}
        />

        <FilePreviewSheet
          file={previewing}
          onClose={() => setPreviewing(null)}
        />
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
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>2. Quarter &amp; files</CardTitle>
        <CardDescription>
          Every file from the zip lands in triage for confirmation.
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

// Typeahead-style tenant picker. The analyst types part of the
// tenant's name; matching tenants narrow down by score. Tab/Enter
// PREVIEWS the top match by setting the input value. The green check
// button (or an explicit click on a suggestion) ACCEPTS, calling
// onAccept when provided so the parent can commit the assignment and
// remove the row from the triage queue in one motion.
function TenantCombobox(props: {
  value: string;
  onChange: (tenantId: string) => void;
  // Optional commit-and-remove callback. When set, the green check
  // button and suggestion clicks fire onAccept instead of onChange,
  // and the parent is expected to (a) record the assignment and (b)
  // remove the triage row. Tab/Enter still only previews so a typo
  // doesn't permanently move a file.
  onAccept?: (tenantId: string) => void;
  tenants: TenantPickerEntry[];
  recommendedId: string | null;
  placeholder?: string;
}) {
  const [query, setQuery] = useState(() => {
    const t = props.tenants.find((tt) => tt.tenant_id === props.value);
    return t?.display_name ?? "";
  });
  const [open, setOpen] = useState(false);

  const suggestions = useMemo(() => {
    if (!query.trim()) {
      const rec = props.tenants.find(
        (t) => t.tenant_id === props.recommendedId,
      );
      const others = props.tenants.filter(
        (t) => t.tenant_id !== props.recommendedId,
      );
      return rec ? [rec, ...others] : others;
    }
    const q = normalize(query);
    return props.tenants
      .map((t) => {
        const name = normalize(t.display_name);
        let score = 0;
        if (name.startsWith(q)) score = 1000 + (props.recommendedId === t.tenant_id ? 1 : 0);
        else if (name.includes(q)) score = 500 + (props.recommendedId === t.tenant_id ? 1 : 0);
        else {
          for (const token of q.split(/\s+/)) {
            if (token.length >= 3 && name.includes(token)) score += 100;
          }
        }
        return { tenant: t, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.tenant);
  }, [query, props.tenants, props.recommendedId]);

  const selected = props.tenants.find((t) => t.tenant_id === props.value);

  // Tab/Enter behavior: set the value to the top suggestion but DON'T
  // commit. Lets the analyst correct a typo before locking it in.
  function previewTop() {
    const top = suggestions[0];
    if (!top) {
      toast.error("No matching tenant. Type more or pick from the list.");
      return;
    }
    props.onChange(top.tenant_id);
    setQuery(top.display_name);
    setOpen(false);
  }

  // Green check button / suggestion click behavior: commit. When the
  // parent supplies onAccept, that handler moves the file to its
  // tenant and pops the row off the triage queue.
  function acceptTop() {
    const top = suggestions[0];
    if (!top) {
      toast.error("No matching tenant. Type more or pick from the list.");
      return;
    }
    if (props.onAccept) {
      props.onAccept(top.tenant_id);
    } else {
      props.onChange(top.tenant_id);
      setQuery(top.display_name);
    }
    setOpen(false);
  }

  return (
    <div className="relative">
      <div className="flex gap-1">
        <Input
          value={query}
          placeholder={props.placeholder ?? "Type to search"}
          className={selected ? "border-emerald-500 focus-visible:ring-emerald-500/30" : ""}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Tab" || e.key === "Enter") {
              if (suggestions.length > 0) {
                e.preventDefault();
                previewTop();
              }
            } else if (e.key === "Escape") {
              setQuery(selected?.display_name ?? "");
              setOpen(false);
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          variant={selected ? "secondary" : "outline"}
          onClick={acceptTop}
          title={props.onAccept ? "Accept and remove from list" : "Accept"}
          className="shrink-0"
        >
          <Check className="h-4 w-4" />
        </Button>
      </div>
      {open && suggestions.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-auto rounded-md border bg-popover shadow-md">
          {suggestions.slice(0, 12).map((t, i) => (
            <button
              key={t.tenant_id}
              type="button"
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent ${
                i === 0 ? "bg-accent/30" : ""
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                if (props.onAccept) {
                  props.onAccept(t.tenant_id);
                } else {
                  props.onChange(t.tenant_id);
                  setQuery(t.display_name);
                }
                setOpen(false);
              }}
            >
              <span className="font-mono text-xs text-neutral-500">row {t.row}</span>
              <span className="flex-1 truncate">{t.display_name}</span>
              {t.tenant_id === props.recommendedId && (
                <Badge variant="secondary">suggested</Badge>
              )}
              {i === 0 && (
                <span className="ml-1 rounded border px-1 text-[10px] uppercase text-neutral-500">
                  tab
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TriageCard(props: {
  entries: TriageEntry[];
  tenants: TenantPickerEntry[];
  onChange: (id: string, patch: Partial<TriageEntry>) => void;
  onRemove: (id: string) => void;
  onConfirm: () => void;
  onAcceptOne: (entryId: string, tenantId: string) => void;
}) {
  // The row whose preview is currently expanded. Only one expands
  // at a time so we don't load every PDF simultaneously; clicking
  // another row replaces the preview underneath it.
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
          Type the tenant name, press Tab to preview the top match,
          then click the green check to accept. The row leaves the
          list the moment you accept it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Tenant</TableHead>
                <TableHead>Level</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.entries.map((e) => (
                <Fragment key={e.id}>
                  <TableRow
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
                      className="min-w-72"
                    >
                      <TenantCombobox
                        value={e.assigned_tenant_id ?? ""}
                        onChange={(v) =>
                          props.onChange(e.id, { assigned_tenant_id: v })
                        }
                        onAccept={(tenantId) =>
                          props.onAcceptOne(e.id, tenantId)
                        }
                        tenants={props.tenants}
                        recommendedId={e.recommended_tenant_id}
                        placeholder="Type to search"
                      />
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
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-9 w-9 p-0 text-neutral-500 hover:text-red-600"
                        onClick={() => props.onRemove(e.id)}
                        title="Remove from triage"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                  {previewId === e.id && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={4} className="p-0">
                        <div className="border-y bg-neutral-50 p-3">
                          {e.kind === "pdf" ? (
                            <iframe
                              key={e.id}
                              src={previewUrl}
                              className="h-[800px] w-full rounded border bg-white"
                              title={e.name}
                            />
                          ) : (
                            <div className="h-[800px] w-full">
                              <ExcelPreviewTable key={e.id} file={e.file} />
                            </div>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="flex justify-end">
          <Button onClick={props.onConfirm}>Confirm assignments</Button>
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
  onSetUnits: (row: number, fileId: string, units: UnitsOverride) => void;
  onPreviewFile: (file: TenantFile) => void;
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
              onSetUnits={props.onSetUnits}
              onPreviewFile={props.onPreviewFile}
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
  onSetUnits: (row: number, fileId: string, units: UnitsOverride) => void;
  onPreviewFile: (file: TenantFile) => void;
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
              className="flex items-center justify-between gap-2 rounded border bg-neutral-50 px-2.5 py-1.5 transition-colors hover:border-primary hover:bg-blue-50"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => props.onPreviewFile(f)}
                title="Click to preview"
              >
                <Badge variant="outline" className="uppercase">
                  {f.kind}
                </Badge>
                <span className="truncate text-xs text-neutral-700">{f.name}</span>
              </button>
              <span className="flex shrink-0 items-center gap-1.5">
                <select
                  value={f.unitsOverride}
                  onChange={(event) =>
                    props.onSetUnits(
                      state.tenant.row,
                      f.id,
                      event.target.value as UnitsOverride,
                    )
                  }
                  className="h-6 border-0 bg-transparent text-[10px] text-neutral-600 outline-none"
                  title="Source units"
                  disabled={props.running}
                >
                  <option value="auto">Units: auto</option>
                  <option value="dollars">Units: $</option>
                  <option value="thousands">Units: $000</option>
                  <option value="millions">Units: $mm</option>
                </select>
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
  analystName: string;
  onAnalystNameChange: (name: string) => void;
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
      <CardContent className="flex flex-wrap items-end gap-3">
        <div className="w-56 space-y-1.5">
          <label htmlFor="analyst-name" className="text-sm font-medium">
            Analyst
          </label>
          <Input
            id="analyst-name"
            value={props.analystName}
            onChange={(event) => props.onAnalystNameChange(event.target.value)}
            autoComplete="name"
          />
        </div>
        <Button
          onClick={props.onRunAll}
          disabled={props.running || props.writing || props.loadedCount === 0}
        >
          {props.running ? "Running…" : `Extract & compute (${props.loadedCount})`}
        </Button>
        <Button
          onClick={props.onWriteAll}
          disabled={
            props.running ||
            props.writing ||
            props.readyCount === 0 ||
            props.analystName.trim().length < 2
          }
          variant={props.readyCount > 0 ? "default" : "outline"}
        >
          {props.writing ? "Writing…" : `Write ${props.readyCount} to ${props.quarterLabel}`}
        </Button>
      </CardContent>
    </Card>
  );
}

function ResultsTable(props: {
  rows: TenantState[];
  quarterId: QuarterId;
  onApprovalChange: (row: number, approved: boolean) => void;
  onIncludeAnyway: (
    row: number,
    excludedFile: ExcludedFile,
    reason: string,
  ) => void;
}) {
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
              <TableHead className="text-center">Approved</TableHead>
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
              const merged = mergeLineItems(s.extracts, props.quarterId);
              const excludedReasons = new Map(
                merged.excludedExtracts.map(({ extract, reason }) => [
                  extract.source_file_hash,
                  reason,
                ]),
              );
              const canApprove = c.sales !== null && c.ebitda !== null;
              return (
                <Fragment key={s.tenant.row}>
                  <TableRow>
                    <TableCell className="max-w-64 truncate">
                      {s.tenant.display_name}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums text-neutral-500">
                      {s.files.length}
                      {corpCount > 0 ? ` (${corpCount}C)` : ""}
                    </TableCell>
                    {WRITABLE_METRICS.map((metric) => (
                      <TableCell
                        key={metric}
                        className="text-right font-mono tabular-nums"
                      >
                        {fmtMetric(c[metric])}
                      </TableCell>
                    ))}
                    <TableCell className="text-right font-mono tabular-nums">
                      {margin === null ? "—" : `${margin.toFixed(1)}%`}
                    </TableCell>
                    <TableCell className="text-center">
                      <input
                        type="checkbox"
                        checked={s.approved}
                        disabled={!canApprove}
                        onChange={(event) =>
                          props.onApprovalChange(
                            s.tenant.row,
                            event.target.checked,
                          )
                        }
                        aria-label={`Approve ${s.tenant.display_name}`}
                        className="h-4 w-4 accent-emerald-700"
                      />
                    </TableCell>
                  </TableRow>
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={11} className="bg-neutral-50 py-2">
                      <details>
                        <summary className="cursor-pointer text-xs font-medium text-neutral-700">
                          Sources, exclusions, and calculation trace
                        </summary>
                        <div className="mt-3 space-y-3 text-xs">
                          <div className="space-y-1">
                            {s.extracts.map((extract) => {
                              const exclusion = excludedReasons.get(
                                extract.source_file_hash,
                              );
                              return (
                                <p key={extract.source_file_hash}>
                                  <span className="font-mono">
                                    {extract.source_filename}
                                  </span>{" "}
                                  <Badge
                                    variant={exclusion ? "outline" : "secondary"}
                                  >
                                    {exclusion ? "excluded" : "included"}
                                  </Badge>{" "}
                                  {extract.source_period} · {extract.source_scope} ·{" "}
                                  {extract.source_units} · {extract.period_selection}
                                  {exclusion ? ` · ${exclusion}` : ""}
                                </p>
                              );
                            })}
                            {s.excludedFiles.map((file) => (
                              <IncludeAnywayRow
                                key={file.file_id}
                                file={file}
                                onIncludeAnyway={(reason) =>
                                  props.onIncludeAnyway(s.tenant.row, file, reason)
                                }
                              />
                            ))}
                          </div>
                          <div className="grid gap-2 md:grid-cols-2">
                            {WRITABLE_METRICS.map((metric) => {
                              const trace = c.metrics[metric];
                              return (
                                <div key={metric} className="border-t pt-2">
                                  <p className="font-medium">
                                    {METRIC_LABELS[metric]}: {trace.formula}
                                  </p>
                                  {trace.contributions.map((item, index) => (
                                    <p
                                      key={`${item.label}-${index}`}
                                      className="font-mono text-neutral-600"
                                    >
                                      {item.label}: {item.amount_source.toLocaleString()} →{" "}
                                      {item.amount_tracker.toLocaleString()} ({item.reason})
                                    </p>
                                  ))}
                                </div>
                              );
                            })}
                          </div>
                          {c.unused_labels.length > 0 && (
                            <p className="text-amber-800">
                              Unmatched: {c.unused_labels.join(", ")}
                            </p>
                          )}
                        </div>
                      </details>
                    </TableCell>
                  </TableRow>
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// Per-file "Include anyway" escape hatch for a period-mismatch
// exclusion (SOURCE_PERIOD_OUTSIDE_QUARTER, or an unparseable period).
// A distinct click plus a required reason — never automatic — mirrors
// the existing entity-mismatch override, which likewise demands an
// explicit analyst-supplied reason before the mismatch is allowed
// through. Collapsed behind a toggle so the exclusion list stays
// scannable when nothing needs overriding.
function IncludeAnywayRow(props: {
  file: ExcludedFile;
  onIncludeAnyway: (reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <div className="rounded border border-dashed border-amber-300 bg-amber-50 px-2 py-1.5">
      <p>
        <span className="font-mono">{props.file.filename}</span>{" "}
        <Badge variant="outline">excluded</Badge>{" "}
        {props.file.source_period} · {props.file.reason}
      </p>
      {!open ? (
        <button
          type="button"
          className="mt-1 text-[11px] font-medium text-amber-800 underline underline-offset-2 hover:text-amber-900"
          onClick={() => setOpen(true)}
        >
          Include anyway
        </button>
      ) : (
        <div className="mt-1.5 flex items-center gap-1.5">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason this file should be included despite the period mismatch"
            className="h-7 text-xs"
          />
          <Button
            size="sm"
            className="h-7"
            disabled={reason.trim().length === 0}
            onClick={() => {
              props.onIncludeAnyway(reason.trim());
              setOpen(false);
              setReason("");
            }}
          >
            Confirm
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            onClick={() => {
              setOpen(false);
              setReason("");
            }}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

function HistoryCard(props: {
  runs: RunSummary[];
  loading: boolean;
  onRefresh: () => void;
}) {
  // Collapsed by default so it doesn't dominate the first-paint
  // layout; the analyst clicks to expand and see the past runs.
  // The state itself isn't persisted (it's just a disclosure
  // affordance), but the underlying runs are pulled from Firestore
  // on every mount so a page reload doesn't lose them.
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2 text-left"
        >
          <div>
            <CardTitle>History</CardTitle>
            <CardDescription>
              Every committed write-back. Persists across reloads.
            </CardDescription>
          </div>
          <span className="font-mono text-xs text-neutral-500">
            {open ? "hide" : `show (${props.runs.length})`}
          </span>
        </button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3 overflow-x-auto">
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={props.onRefresh}
              disabled={props.loading}
            >
              {props.loading ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
          {props.runs.length === 0 ? (
            <p className="rounded border border-dashed border-neutral-200 px-4 py-6 text-center text-xs text-neutral-500">
              No runs yet.
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
                  <TableHead>Flags</TableHead>
                  <TableHead>By</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {props.runs.map((r) => {
                  // Previously written but never read back: unused_labels
                  // and worker_warnings sat in Firestore invisibly once a
                  // run left the current browser session. Surface a count
                  // with the detail in a native tooltip rather than
                  // building a full drill-down view.
                  const flags = [
                    ...r.unused_labels.map((l) => `dropped: ${l}`),
                    ...r.worker_warnings.map((w) => `warning: ${w}`),
                  ];
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">
                        {r.created_at != null
                          ? new Date(r.created_at).toLocaleString()
                          : "—"}
                      </TableCell>
                      <TableCell>{r.source_entity || r.tenant_id}</TableCell>
                      <TableCell>{r.quarter}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {r.computed_sales.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {r.computed_ebitda.toLocaleString()}
                      </TableCell>
                      <TableCell>
                        {r.status === "writeback_success" ? (
                          <Badge variant="secondary">OK</Badge>
                        ) : r.status === "writeback_pending" ? (
                          <Badge variant="outline">Pending</Badge>
                        ) : (
                          <Badge variant="destructive">Failed</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {flags.length > 0 ? (
                          <Badge variant="outline" title={flags.join("\n")}>
                            {flags.length}
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-xs text-neutral-600">
                        {r.written_by}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function FilePreviewSheet(props: {
  file: TenantFile | null;
  onClose: () => void;
}) {
  // useMemo recomputes the blob URL only when the underlying File
  // changes; without it, every parent re-render would create a new
  // URL and the iframe would flicker. The previous URL is released
  // by the browser's blob registry when the component unmounts or
  // the URL value is replaced.
  const url = useMemo(
    () => (props.file ? URL.createObjectURL(props.file.file) : ""),
    [props.file],
  );
  const open = props.file !== null;
  return (
    <Sheet open={open} onOpenChange={(v) => !v && props.onClose()}>
      <SheetContent className="w-full sm:max-w-2xl">
        {props.file && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <Badge variant="outline" className="uppercase">
                  {props.file.kind}
                </Badge>
                <span className="truncate">{props.file.name}</span>
              </SheetTitle>
              <SheetDescription>
                {formatBytes(props.file.file.size)} ·{" "}
                {props.file.level === "corporate"
                  ? "Corporate level"
                  : "Tenant level"}
              </SheetDescription>
            </SheetHeader>
            <div className="h-[calc(100vh-7rem)] px-4 pb-4">
              {props.file.kind === "pdf" ? (
                <iframe
                  src={url}
                  className="h-full w-full rounded border bg-white"
                  title={props.file.name}
                />
              ) : (
                <ExcelPreviewTable
                  key={props.file.name}
                  file={props.file.file}
                />
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function fmtMetric(n: number | null): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString();
}
