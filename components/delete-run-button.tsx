"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { readError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const ACTIVE = ["queued", "running", "writing_back"];

/** Delete a run and everything attached to it, behind a destructive confirm.
 *  `icon` = trash button for table rows; `full` = labeled button for headers.
 *  Active runs can't be deleted (cancel first) — the button is disabled. */
export function DeleteRunButton({
  runId,
  fileName,
  status,
  variant = "icon",
  onDeleted,
}: {
  runId: string;
  fileName: string;
  status?: string;
  variant?: "icon" | "full";
  onDeleted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = ACTIVE.includes(status ?? "");

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch(`/api/runs/${runId}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      toast.success("Run deleted");
      setOpen(false);
      onDeleted?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  const tooltip = active ? "Cancel the run before deleting" : "Delete run";

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      {variant === "icon" ? (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-red-600"
          disabled={active}
          title={tooltip}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
        >
          <Trash2 className="h-4 w-4" />
          <span className="sr-only">Delete run</span>
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={active}
          title={active ? tooltip : undefined}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
        >
          <Trash2 className="h-4 w-4" />
          Delete
        </Button>
      )}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this run?</AlertDialogTitle>
          <AlertDialogDescription>
            “{fileName}” and everything attached to it — the uploaded workbook,
            the checked output, and all per-row results — will be permanently
            removed. This can’t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            className="bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-600"
            onClick={(e) => {
              // preventDefault keeps the dialog open while the delete runs;
              // remove() closes it on success.
              e.preventDefault();
              remove();
            }}
          >
            {busy ? "Deleting…" : "Delete run"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
