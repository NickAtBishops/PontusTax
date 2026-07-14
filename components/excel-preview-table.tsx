"use client";

// Renders an uploaded .xlsx File as a scrollable, read-only table —
// the Excel equivalent of the PDF <iframe> preview used elsewhere in
// the tenant-credit UI. exceljs is already a project dependency (the
// writeback API route uses it server-side); dynamic-imported here so
// it doesn't bloat the initial page bundle.

import { useEffect, useState } from "react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

// Defensive caps — tenant P&L uploads are normal-sized statements, not
// the 200+ column master tracker, but a stray huge file should degrade
// to "truncated" rather than freeze the tab rendering a giant table.
const MAX_ROWS = 300;
const MAX_COLS = 40;

type SheetData = { name: string; rows: string[][]; truncated: boolean };

function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toLocaleString() : value.toString();
  }
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toLocaleDateString();
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.richText)) {
      return (v.richText as { text?: string }[])
        .map((r) => r.text ?? "")
        .join("");
    }
    if (typeof v.text === "string") return v.text;
    if (v.result != null) return cellText(v.result);
  }
  return String(value);
}

// Callers pass a `key` derived from file identity (see call sites) so
// React remounts this component — and its state starts fresh — every
// time the previewed file changes, instead of resetting state
// synchronously inside the effect.
export function ExcelPreviewTable({ file }: { file: File }) {
  const [sheets, setSheets] = useState<SheetData[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ExcelJS = (await import("exceljs")).default;
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(await file.arrayBuffer());
        const parsed: SheetData[] = wb.worksheets.map((ws) => {
          let maxCol = 0;
          ws.eachRow({ includeEmpty: false }, (row) => {
            maxCol = Math.max(maxCol, row.cellCount);
          });
          const colCount = Math.min(maxCol, MAX_COLS);
          const rows: string[][] = [];
          let rowCount = 0;
          let hitRowCap = false;
          ws.eachRow({ includeEmpty: false }, (row) => {
            if (rowCount >= MAX_ROWS) {
              hitRowCap = true;
              return;
            }
            rowCount += 1;
            const cells: string[] = [];
            for (let c = 1; c <= colCount; c++) {
              cells.push(cellText(row.getCell(c).value));
            }
            rows.push(cells);
          });
          return {
            name: ws.name,
            rows,
            truncated: hitRowCap || maxCol > MAX_COLS,
          };
        });
        if (!cancelled) setSheets(parsed.filter((s) => s.rows.length > 0));
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Could not read this file.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center rounded border bg-neutral-50 p-4 text-center text-sm text-neutral-600">
        Couldn&apos;t render this file as a table: {error}
      </div>
    );
  }
  if (!sheets) {
    return (
      <div className="flex h-full items-center justify-center rounded border bg-neutral-50 text-sm text-neutral-500">
        Reading workbook…
      </div>
    );
  }
  if (sheets.length === 0) {
    return (
      <div className="flex h-full items-center justify-center rounded border bg-neutral-50 text-sm text-neutral-500">
        This workbook has no non-empty sheets.
      </div>
    );
  }

  const body = (sheet: SheetData) => (
    <div className="h-full overflow-auto rounded border bg-white">
      <table className="border-collapse text-xs">
        <tbody>
          {sheet.rows.map((row, ri) => (
            <tr key={ri}>
              <td className="sticky left-0 z-10 border-b border-r bg-neutral-100 px-2 py-1 text-right font-mono text-neutral-400">
                {ri + 1}
              </td>
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className="whitespace-nowrap border-b border-r px-2 py-1 font-mono"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {sheet.truncated && (
        <p className="sticky left-0 w-fit bg-amber-50 px-2 py-1 text-xs text-amber-700">
          Preview truncated at {MAX_ROWS} rows / {MAX_COLS} columns — download
          the file to see the rest.
        </p>
      )}
    </div>
  );

  if (sheets.length === 1) {
    return <div className="h-full">{body(sheets[0])}</div>;
  }

  return (
    <Tabs defaultValue={sheets[0].name} className="h-full">
      <TabsList variant="line">
        {sheets.map((s) => (
          <TabsTrigger key={s.name} value={s.name}>
            {s.name}
          </TabsTrigger>
        ))}
      </TabsList>
      {sheets.map((s) => (
        <TabsContent key={s.name} value={s.name} className="h-[calc(100%-2.5rem)]">
          {body(s)}
        </TabsContent>
      ))}
    </Tabs>
  );
}
