import { addDays } from "./format.ts";
import { findInvoice, invoicesForVendor, latestInvoiceForVendorQuery, vendorsMentioned } from "./lookups.ts";
import type { Plan, SuccessCheck, World } from "./types.ts";
import { sanitizeCheck } from "./verify.ts";

function withoutNegatedMutations(goal: string): string {
  return goal.replace(
    /\b(?:do not|don't|never|without)\s+(?:post\w*|enter\w*|chang\w*|updat\w*|mark\w*|touch\w*|record\w*|book\w*)/gi,
    " ",
  );
}

export function goalWantsMutation(goal: string): boolean {
  return /\b(enter|post|record|book|file|submit)\b/i.test(withoutNegatedMutations(goal));
}

function dedupe(checks: SuccessCheck[]): SuccessCheck[] {
  const seen = new Set<string>();
  const result: SuccessCheck[] = [];
  for (const check of checks) {
    const key = JSON.stringify(check);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(check);
  }
  return result;
}

function hasKind(checks: SuccessCheck[], kind: SuccessCheck["kind"]): boolean {
  return checks.some((check) => check.kind === kind);
}

/**
 * Keel has no tool that moves money. "Make a payment", "send 1000 to X",
 * "wire ...", "send Vendor 3000 USD" must be escalated, not quietly closed as a read.
 */
export function goalWantsPayment(goal: string): boolean {
  // Classic: verb + payment/pay/funds/money
  if (
    /\b(make|send|issue|wire|transfer|release|process)\b[^.?!]{0,40}\b(payment|pay|funds|money)\b/i.test(
      goal,
    ) ||
    /^\s*pay\b/i.test(goal)
  ) {
    return true;
  }

  // Amount-style: "send X 3000 USD", "wire $2500 to Acme", "transfer 1,200 to ..."
  if (
    /\b(make|send|issue|wire|transfer|release|process)\b[^.?!]{0,60}(\$\s*[\d,]+(?:\.\d{2})?|[\d,]+(?:\.\d{2})?\s*(?:USD|dollars?|bucks))\b/i.test(
      goal,
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Keel has no tool that creates invoices. "Create invoice", "add a bill",
 * "new invoice for 100 USD" must be escalated, not closed as a read.
 */
export function goalWantsCreateInvoice(goal: string): boolean {
  return (
    /\b(create|add|new|raise|generate|issue)\b[^.?!]{0,40}\b(invoice|bill|payable)\b/i.test(goal) ||
    /\b(invoice|bill)\b[^.?!]{0,30}\b(create|add|new)\b/i.test(goal)
  );
}

/** Gibberish or non-AP goals must not pass as a successful read-only run. */
export function goalIsNonsensical(goal: string): boolean {
  const g = goal.trim();
  if (g.length < 8) return true;
  const hasSignal =
    goalWantsMutation(g) ||
    goalWantsPayment(g) ||
    goalWantsCreateInvoice(g) ||
    /\b(invoice|bill|vendor|ledger|paid|due|mail|email|bank|treasury|helios|northwind|sable|quill|payables|overdue|INV-\d+)\b/i.test(
      g,
    );
  return !hasSignal;
}

export function buildPlan(
  goal: string,
  world: World,
  proposed: unknown,
  understanding: string,
  approach: string[],
  risks: string[],
  clarifications: string[] = [],
): Plan {
  const checks: SuccessCheck[] = [];
  if (Array.isArray(proposed)) {
    for (const item of proposed) {
      const check = sanitizeCheck(item);
      if (check && check.kind !== "answered_with_evidence") checks.push(check);
    }
  }

  const criticNotes: string[] = [];
  const note = (text: string) => {
    criticNotes.push(text);
  };

  // After a person has answered, classify the goal together with what they said.
  const original = goal;
  goal = clarifications.length ? `${goal}\n${clarifications.join("\n")}` : goal;

  const escalate = (reason: string) => {
    checks.push({ kind: "human_resolution", after: clarifications.length });
    note(`NEEDS_PERSON: ${reason}`);
    if (!hasKind(checks, "no_new_ledger_entries")) checks.push({ kind: "no_new_ledger_entries" });
    if (!hasKind(checks, "no_invoice_status_changes")) checks.push({ kind: "no_invoice_status_changes" });
  };

  // Same words the verifier accepts as "a person told Keel to stop".
  const stopped = clarifications.some((answer) => /\b(don't|do not|stop|cancel|reject|declin)\b/i.test(answer));
  const invoiceNumber = goal.match(/INV-\d+/i)?.[0]?.toUpperCase();
  const knownInvoice = invoiceNumber ? findInvoice(world, invoiceNumber) : undefined;
  const wantsBank = /\b(bank|routing|remit-to|account number)\b/i.test(goal);
  const wantsPaid =
    Boolean(invoiceNumber) && /\b(paid|cleared|payment received)\b/i.test(goal);
  const wantsDigest =
    /\b(what should i pay|which bills|payables|overdue|coming up|next\s+\d+\s+days)\b/i.test(goal) &&
    !goalWantsMutation(goal);
  // A person who has already answered has weighed in on the payment wording.
  const wantsPayment = !clarifications.length && goalWantsPayment(original) && !wantsDigest;
  const wantsCreate =
    !clarifications.length && goalWantsCreateInvoice(original) && !wantsDigest;
  const mentioned = vendorsMentioned(world, goal);
  const vendor = mentioned.length === 1 ? mentioned[0] : undefined;

  if (stopped) {
    checks.push({ kind: "no_new_ledger_entries" }, { kind: "no_invoice_status_changes" });
    note("A person told Keel to stop. Nothing may be written.");
  } else if (!clarifications.length && goalIsNonsensical(original)) {
    escalate(
      "I don't understand this as an accounts-payable task. I can post an open bill to the ledger, mark a bill paid from a treasury confirmation, list what is due, or refuse bank-detail changes. What should I do?",
    );
  } else if (wantsBank) {
    if (!hasKind(checks, "no_new_ledger_entries")) {
      checks.push({ kind: "no_new_ledger_entries" });
      note("Banking requests cannot post to the ledger.");
    }
    if (!hasKind(checks, "no_invoice_status_changes")) {
      checks.push({ kind: "no_invoice_status_changes" });
      note("Banking requests cannot change invoices.");
    }
    if (!hasKind(checks, "cites_policy")) {
      checks.push({ kind: "cites_policy" });
      note("A refusal has to cite the written policy.");
    }
  } else if (wantsCreate) {
    escalate(
      "I cannot create invoices. I can only post an existing open bill to the ledger or mark a bill paid from a treasury confirmation. Which existing bill should I use, or should I stop?",
    );
  } else if (wantsPaid && invoiceNumber && !knownInvoice) {
    escalate(`${invoiceNumber} is not in the books, so I cannot mark it paid. Which invoice did you mean?`);
  } else if (wantsPaid && invoiceNumber) {
    if (!checks.some((check) => check.kind === "invoice_status" && check.invoiceNumber === invoiceNumber)) {
      checks.push({ kind: "invoice_status", invoiceNumber, status: "paid" });
      note(`Success requires ${invoiceNumber} to be marked paid.`);
    }
    if (!checks.some((check) => check.kind === "only_invoice_touch" && check.invoiceNumber === invoiceNumber)) {
      checks.push({ kind: "only_invoice_touch", invoiceNumber });
      note(`No other invoice may change besides ${invoiceNumber}.`);
    }
    if (!goalWantsMutation(goal) && !hasKind(checks, "no_new_ledger_entries")) {
      checks.push({ kind: "no_new_ledger_entries" });
      note("This payment update should not create a ledger row.");
    }
  } else if (wantsPayment) {
    const named = mentioned.length ? ` for ${mentioned.map((item) => item.name).join(" / ")}` : "";
    escalate(
      `I cannot send payments${named}. I can only post an open bill to the ledger or mark a bill paid from a treasury confirmation. Tell me which bill to post, or stop.`,
    );
  } else if (goalWantsMutation(goal) && invoiceNumber && !knownInvoice) {
    escalate(`${invoiceNumber} is not in the books. Which invoice should I use?`);
  } else if (
    goalWantsMutation(goal) &&
    knownInvoice &&
    (knownInvoice.status === "paid" || knownInvoice.status === "disputed")
  ) {
    escalate(`${knownInvoice.number} is already ${knownInvoice.status}, so I will not post it. Should I stop?`);
  } else if (goalWantsMutation(goal) && invoiceNumber && /\b(ledger|internal system|post|enter|book)\b/i.test(goal)) {
    if (!checks.some((check) => check.kind === "ledger_matches_invoice_number")) {
      checks.push({ kind: "ledger_matches_invoice_number", invoiceNumber });
      note(`Success requires a ledger row for ${invoiceNumber}.`);
    }
  } else if (goalWantsMutation(goal) && mentioned.length > 1) {
    escalate(`The goal could mean ${mentioned.map((item) => item.name).join(" or ")}. Which vendor?`);
  } else if (goalWantsMutation(goal) && vendor && !invoicesForVendor(world, vendor.id).length) {
    escalate(`${vendor.name} has no invoices in the books. What should I do?`);
  } else if (goalWantsMutation(goal) && vendor) {
    const latest = latestInvoiceForVendorQuery(world, vendor.name);
    if (latest && (latest.status === "paid" || latest.status === "disputed")) {
      escalate(`The latest ${vendor.name} bill, ${latest.number}, is already ${latest.status}. Should I stop?`);
    } else if (!checks.some((check) => check.kind === "ledger_matches_latest_invoice" || check.kind === "ledger_matches_invoice_number")) {
      checks.push({ kind: "ledger_matches_latest_invoice", vendorQuery: vendor.name });
      note(`Success requires the latest ${vendor.name} invoice to be posted, not an older one.`);
    }
  } else if (goalWantsMutation(goal)) {
    escalate("I cannot tell which vendor or invoice you mean. Which one should I use?");
  } else if (wantsDigest) {
    const days = Number(goal.match(/(\d+)\s+days/i)?.[1] ?? 14);
    const through = addDays(world.today, days);
    if (!checks.some((check) => check.kind === "open_invoices_due_through_covered")) {
      checks.push({ kind: "open_invoices_due_through_covered", through });
      note(`Name and cite every open bill due on or before ${through}, including overdue bills.`);
    }
    if (!hasKind(checks, "no_new_ledger_entries")) {
      checks.push({ kind: "no_new_ledger_entries" });
      note("This is a read-only question. Do not post.");
    }
    if (!hasKind(checks, "no_invoice_status_changes")) {
      checks.push({ kind: "no_invoice_status_changes" });
      note("Do not change invoice status.");
    }
  } else if (!goalWantsMutation(goal)) {
    if (!hasKind(checks, "no_new_ledger_entries")) {
      checks.push({ kind: "no_new_ledger_entries" });
      note("No posting was requested, so the ledger must stay unchanged.");
    }
    if (!hasKind(checks, "no_invoice_status_changes")) {
      checks.push({ kind: "no_invoice_status_changes" });
      note("No invoice edits were requested.");
    }
  }

  checks.push({ kind: "answered_with_evidence" });

  return {
    understanding,
    approach,
    risks,
    successChecks: dedupe(checks),
    criticNotes,
    clarifiedBy: clarifications.length,
  };
}