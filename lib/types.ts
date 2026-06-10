/**
 * Shared shapes for the tax_checker_* Firestore collections.
 * Field names are snake_case to match the documents (Pontus convention:
 * snake_case in Firestore, camelCase for TypeScript identifiers).
 */

export const ROW_STATUSES = [
  "PAID",
  "PARTIAL",
  "UNPAID",
  "DELINQUENT",
  "NEEDS_REVIEW",
  "UNREACHABLE",
] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];

export type RowState = "pending" | "in_progress" | RowStatus;

export type RunStatus =
  | "queued"
  | "running"
  | "writing_back"
  | "done"
  | "done_with_errors"
  | "failed"
  | "canceled";

export interface RunTotals {
  rows: number;
  processed: number;
  paid: number;
  partial: number;
  unpaid: number;
  delinquent: number;
  needs_review: number;
  unreachable: number;
  /** live $ still owed across all checked rows (sum of portal amount_due) */
  amount_due?: number;
}

export interface SheetMapping {
  name: string;
  header_row: number;
  group_header_row: number | null;
  data_row_count: number;
  /** canonical field -> column letter(s), e.g. { address: "A", amounts: "K,L,M" } */
  mapping: Record<string, string>;
  ambiguous: string[];
  protected_columns: string[];
}

export interface RunSummary {
  status_counts: Record<string, number>;
  new_playbooks: string[];
  review_rows: { sheet: string; row: number; reason: string }[];
  mapping_notes: string[];
  status_column_header: string | null;
  amount_column_header?: string | null;
  notes: string[];
}

export interface RunDoc {
  id: string;
  file_name: string;
  input_path: string;
  output_path: string | null;
  output_file_name: string | null;
  status: RunStatus;
  error: string | null;
  trigger_error: string | null;
  cancel_requested: boolean;
  requested_by: { uid: string; email: string | null };
  totals: RunTotals;
  sheets: SheetMapping[] | null;
  summary: RunSummary | null;
  created_at: unknown;
  updated_at: unknown;
  started_at: unknown | null;
  finished_at: unknown | null;
}

/** One account's canonical extraction record — CLAUDE.md §3. */
export interface AccountRecord {
  account_searched: string;
  tax_year: string | null;
  status: RowStatus;
  amount_billed: number | null;
  amount_paid: number | null;
  amount_due: number | null;
  date_paid: string | null;
  receipt: string | null;
  paid_by: string | null;
  assessed_value: number | null;
  next_due_date: string | null;
  prior_year_balance: boolean | null;
  page_timestamp: string | null;
  source_url: string | null;
  evidence: string | null;
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

export interface RowInput {
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  county: string | null;
  owner_entity: string | null;
  internal_id: string | null;
  account_raw: string | null;
  accounts: string[];
  tax_year: string | null;
  url: string | null;
  responsible_party: string | null;
}

export interface RowDoc {
  id: string;
  run_id: string;
  sheet_name: string;
  row_number: number;
  state: RowState;
  input: RowInput;
  accounts: AccountRecord[];
  row_status: RowStatus | null;
  status_note: string | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | null;
  evidence: string | null;
  needs_review_reason: string | null;
  skyvern: {
    run_ids: string[];
    recording_urls: string[];
    app_urls: string[];
  } | null;
  created_at: unknown;
  updated_at: unknown;
}

export const COLLECTIONS = {
  runs: "tax_checker_runs",
  playbooks: "tax_checker_playbooks",
  scrapeState: "tax_checker_scrape_state",
} as const;
