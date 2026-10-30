import { buildPlan } from "./critic.ts";
import { asNumber, asString, money } from "./format.ts";
import { findInvoice, findVendor, humanAnswers, latestInvoiceForVendorQuery, searchVendors } from "./lookups.ts";
import { parseInvoiceDocument } from "./invoice-doc.ts";
import { cloneWorld } from "./seed.ts";
import type { Baseline, Claim, FinishProposal, PendingAsk, Plan, World } from "./types.ts";

export type ToolContext = {
  goal: string;
  plan: Plan | null;
  baseline: Baseline;
};

export type ToolResult = {
  world: World;
  ok: boolean;
  summary: string;
  plan?: Plan;
  pause?: PendingAsk;
  finishProposal?: FinishProposal;
  spotlight?: string;
};

const READS_BEFORE_PLAN = new Set(["declare_plan", "ask_user"]);

function fail(world: World, summary: string): ToolResult {
  return { world, ok: false, summary };
}

function ok(world: World, summary: string, extra?: Partial<ToolResult>): ToolResult {
  return { world, ok: true, summary, ...extra };
}

function linesOf(items: string[]): string {
  return items.join("\n");
}

function parseClaims(raw: unknown): Claim[] | null {
  if (!Array.isArray(raw)) return null;
  const claims: Claim[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    const statement = asString(record.statement);
    const evidenceRaw = record.evidenceIds;
    const evidenceIds = Array.isArray(evidenceRaw)
      ? evidenceRaw.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      : typeof evidenceRaw === "string" && evidenceRaw.trim()
        ? [evidenceRaw.trim()]
        : [];
    if (!statement || !evidenceIds.length) return null;
    const claim: Claim = { statement, evidenceIds };
    const amount = asNumber(record.amount);
    if (amount != null) claim.amount = amount;
    const date = asString(record.date);
    if (date) claim.date = date;
    const invoiceNumber = asString(record.invoiceNumber).toUpperCase();
    if (invoiceNumber) claim.invoiceNumber = invoiceNumber;
    claims.push(claim);
  }
  return claims;
}

export function applyResolution(
  world: World,
  resolution: { kind: "approval"; approvalId: string; decision: "approved" | "rejected" } | { kind: "answer"; text: string },
): { ok: boolean; summary: string; world: World } {
  const next = cloneWorld(world);
  if (resolution.kind === "answer") {
    const text = resolution.text.trim();
    if (!text) return { ok: false, summary: "The reply was empty.", world };
    next.humanNotes.push(`Human answered: ${text}`);
    return { ok: true, summary: `Human answered: ${text}`, world: next };
  }
  const approval = next.approvals.find((item) => item.id === resolution.approvalId);
  if (!approval) return { ok: false, summary: "That approval does not exist.", world };
  if (approval.status !== "pending") {
    return { ok: false, summary: `${approval.id} is already ${approval.status}.`, world };
  }
  approval.status = resolution.decision === "approved" ? "approved" : "rejected";
  const summary =
    approval.status === "approved"
      ? `Human approved ${approval.id} for ${approval.invoiceNumber} (${money(approval.amount)}). You may commit with this approval id.`
      : `Human rejected ${approval.id} for ${approval.invoiceNumber} (${money(approval.amount)}). Do not post. Finish as blocked and explain that the bill was not entered.`;
  next.humanNotes.push(summary);
  return { ok: true, summary, world: next };
}

export function applyTool(
  world: World,
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): ToolResult {
  if (!READS_BEFORE_PLAN.has(name) && !ctx.plan) {
    return fail(world, "Call declare_plan before any other tool. Say what the goal means and which checks would prove it.");
  }
  switch (name) {
    case "declare_plan":
      return declarePlan(world, args, ctx);
    case "list_mailbox":
      return listMailbox(world);
    case "read_message":
      return readMessage(world, args);
    case "list_invoices":
      return listInvoices(world);
    case "open_invoice":
      return openInvoice(world, args);
    case "list_vendors":
      return listVendors(world);
    case "find_vendor":
      return findVendorTool(world, args);
    case "extract_invoice_fields":
      return extractInvoiceFields(world, args);
    case "read_vendor":
      return readVendor(world, args);
    case "list_files":
      return listFiles(world);
    case "read_file":
      return readFile(world, args);
    case "read_policy":
      return readFile(world, { id: "file-ap-policy" });
    case "list_ledger":
      return listLedger(world);
    case "remember":
      return remember(world, args);
    case "request_approval":
      return requestApproval(world, args);
    case "commit_ledger_post":
      return commitLedger(world, args, ctx);
    case "mark_invoice_paid":
      return markPaid(world, args);
    case "ask_user":
      return askUser(world, args);
    case "finish":
      return proposeFinish(world, args);
    default:
      return fail(world, `Unknown tool ${name}.`);
  }
}

function declarePlan(world: World, args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const understanding = asString(args.understanding);
  if (understanding.length < 8) {
    return fail(world, "understanding is too short. Say what outcome you believe the user wants.");
  }
  const approach = Array.isArray(args.approach)
    ? args.approach.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 6)
    : [];
  const risks = Array.isArray(args.risks)
    ? args.risks.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 4)
    : [];
  const answers = humanAnswers(world);
  const plan = buildPlan(ctx.goal, world, args.successChecks, understanding, approach, risks, answers);
  const notes = plan.criticNotes.length ? `\nSafety critic:\n- ${plan.criticNotes.join("\n- ")}` : "";
  const checks = plan.successChecks.map((check) => JSON.stringify(check)).join("\n");
  const replanned = ctx.plan && answers.length ? "Plan updated with the person's answer." : "Plan accepted.";
  return ok(world, `${replanned}\n${understanding}\nAccepted checks:\n${checks}${notes}`, { plan });
}

function listMailbox(world: World): ToolResult {
  const rows = [...world.messages].sort((a, b) => (a.date < b.date ? 1 : -1));
  const summary = linesOf([
    `${rows.length} messages, newest first. Bodies are not included.`,
    ...rows.map(
      (message) =>
        `${message.id} | ${message.date} | ${message.from} | ${message.subject} | invoice: ${message.invoiceNumber ?? "none"}`,
    ),
  ]);
  return ok(world, summary);
}

function readMessage(world: World, args: Record<string, unknown>): ToolResult {
  const id = asString(args.id);
  const message = world.messages.find((item) => item.id === id);
  if (!message) return fail(world, `No message ${id}. Use an id from list_mailbox.`);
  return ok(
    world,
    linesOf([
      `${message.id} | ${message.date} | ${message.from}`,
      message.subject,
      `invoice reference: ${message.invoiceNumber ?? "none"}`,
      "",
      message.body,
    ]),
    { spotlight: message.id },
  );
}

function listInvoices(world: World): ToolResult {
  const rows = [...world.invoices].sort((a, b) => (a.issued < b.issued ? 1 : -1));
  const summary = linesOf([
    "Invoice index. Due dates are omitted. indexedAmount is blank when the index is untrusted — open the invoice.",
    ...rows.map((invoice) => {
      const vendor = world.vendors.find((item) => item.id === invoice.vendorId);
      const amount = invoice.indexedAmount == null ? "blank" : String(invoice.indexedAmount);
      return `${invoice.id} | ${invoice.number} | ${vendor?.name ?? invoice.vendorId} | issued ${invoice.issued} | ${invoice.status} | indexedAmount: ${amount}`;
    }),
  ]);
  return ok(world, summary);
}

function openInvoice(world: World, args: Record<string, unknown>): ToolResult {
  const invoice = findInvoice(world, asString(args.id) || asString(args.invoiceNumber));
  if (!invoice) return fail(world, "Invoice not found. Use an id or number from list_invoices.");
  const vendor = world.vendors.find((item) => item.id === invoice.vendorId);
  return ok(
    world,
    linesOf([
      `${invoice.id} | ${invoice.number} | ${vendor?.name ?? ""}`,
      `status: ${invoice.status}`,
      `issued: ${invoice.issued}`,
      `due: ${invoice.due}`,
      `amount: ${invoice.amount} USD`,
      `po: ${invoice.po}`,
      "",
      invoice.document,
    ]),
    { spotlight: invoice.id },
  );
}

function listVendors(world: World): ToolResult {
  return ok(
    world,
    linesOf([
      "Vendors. Codes are not on this list — read_vendor for the master code and approval threshold.",
      ...world.vendors.map((vendor) => `${vendor.id} | ${vendor.name} | terms ${vendor.terms}`),
    ]),
  );
}

function readVendor(world: World, args: Record<string, unknown>): ToolResult {
  const vendor = findVendor(world, asString(args.id) || asString(args.name));
  if (!vendor) return fail(world, "Vendor not found. Use an id from list_vendors.");
  return ok(
    world,
    linesOf([
      `${vendor.id} | ${vendor.name}`,
      `master code: ${vendor.code}`,
      `retired codes (rejected): ${vendor.retiredCodes.join(", ") || "none"}`,
      `approval required at or above: ${vendor.approvalAtOrAbove} USD`,
      `bank on file ends: ${vendor.bankLast4}`,
      `bank changes locked: ${vendor.bankChangesLocked ? "yes" : "no"}`,
      `terms: ${vendor.terms}`,
    ]),
    { spotlight: vendor.id },
  );
}

function findVendorTool(world: World, args: Record<string, unknown>): ToolResult {
  const query = asString(args.query) || asString(args.name);
  if (query.length < 2) return fail(world, "find_vendor needs the vendor name as written in the goal.");
  const hits = searchVendors(world, query);
  if (!hits.length) {
    return fail(
      world,
      `NO_SUCH_VENDOR. Nothing in the vendor master matches "${query}". Known vendors: ${world.vendors.map((vendor) => vendor.name).join(", ")}. Do not guess a vendor. Use ask_user.`,
    );
  }
  const [top, second] = hits;
  if (second && top!.score - second.score < 0.2) {
    return ok(
      world,
      `AMBIGUOUS. "${query}" could be ${hits.map((hit) => `${hit.vendor.name} (${hit.vendor.id})`).join(" or ")}. Use ask_user to choose.`,
    );
  }
  const confidence = top!.score >= 1 ? "exact" : top!.score >= 0.8 ? "brand name" : "close spelling";
  return ok(world, `MATCH ${top!.vendor.id} | ${top!.vendor.name} (${confidence}). Use read_vendor for the master code.`, {
    spotlight: top!.vendor.id,
  });
}

function extractInvoiceFields(world: World, args: Record<string, unknown>): ToolResult {
  const invoice = findInvoice(world, asString(args.id) || asString(args.invoiceNumber));
  if (!invoice) return fail(world, "Invoice not found. Use an id or number from list_invoices.");
  const doc = parseInvoiceDocument(invoice.document);
  if (doc.total == null || !doc.due) {
    return fail(world, `UNREADABLE_DOCUMENT. ${invoice.number} has no readable ${doc.total == null ? "total" : "due date"}. Use ask_user.`);
  }
  const vendor = world.vendors.find((item) => item.id === invoice.vendorId);
  const next = cloneWorld(world);
  const key = `extracted:${invoice.number}`;
  const value = `amount ${doc.total} USD; due ${doc.due}; issued ${doc.issued ?? "?"}; PO ${doc.po ?? "?"}; vendor ${vendor?.name ?? doc.vendor ?? "?"}`;
  const existing = next.memory.find((note) => note.key === key);
  if (existing) existing.value = value;
  else next.memory.push({ key, value });
  if (next.memory.length > 12) next.memory.shift();
  const check = doc.warnings.length ? `WARNING: ${doc.warnings.join(" ")}` : `Check: total equals the sum of ${doc.lines.length} line(s).`;
  return ok(
    next,
    linesOf([
      `EXTRACTED ${invoice.id} | ${invoice.number} from the document text`,
      `vendor: ${vendor?.name ?? doc.vendor ?? "unknown"}`,
      `amount: ${doc.total} USD`,
      `due: ${doc.due}`,
      `issued: ${doc.issued ?? "unknown"}`,
      `po: ${doc.po ?? "unknown"}`,
      ...doc.lines.map((line) => `line: ${line.description} ${line.amount.toFixed(2)}`),
      check,
      `Saved to working memory as ${key}.`,
    ]),
    { spotlight: invoice.id },
  );
}

function listFiles(world: World): ToolResult {
  return ok(
    world,
    linesOf(world.files.map((file) => `${file.id} | ${file.path} | ${file.title}`)),
  );
}

function readFile(world: World, args: Record<string, unknown>): ToolResult {
  const id = asString(args.id);
  const path = asString(args.path);
  const file = world.files.find((item) => item.id === id || item.path === path);
  if (!file) return fail(world, "File not found. Use an id or path from list_files.");
  return ok(world, `${file.path}\n${file.title}\n\n${file.body}`, { spotlight: file.id });
}

function listLedger(world: World): ToolResult {
  if (!world.ledger.length) return ok(world, "Ledger is empty.");
  return ok(
    world,
    linesOf(
      world.ledger.map(
        (entry) =>
          `${entry.id} | ${entry.invoiceNumber} | ${entry.vendorCode} | ${entry.vendorName} | ${entry.amount} USD | due ${entry.dueDate} | ${entry.memo}`,
      ),
    ),
  );
}

function remember(world: World, args: Record<string, unknown>): ToolResult {
  const key = asString(args.key).slice(0, 80);
  const value = asString(args.value).slice(0, 500);
  if (!key || !value) return fail(world, "remember needs a key and a value.");
  const next = cloneWorld(world);
  const existing = next.memory.find((note) => note.key === key);
  if (existing) existing.value = value;
  else next.memory.push({ key, value });
  if (next.memory.length > 12) next.memory.shift();
  return ok(next, `Remembered ${key}: ${value}`);
}

function requestApproval(world: World, args: Record<string, unknown>): ToolResult {
  const invoice = findInvoice(world, asString(args.invoiceNumber));
  if (!invoice) return fail(world, "Invoice not found.");
  const amount = asNumber(args.amount);
  if (amount == null) return fail(world, "amount is required.");
  if (amount !== invoice.amount) {
    return fail(world, `AMOUNT_MISMATCH. ${invoice.number} total is ${invoice.amount} USD.`);
  }
  const reason = asString(args.reason) || `Post ${invoice.number}`;
  const existing = world.approvals.find(
    (approval) => approval.invoiceNumber === invoice.number && approval.amount === amount,
  );
  if (existing?.status === "approved") {
    return ok(world, `${existing.id} is already approved. Commit with approvalId ${existing.id}.`);
  }
  if (existing?.status === "pending") {
    return ok(
      world,
      `${existing.id} is still waiting for a person.`,
      {
        pause: {
          kind: "approval",
          approvalId: existing.id,
          question: `Approve posting ${invoice.number}?`,
          detail: `${reason} Amount ${money(amount)}.`,
        },
      },
    );
  }
  if (existing?.status === "rejected") {
    return fail(world, `${existing.id} was rejected. Do not post. Finish as blocked.`);
  }
  const next = cloneWorld(world);
  const id = `apr-${next.approvals.length + 1}`;
  next.approvals.push({
    id,
    vendorId: invoice.vendorId,
    invoiceNumber: invoice.number,
    amount,
    reason,
    status: "pending",
  });
  const vendor = next.vendors.find((item) => item.id === invoice.vendorId);
  return ok(next, `${id} is pending a human decision. Stop and wait. Do not commit yet.`, {
    pause: {
      kind: "approval",
      approvalId: id,
      question: `Approve ${vendor?.name ?? "vendor"} ${invoice.number} for ${money(amount)}?`,
      detail: reason,
    },
    spotlight: id,
  });
}

function commitLedger(world: World, args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const invoice = findInvoice(world, asString(args.invoiceNumber));
  if (!invoice) return fail(world, "INVOICE_NOT_FOUND. Open the invoice index and use a real number.");
  if (invoice.status !== "open") {
    return fail(world, `INVOICE_NOT_OPEN. ${invoice.number} is ${invoice.status}.`);
  }
  if (world.ledger.some((entry) => entry.invoiceNumber === invoice.number)) {
    return fail(world, `DUPLICATE. ${invoice.number} is already on the ledger.`);
  }
  const latestCheck = ctx.plan?.successChecks.find((check) => check.kind === "ledger_matches_latest_invoice");
  if (latestCheck) {
    const latest = latestInvoiceForVendorQuery(world, latestCheck.vendorQuery);
    if (latest && latest.number !== invoice.number) {
      return fail(
        world,
        `NOT_THE_TARGET_INVOICE. The plan requires the latest ${latestCheck.vendorQuery} invoice, which is ${latest.number} issued ${latest.issued}.`,
      );
    }
  }
  const amount = asNumber(args.amount);
  if (amount == null || amount !== invoice.amount) {
    return fail(world, `AMOUNT_MISMATCH. ${invoice.number} total is ${invoice.amount} USD.`);
  }
  const dueDate = asString(args.dueDate);
  if (dueDate !== invoice.due) {
    return fail(world, `DUE_DATE_MISMATCH. ${invoice.number} is due ${invoice.due}.`);
  }
  const doc = parseInvoiceDocument(invoice.document);
  if (doc.total == null || doc.total !== invoice.amount || doc.due !== invoice.due) {
    return fail(
      world,
      `DOCUMENT_MISMATCH. The printed document for ${invoice.number} (total ${doc.total ?? "unreadable"}, due ${doc.due ?? "none"}) disagrees with the invoice record. Do not post. Use ask_user.`,
    );
  }
  const vendor = world.vendors.find((item) => item.id === invoice.vendorId);
  if (!vendor) return fail(world, "Vendor missing from the master.");
  const vendorCode = asString(args.vendorCode).toUpperCase();
  if (vendorCode !== vendor.code) {
    const retired = vendor.retiredCodes.some((code) => code.toUpperCase() === vendorCode);
    return fail(
      world,
      retired
        ? `STALE_VENDOR_CODE. ${vendorCode} is retired for ${vendor.name}. read_vendor and use the current master code.`
        : `UNKNOWN_VENDOR_CODE. ${vendor.name} does not use "${asString(args.vendorCode) || "(blank)"}". read_vendor for the current master code. Trade names are rejected.`,
    );
  }
  if (invoice.amount >= vendor.approvalAtOrAbove) {
    const approvalId = asString(args.approvalId);
    const approval = world.approvals.find((item) => item.id === approvalId);
    if (!approval || approval.status !== "approved" || approval.invoiceNumber !== invoice.number || approval.amount !== invoice.amount) {
      return fail(
        world,
        `APPROVAL_REQUIRED. ${vendor.name} requires an approved request for bills at or above ${vendor.approvalAtOrAbove} USD. Call request_approval, wait for the human, then commit with that approval id.`,
      );
    }
  }
  const next = cloneWorld(world);
  const id = `led-${invoice.number.toLowerCase()}`;
  const target = next.invoices.find((item) => item.id === invoice.id)!;
  target.status = "posted";
  next.ledger.push({
    id,
    invoiceNumber: invoice.number,
    vendorCode: vendor.code,
    vendorName: vendor.name,
    amount: invoice.amount,
    dueDate: invoice.due,
    memo: asString(args.memo) || `Posted from ${invoice.number}`,
    approvalId: asString(args.approvalId) || null,
    postedOn: world.today,
  });
  // Read-after-write: re-read the row from the ledger and compare it with the document text.
  const row = next.ledger.find((item) => item.id === id);
  const matches = Boolean(row) && row!.amount === doc.total && row!.dueDate === doc.due && row!.vendorCode === vendor.code;
  return ok(
    next,
    `Posted ${id}: ${invoice.number} ${vendor.code} ${invoice.amount} USD due ${invoice.due}. Invoice status is now posted.\nRead-back from the ledger: ${row?.invoiceNumber} ${row?.vendorCode} ${row?.amount} USD due ${row?.dueDate} — ${matches ? "matches the invoice document." : "DOES NOT match the invoice document."}`,
    { spotlight: id },
  );
}

function markPaid(world: World, args: Record<string, unknown>): ToolResult {
  const invoice = findInvoice(world, asString(args.invoiceNumber));
  if (!invoice) return fail(world, "Invoice not found.");
  if (invoice.status === "paid") return fail(world, `${invoice.number} is already paid.`);
  if (invoice.status === "disputed") return fail(world, `${invoice.number} is disputed. Ask the user before changing it.`);
  const message = world.messages.find((item) => item.id === asString(args.evidenceMessageId));
  if (!message) return fail(world, "evidenceMessageId was not a real message. Read the treasury mail first.");
  const text = `${message.subject}\n${message.body}`;
  if (!text.includes(invoice.number)) {
    return fail(world, `${message.id} does not mention ${invoice.number}.`);
  }
  if (!/\b(cleared|paid|payment received|remitted)\b/i.test(text)) {
    return fail(world, `${message.id} mentions ${invoice.number} but is not a payment confirmation.`);
  }
  const next = cloneWorld(world);
  next.invoices.find((item) => item.id === invoice.id)!.status = "paid";
  return ok(next, `${invoice.number} marked paid based on ${message.id}.`, { spotlight: invoice.id });
}

function askUser(world: World, args: Record<string, unknown>): ToolResult {
  const question = asString(args.question);
  if (question.length < 8) return fail(world, "Ask a specific question.");
  return ok(world, "Waiting for the human answer. Do not take another action until it arrives.", {
    pause: { kind: "clarify", question, detail: asString(args.why) },
  });
}

function proposeFinish(world: World, args: Record<string, unknown>): ToolResult {
  const summary = asString(args.summary);
  const claims = parseClaims(args.claims);
  if (!summary || !claims) {
    return fail(
      world,
      "finish needs summary and claims. Each claim needs statement and evidenceIds. Add amount, date, and invoiceNumber when you assert them.",
    );
  }
  const blocked = args.blocked === true || args.blocked === "true";
  return ok(world, summary, { finishProposal: { summary, claims, blocked } });
}
