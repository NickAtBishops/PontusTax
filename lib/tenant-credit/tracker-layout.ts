// Shared knowledge of the Corp Financials sheet's column structure.
// Used by the writeback route to translate a (tenant, quarter) pair into
// the exact (row, column) cells the Python worker should write.
//
// Why this lives in TypeScript (not in the worker): the worker is meant
// to be a dumb, stateless cell-writer. All knowledge of layout, tenants,
// and quarters lives on the Next.js side so the worker can be re-used
// across tools without dragging the credit-tracker schema with it.
//
// Verified against samples/Corporate_Financials_and_P_Ls.xlsx via the
// Phase 1 openpyxl inspection (see the report at the end of Phase 1).

// Header note: cell AI3 in the actual spreadsheet reads "Q4 26" instead
// of "Q1 26" — a typo in the source, not in this code. The cell
// ordering is otherwise consistent (col 35 sits right after Q4 25 at
// col 34). The worker logs a warning when it encounters this header
// rather than refusing the write.
const Q1_2026_EBITDA_HEADER_TYPO = "Q4 26";

export const TRACKER_LAYOUT = {
  // Trailing space is part of the sheet name. openpyxl is whitespace-
  // sensitive on sheet lookups so this constant must match exactly.
  sheet_name: "Corp Financials ",
  // First quarterly column for each section. Sales starts at E (5).
  // EBITDA starts at W (23). Both have 13 quarterly columns (Q1 23 to
  // Q1 26), then 4 annual columns, then an LTM column.
  sales_quarterly_start_col: 5,
  ebitda_quarterly_start_col: 23,
  quarterly_columns: 13,
  // Row index that carries the column labels ("Q1 23", "Q2 23", ...).
  header_row: 3,
} as const;

export type QuarterId =
  | "Q1_2023" | "Q2_2023" | "Q3_2023" | "Q4_2023"
  | "Q1_2024" | "Q2_2024" | "Q3_2024" | "Q4_2024"
  | "Q1_2025" | "Q2_2025" | "Q3_2025" | "Q4_2025"
  | "Q1_2026";

// Order matters: index in this list is the column offset from the
// section start column. Extending the tracker into Q2 2026 and beyond
// would mean appending entries here AND adding columns to the xlsx.
const QUARTER_ORDER: { id: QuarterId; label: string }[] = [
  { id: "Q1_2023", label: "Q1 23" },
  { id: "Q2_2023", label: "Q2 23" },
  { id: "Q3_2023", label: "Q3 23" },
  { id: "Q4_2023", label: "Q4 23" },
  { id: "Q1_2024", label: "Q1 24" },
  { id: "Q2_2024", label: "Q2 24" },
  { id: "Q3_2024", label: "Q3 24" },
  { id: "Q4_2024", label: "Q4 24" },
  { id: "Q1_2025", label: "Q1 25" },
  { id: "Q2_2025", label: "Q2 25" },
  { id: "Q3_2025", label: "Q3 25" },
  { id: "Q4_2025", label: "Q4 25" },
  { id: "Q1_2026", label: "Q1 26" },
];

export type TrackerTarget = {
  sheet_name: string;
  header_row: number;
  sales_col: number;
  ebitda_col: number;
  // The row-3 label the worker should expect to find above the Sales
  // column. Mismatch is a hard error (wrong column entirely).
  sales_header_expected: string;
  // Same for EBITDA, plus an alternate to tolerate the AI3 "Q4 26"
  // typo for Q1 26 specifically. The worker warns on the alternate
  // but doesn't refuse the write.
  ebitda_header_expected: string;
  ebitda_header_alternate: string | null;
};

export function trackerColumnsForQuarter(quarterId: QuarterId): TrackerTarget {
  const idx = QUARTER_ORDER.findIndex((q) => q.id === quarterId);
  if (idx === -1) {
    throw new Error(
      `Unknown quarter_id "${quarterId}". Known: ` +
        `[${QUARTER_ORDER.map((q) => q.id).join(", ")}].`,
    );
  }
  const entry = QUARTER_ORDER[idx];

  // The Q1 26 EBITDA column header has a typo in the source xlsx
  // (AI3 = "Q4 26" instead of "Q1 26"). For that specific quarter, the
  // worker accepts either label and logs the typo. Every other quarter
  // is strict.
  const ebitdaAlternate =
    quarterId === "Q1_2026" ? Q1_2026_EBITDA_HEADER_TYPO : null;

  return {
    sheet_name: TRACKER_LAYOUT.sheet_name,
    header_row: TRACKER_LAYOUT.header_row,
    sales_col: TRACKER_LAYOUT.sales_quarterly_start_col + idx,
    ebitda_col: TRACKER_LAYOUT.ebitda_quarterly_start_col + idx,
    sales_header_expected: entry.label,
    ebitda_header_expected: entry.label,
    ebitda_header_alternate: ebitdaAlternate,
  };
}

export const ALL_QUARTER_IDS: QuarterId[] = QUARTER_ORDER.map((q) => q.id);
export function quarterLabel(id: QuarterId): string {
  const entry = QUARTER_ORDER.find((q) => q.id === id);
  if (!entry) throw new Error(`Unknown quarter_id "${id}".`);
  return entry.label;
}

// Which quarters are currently writable for a given tenant. The worker
// also enforces this defensively (it refuses to overwrite a populated
// cell), but filtering the dashboard picker prevents the analyst from
// triggering that refusal in the first place - the foot-gun would
// otherwise surface as a raw "target cell already holds X" toast.
//
// Hardcoded per-tenant for Phase 6. When more tenants are added in
// Phase 8, this can be derived dynamically by inspecting which cells
// in each tenant's row are empty. The hardcoded approach makes the
// initial demo predictable.
const WRITABLE_QUARTERS: Record<string, QuarterId[]> = {
  // Pinnacle row 14: Q1 23 through Q4 25 already have values or
  // formulas (verified during Phase 1 inspection). Only Q1 26 is open.
  pinnacle: ["Q1_2026"],
};

export function writableQuartersForTenant(tenantId: string): QuarterId[] {
  return WRITABLE_QUARTERS[tenantId] ?? [];
}
