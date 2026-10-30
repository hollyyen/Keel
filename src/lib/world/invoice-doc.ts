/**
 * Reads the printed invoice document, not the structured record.
 * Used for extraction and for read-after-write verification, so a ledger row is
 * compared against what the document actually says.
 */
export type ParsedInvoiceDoc = {
  number: string | null;
  vendor: string | null;
  issued: string | null;
  due: string | null;
  po: string | null;
  total: number | null;
  lines: { description: string; amount: number }[];
  lineSum: number;
  /** Problems found while reading, e.g. the total does not equal the sum of the lines. */
  warnings: string[];
};

export function parseInvoiceDocument(document: string): ParsedInvoiceDoc {
  const text = document.replace(/\r/g, "");
  const rows = text.split("\n");
  const pick = (pattern: RegExp): string | null => text.match(pattern)?.[1]?.trim() ?? null;

  const number = pick(/^Invoice\s+(INV-\d+)/im);
  const issued = pick(/^Issued:\s*(\d{4}-\d{2}-\d{2})/im);
  const due = pick(/^Due:\s*(\d{4}-\d{2}-\d{2})/im);
  const po = pick(/^PO:\s*(\S+)/im);
  const totalRaw = pick(/^Total\s+USD\s+([\d,]+(?:\.\d+)?)/im);
  const total = totalRaw == null ? null : Number(totalRaw.replace(/,/g, ""));
  const vendor = rows[0]?.trim() ? rows[0].trim() : null;

  const lines: { description: string; amount: number }[] = [];
  for (const row of rows) {
    const match = row.match(/^(.+?)\s{2,}([\d,]+\.\d{2})$/);
    if (!match) continue;
    if (/^Total\b/i.test(match[1]!)) continue;
    lines.push({ description: match[1]!.trim(), amount: Number(match[2]!.replace(/,/g, "")) });
  }
  const lineSum = Math.round(lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;

  const warnings: string[] = [];
  if (total == null) warnings.push("No total found on the document.");
  if (!due) warnings.push("No due date found on the document.");
  if (total != null && lines.length && Math.abs(total - lineSum) > 0.005) {
    warnings.push(`Total ${total} does not equal the sum of the lines (${lineSum}).`);
  }
  return { number, vendor, issued, due, po, total, lines, lineSum, warnings };
}
