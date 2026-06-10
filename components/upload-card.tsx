"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileSpreadsheet, UploadCloud, X } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth-provider";
import { authedFetch, readError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function UploadCard() {
  const router = useRouter();
  const { getToken } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  function pick(f: File | undefined | null) {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".xlsx")) {
      toast.error("Only .xlsx workbooks are supported");
      return;
    }
    setFile(f);
  }

  async function start() {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await authedFetch(getToken, "/api/runs", {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      const run = await res.json();
      if (run.trigger && !run.trigger.triggered) {
        toast.warning("Run queued — worker not auto-started", {
          description: run.trigger.detail,
          duration: 10000,
        });
      } else {
        toast.success("Run started");
      }
      router.push(`/runs/${run.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="gap-4 p-5 shadow-none">
      <div>
        <h2 className="text-sm font-semibold">Check a tracker</h2>
        <p className="text-sm text-muted-foreground">
          Upload a property-tax Excel tracker. Every row is looked up on its
          county portal and a checked copy is produced — the original is never
          modified.
        </p>
      </div>

      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files?.[0]);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center transition-colors",
          dragging
            ? "border-primary bg-blue-50"
            : "border-border hover:border-neutral-300 hover:bg-accent/50",
        )}
      >
        <UploadCloud className="h-5 w-5 text-muted-foreground" />
        <p className="text-sm">
          Drop an <span className="font-medium">.xlsx</span> tracker here, or
          click to browse
        </p>
        <p className="text-xs text-muted-foreground">
          e.g. “Property Taxes- Florida.xlsx” — any state, any layout
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          onChange={(e) => pick(e.target.files?.[0])}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        {file ? (
          <span className="inline-flex min-w-0 items-center gap-2 rounded-md border bg-accent/50 px-2.5 py-1.5 text-xs">
            <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
            <span className="truncate font-medium">{file.name}</span>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setFile(null)}
              aria-label="Remove file"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            No file selected
          </span>
        )}
        <Button onClick={start} disabled={!file || busy}>
          {busy ? "Uploading…" : "Check property taxes"}
        </Button>
      </div>
    </Card>
  );
}
