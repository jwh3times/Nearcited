import type { z } from "zod";
import { type AccountExport, AccountExportSchema } from "./schemas";

/** Each list in the export, and the spreadsheet it is written to. The organization is one row. */
export const EXPORT_SHEETS = {
  organization: "organization.csv",
  members: "members.csv",
  locations: "locations.csv",
  prompts: "prompts.csv",
  scans: "scans.csv",
  answers: "answers.csv",
  tasks: "tasks.csv",
  alerts: "alerts.csv",
  drafts: "drafts.csv",
  actions: "actions.csv",
  standing_permissions: "standing-permissions.csv",
  connections: "connections.csv",
  listings: "listings.csv",
  page_addresses: "page-addresses.csv",
  visits: "visits.csv",
  hosted_pages: "hosted-pages.csv",
  page_fetches: "page-fetches.csv",
} as const satisfies Partial<Record<keyof AccountExport, string>>;

export type ExportList = keyof typeof EXPORT_SHEETS;

/** The columns of a schema's rows. A row that comes in kinds has every column any kind has. */
function columnsOf(schema: z.ZodType): string[] {
  const def = schema as unknown as {
    shape?: Record<string, unknown>;
    options?: { shape: Record<string, unknown> }[];
    element?: z.ZodType;
  };
  if (def.element) return columnsOf(def.element);
  if (def.options) return [...new Set(def.options.flatMap((option) => Object.keys(option.shape)))];
  if (def.shape) return Object.keys(def.shape);
  // A schema wrapped some other way would give a spreadsheet no columns, without a word.
  throw new Error("An exported list's rows must be an object or kinds of one.");
}

/**
 * The columns of a list's rows, from its wire type, so that a list with nothing in it still names
 * them. The database function that reads the export gives each row exactly these.
 */
export function exportColumns(list: ExportList): string[] {
  return columnsOf(AccountExportSchema.shape[list]);
}
