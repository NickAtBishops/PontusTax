// POST /api/tenant-credit/tenants
// Read column A of the corporate-financials xlsx the analyst uploads,
// return the tenant roster so the UI can populate its picker. Each
// returned entry tells the client two things:
//   - the row number to write to (matches the spreadsheet's own column-A
//     layout, which can drift across quarters as tenants are added or
//     reordered)
//   - whether we have a methodology recipe for that tenant yet. When
//     tenant_id is null the UI greys the row out: the dropdown still
//     lists the tenant so the analyst can see what's coming, but the
//     compute step would 400 with "Unknown tenant_id" today.
//
// Request:
//   multipart/form-data
//     tracker_xlsx: the corporate-financials workbook (required, .xlsx, <= 8 MB)
//
// Response 200:
//   { tenants: TenantPickerEntry[] }

import { NextResponse } from "next/server";
import ExcelJS from "exceljs";

import { TRACKER_LAYOUT } from "@/lib/tenant-credit/tracker-layout";

// The corporate-financials master xlsx is ~200 KB. Cap at 8 MB so a
// fat-finger upload of the wrong workbook (or a rich-media variant)
// doesn't tie up the function.
const MAX_TRACKER_BYTES = 8 * 1024 * 1024;

// What the dashboard renders for one row of the picker.
export type TenantPickerEntry = {
  // Column-A spelling exactly as the spreadsheet has it. Used as the
  // display label and round-tripped in the writeback payload so the
  // writer can sanity-check the row before writing.
  display_name: string;
  // 1-indexed row number in the Corp Financials sheet. Authoritative
  // for the writeback target cell.
  row: number;
  // Slug derived from the display name (lowercase, hyphenated). Used
  // as a stable key in the picker and on the audit-log records; the
  // generic engine doesn't need it for computation, but the audit
  // log shouldn't lose track of "which tenant did this run target".
  tenant_id: string;
};

// Build a slug like "fairfield-automotive-partners-llc" from the
// display name so each picker row has a stable, URL-safe identifier
// the audit log can sort and filter on. We strip punctuation and
// collapse whitespace.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Next.js function tuning. The tracker is small, but ExcelJS still
// needs Node APIs, and 60s gives us comfortable headroom over a cold
// start + a 1 MB read.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      {
        error:
          "Request body must be multipart/form-data with a `tracker_xlsx` file.",
      },
      { status: 400 },
    );
  }

  const file = form.get("tracker_xlsx");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Missing or invalid `tracker_xlsx` field. Must be an .xlsx upload." },
      { status: 400 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json(
      { error: "Uploaded tracker is empty." },
      { status: 400 },
    );
  }
  if (file.size > MAX_TRACKER_BYTES) {
    return NextResponse.json(
      {
        error:
          `Tracker is ${file.size} bytes; max accepted is ${MAX_TRACKER_BYTES}.`,
      },
      { status: 413 },
    );
  }

  let workbook: ExcelJS.Workbook;
  try {
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Could not parse the uploaded .xlsx: ${detail}` },
      { status: 400 },
    );
  }

  // The sheet name has a trailing space the openpyxl worker also
  // matches exactly; ExcelJS is whitespace-sensitive in the same way.
  const sheet = workbook.getWorksheet(TRACKER_LAYOUT.sheet_name);
  if (!sheet) {
    const seen = workbook.worksheets.map((w) => `"${w.name}"`).join(", ");
    return NextResponse.json(
      {
        error:
          `Tracker is missing the "${TRACKER_LAYOUT.sheet_name}" sheet ` +
          `(note the trailing space). Sheets seen: [${seen}].`,
      },
      { status: 422 },
    );
  }

  // Column A holds the tenant display name. Data starts on the row
  // AFTER the header row. We stop at the first run of consecutive
  // blank rows to avoid walking the long tail of empty rows ExcelJS
  // reports as "in use" because they carry merged/styled cells.
  const tenants: TenantPickerEntry[] = [];
  const startRow = TRACKER_LAYOUT.header_row + 1;
  const lastRow = Math.max(sheet.actualRowCount, sheet.rowCount, startRow);
  let blankStreak = 0;
  for (let r = startRow; r <= lastRow; r += 1) {
    const raw = sheet.getCell(r, 1).value;
    const text = cellText(raw);
    if (!text) {
      blankStreak += 1;
      // Three blank rows in a row = end of the roster. The Corp
      // Financials sheet has trailing styled-but-empty rows; without
      // this cap we'd serve hundreds of empty entries.
      if (blankStreak >= 3) break;
      continue;
    }
    blankStreak = 0;
    tenants.push({
      display_name: text,
      row: r,
      tenant_id: slugify(text),
    });
  }

  return NextResponse.json({ tenants });
}

// ExcelJS cell.value can be a string, number, Date, formula object, or
// rich-text array. The roster is plain text so we coerce defensively.
function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || value instanceof Date) {
    return String(value).trim();
  }
  if (typeof value === "object") {
    // Rich-text: { richText: [{ text: "..." }, ...] }
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((r) => r.text ?? "").join("").trim();
    }
    // Formula cells: { result: ..., formula: ... }
    if ("result" in value) return cellText(value.result as ExcelJS.CellValue);
    // Hyperlink cells: { text: "Label", hyperlink: "..." }
    if ("text" in value && typeof value.text === "string") {
      return value.text.trim();
    }
  }
  return "";
}
