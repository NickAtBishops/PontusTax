// Shared knowledge of the Corp Financials sheet's column structure.
//
// The sheet repeats the same 18-column "section" layout (13 quarterly +
// 4 annual + 1 LTM) for every metric: Sales, EBITDA, EBITDA Margin,
// Interest, Rent, EBITDAR, Op Lease Debt, B/S Debt, Total Debt, Cash,
// CFO, Capex, FCF, and several leverage ratios. The Margin / EBITDAR /
// Total Debt / FCF / leverage sections are formula-driven; the engine
// only writes into the seven raw-metric sections (Sales, EBITDA,
// Interest, Rent, Cash, CFO, Capex).
//
// Why this lives in TypeScript: the worker is meant to be a dumb,
// stateless cell-writer. All knowledge of layout, tenants, and
// quarters lives on the Next.js side so the worker can stay generic.

// Header note: cell AI3 in the actual spreadsheet reads "Q4 26" instead
// of "Q1 26" — a typo in the source, not in this code. The writer
// accepts the typo on the EBITDA section for Q1 2026 only and emits
// a warning rather than refusing the write.
const Q1_2026_EBITDA_HEADER_TYPO = "Q4 26";

export const TRACKER_LAYOUT = {
  // Trailing space is part of the sheet name. ExcelJS / openpyxl are
  // both whitespace-sensitive on sheet lookups, so this constant must
  // match the source exactly.
  sheet_name: "Corp Financials ",
  // Row that carries the quarter labels ("Q1 23", "Q2 23", ...).
  header_row: 3,
  // How many quarterly columns each section has before the annual /
  // LTM columns start. Q1 23 through Q1 26 = 13.
  quarterly_columns: 13,
  // 1-indexed column where each writable section starts. Pulled off
  // row 1 of the sample workbook (the section title row).
  section_starts: {
    sales: 5,      // E
    ebitda: 23,    // W
    interest: 59,  // BG
    rent: 77,      // BY
    cash: 167,     // FK
    cfo: 185,      // GC
    capex: 203,    // GU
  },
} as const;

export type QuarterId =
  | "Q1_2023" | "Q2_2023" | "Q3_2023" | "Q4_2023"
  | "Q1_2024" | "Q2_2024" | "Q3_2024" | "Q4_2024"
  | "Q1_2025" | "Q2_2025" | "Q3_2025" | "Q4_2025"
  | "Q1_2026";

// Order matters: index in this list is the column offset from each
// section's start column. Extending the tracker into Q2 2026 and beyond
// means appending entries here AND adding columns to the xlsx (the
// engine refuses to write past the last known offset).
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

// The seven raw-metric sections the engine writes to. Margin, EBITDAR,
// Total Debt, FCF, and the leverage / FCCR ratios live between these
// sections and are tracker formulas; never written by code.
export const WRITABLE_METRICS = [
  "sales",
  "ebitda",
  "interest",
  "rent",
  "cash",
  "cfo",
  "capex",
] as const;
export type MetricKey = (typeof WRITABLE_METRICS)[number];

// Human-readable label for the picker / results table.
export const METRIC_LABELS: Record<MetricKey, string> = {
  sales: "Sales",
  ebitda: "EBITDA",
  interest: "Interest",
  rent: "Rent",
  cash: "Cash",
  cfo: "CFO",
  capex: "Capex",
};

export type MetricCell = {
  metric: MetricKey;
  // 1-indexed column in the Corp Financials sheet.
  col: number;
  // The text the header row should carry for this column.
  header_expected: string;
  // Optional alternate header the writer should also accept (only set
  // for EBITDA Q1 26 today, where AI3 = "Q4 26" in the source).
  header_alternate: string | null;
};

export type TrackerTarget = {
  sheet_name: string;
  header_row: number;
  // One entry per writable metric, in WRITABLE_METRICS order.
  cells: MetricCell[];
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
  const isQ1_2026 = quarterId === "Q1_2026";

  // Build the cells array in the order WRITABLE_METRICS declares so
  // the writer can iterate metrics deterministically and the audit log
  // keeps a stable column order.
  const cells: MetricCell[] = WRITABLE_METRICS.map((metric) => ({
    metric,
    col: TRACKER_LAYOUT.section_starts[metric] + idx,
    header_expected: entry.label,
    // The Q1 26 EBITDA column header has a typo in the source xlsx
    // (AI3 = "Q4 26" instead of "Q1 26"). The writer accepts either
    // for that one cell and reports it as a soft warning.
    header_alternate:
      metric === "ebitda" && isQ1_2026 ? Q1_2026_EBITDA_HEADER_TYPO : null,
  }));

  return {
    sheet_name: TRACKER_LAYOUT.sheet_name,
    header_row: TRACKER_LAYOUT.header_row,
    cells,
  };
}

export const ALL_QUARTER_IDS: QuarterId[] = QUARTER_ORDER.map((q) => q.id);
export function quarterLabel(id: QuarterId): string {
  const entry = QUARTER_ORDER.find((q) => q.id === id);
  if (!entry) throw new Error(`Unknown quarter_id "${id}".`);
  return entry.label;
}

