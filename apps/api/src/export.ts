import {
  type AccountExport,
  EXPORT_SHEETS,
  type ExportList,
  exportColumns,
} from "@nearcited/shared";
import { strToU8, zipSync } from "fflate";

type Row = Record<string, unknown>;

/**
 * One cell. A list or an object is written as JSON. Text a spreadsheet would run as a formula
 * starts with an apostrophe, since an answer or a name is anyone's words.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** A spreadsheet file: a line naming the columns, then a line for each row. */
function csv(columns: string[], rows: Row[]): string {
  const lines = [
    columns.join(","),
    ...rows.map((row) => columns.map((c) => cell(row[c])).join(",")),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

function readme(exported: AccountExport, appUrl: string): string {
  return [
    `Everything Nearcited held for ${exported.organization.name} on ${exported.exported_at}.`,
    "",
    "Each .csv file is one list, and opens in any spreadsheet. everything.json holds all of it in",
    "one file, for another tool to read.",
    "",
    "Sign-ins are not here: once given, they are never shown again. Invoices are kept by the",
    "payment provider, Stripe, which also emails a receipt for each payment. While the account is",
    `open, Manage billing on Account settings opens them: ${appUrl}/settings`,
    "",
  ].join("\r\n");
}

/** The export as a ZIP: a spreadsheet for each list, all of it as JSON, and a note. */
export function exportZip(exported: AccountExport, appUrl: string): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "README.txt": strToU8(readme(exported, appUrl)),
    "everything.json": strToU8(JSON.stringify(exported, null, 2)),
  };
  for (const [list, name] of Object.entries(EXPORT_SHEETS) as [ExportList, string][]) {
    const value = exported[list];
    const rows = (Array.isArray(value) ? value : [value]) as Row[];
    files[name] = strToU8(csv(exportColumns(list), rows));
  }
  return zipSync(files);
}

/** The file's name: the organization's name made safe for one, and the day. */
export function exportFileName(exported: AccountExport): string {
  const name = exported.organization.name
    .toLowerCase()
    .normalize("NFKD")
    // An accent comes apart from its letter, and goes.
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `nearcited-${name || "organization"}-${exported.exported_at.slice(0, 10)}.zip`;
}
