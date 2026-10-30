import type { Invoice, Vendor, World } from "./types.ts";

export function findInvoice(world: World, idOrNumber: string): Invoice | undefined {
  const query = idOrNumber.trim().toLowerCase();
  return world.invoices.find(
    (invoice) => invoice.id.toLowerCase() === query || invoice.number.toLowerCase() === query,
  );
}

export function findVendor(world: World, idOrName: string): Vendor | undefined {
  const query = idOrName.trim().toLowerCase();
  return world.vendors.find(
    (vendor) =>
      vendor.id.toLowerCase() === query ||
      vendor.name.toLowerCase() === query ||
      vendor.code.toLowerCase() === query ||
      vendor.aliases.some((alias) => alias === query),
  );
}

export function vendorsMatching(world: World, query: string): Vendor[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return world.vendors.filter(
    (vendor) =>
      vendor.name.toLowerCase().includes(needle) ||
      needle.includes(vendor.name.toLowerCase()) ||
      vendor.aliases.some((alias) => needle.includes(alias) || alias.includes(needle)),
  );
}

export function latestInvoiceForVendorQuery(world: World, query: string): Invoice | null {
  const vendors = vendorsMatching(world, query);
  if (!vendors.length) return null;
  const ids = new Set(vendors.map((vendor) => vendor.id));
  const invoices = world.invoices.filter((invoice) => ids.has(invoice.vendorId));
  invoices.sort((a, b) => {
    if (a.issued !== b.issued) return a.issued < b.issued ? 1 : -1;
    return a.number < b.number ? 1 : -1;
  });
  return invoices[0] ?? null;
}

export type EvidenceHit = {
  id: string;
  kind: "message" | "invoice" | "ledger" | "vendor" | "file" | "approval";
  label: string;
  text: string;
  amounts: number[];
  dates: string[];
  invoiceNumbers: string[];
  policy: boolean;
};

export function findEvidence(world: World, id: string): EvidenceHit | null {
  const message = world.messages.find((item) => item.id === id);
  if (message) {
    const text = `${message.subject}\n${message.body}`;
    return {
      id,
      kind: "message",
      label: message.subject,
      text,
      amounts: [],
      dates: [message.date, ...(text.match(/\d{4}-\d{2}-\d{2}/g) ?? [])],
      invoiceNumbers: message.invoiceNumber ? [message.invoiceNumber] : [],
      policy: false,
    };
  }
  const invoice = world.invoices.find((item) => item.id === id);
  if (invoice) {
    return {
      id,
      kind: "invoice",
      label: invoice.number,
      text: invoice.document,
      amounts: [invoice.amount],
      dates: [invoice.issued, invoice.due],
      invoiceNumbers: [invoice.number],
      policy: false,
    };
  }
  const entry = world.ledger.find((item) => item.id === id);
  if (entry) {
    return {
      id,
      kind: "ledger",
      label: entry.invoiceNumber,
      text: `${entry.memo} ${entry.vendorName} ${entry.invoiceNumber} ${entry.amount} ${entry.dueDate}`,
      amounts: [entry.amount],
      dates: [entry.dueDate, entry.postedOn],
      invoiceNumbers: [entry.invoiceNumber],
      policy: false,
    };
  }
  const vendor = world.vendors.find((item) => item.id === id);
  if (vendor) {
    return {
      id,
      kind: "vendor",
      label: vendor.name,
      text: `${vendor.name} ${vendor.code} ${vendor.terms}`,
      amounts: [vendor.approvalAtOrAbove],
      dates: [],
      invoiceNumbers: [],
      policy: false,
    };
  }
  const file = world.files.find((item) => item.id === id);
  if (file) {
    return {
      id,
      kind: "file",
      label: file.title,
      text: file.body,
      amounts: [],
      dates: file.body.match(/\d{4}-\d{2}-\d{2}/g) ?? [],
      invoiceNumbers: [],
      policy: file.path.startsWith("/policies/"),
    };
  }
  const approval = world.approvals.find((item) => item.id === id);
  if (approval) {
    return {
      id,
      kind: "approval",
      label: approval.id,
      text: `${approval.reason} ${approval.invoiceNumber} ${approval.status}`,
      amounts: [approval.amount],
      dates: [],
      invoiceNumbers: [approval.invoiceNumber],
      policy: false,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Vendor resolution
// ---------------------------------------------------------------------------

const GENERIC = new Set(["inc", "llc", "ltd", "co", "corp", "corporation", "company", "the", "and"]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0 && !GENERIC.has(word));
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff: number[] = [];
    for (let k = 0; k < a.length; k += 1) if (a[k] !== b[k]) diff.push(k);
    if (diff.length === 2 && diff[1] === diff[0]! + 1 && a[diff[0]!] === b[diff[1]!] && a[diff[1]!] === b[diff[0]!]) return true;
  }
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** A word in the text names the vendor's brand (its first word). Typos are tolerated only on longer brands. */
function brandHit(vendor: Vendor, words: string[]): boolean {
  const brand = tokens(vendor.name)[0];
  if (!brand) return false;
  return words.some((word) => word === brand || (brand.length >= 6 && word.length >= 6 && editDistanceAtMostOne(word, brand)));
}

export type VendorCandidate = { vendor: Vendor; score: number };

/**
 * Rank vendors against free text (a vendor query or a whole goal).
 * 1.0 = full name or alias present, 0.8 = brand word present, 0.7 = brand word within one typo.
 */
export function searchVendors(world: World, text: string): VendorCandidate[] {
  const lower = text.toLowerCase();
  const words = tokens(text);
  const out: VendorCandidate[] = [];
  for (const vendor of world.vendors) {
    let score = 0;
    const full = vendor.name.toLowerCase();
    if (lower.includes(full) || vendor.aliases.some((alias) => lower.includes(alias))) score = 1;
    else if (words.includes(tokens(vendor.name)[0] ?? "\u0000")) score = 0.8;
    else if (brandHit(vendor, words)) score = 0.7;
    if (score > 0) out.push({ vendor, score });
  }
  return out.sort((a, b) => b.score - a.score || a.vendor.name.localeCompare(b.vendor.name));
}

/** Vendors a goal clearly names. More than one means the goal is ambiguous. */
export function vendorsMentioned(world: World, goal: string): Vendor[] {
  return searchVendors(world, goal).map((candidate) => candidate.vendor);
}

export function invoicesForVendor(world: World, vendorId: string): Invoice[] {
  return world.invoices.filter((invoice) => invoice.vendorId === vendorId);
}

const ANSWER_PREFIX = "Human answered: ";

/** What the person typed in reply to ask_user, oldest first. Approval decisions are not answers. */
export function humanAnswers(world: World): string[] {
  return world.humanNotes.filter((note) => note.startsWith(ANSWER_PREFIX)).map((note) => note.slice(ANSWER_PREFIX.length));
}
