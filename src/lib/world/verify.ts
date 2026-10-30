import { textHasAmount } from "./format.ts";
import { findEvidence, findInvoice, humanAnswers, latestInvoiceForVendorQuery } from "./lookups.ts";
import { parseInvoiceDocument } from "./invoice-doc.ts";
import type {
  Baseline,
  CheckResult,
  Claim,
  FinishProposal,
  InvoiceStatus,
  Plan,
  SuccessCheck,
  World,
} from "./types.ts";

const STATUSES = new Set<InvoiceStatus>(["open", "posted", "paid", "disputed"]);

export function sanitizeCheck(raw: unknown): SuccessCheck | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const kind = record.kind;
  if (kind === "ledger_matches_latest_invoice" && typeof record.vendorQuery === "string" && record.vendorQuery.trim()) {
    return { kind, vendorQuery: record.vendorQuery.trim() };
  }
  if (kind === "ledger_matches_invoice_number" && typeof record.invoiceNumber === "string") {
    return { kind, invoiceNumber: record.invoiceNumber.trim().toUpperCase() };
  }
  if (
    kind === "invoice_status" &&
    typeof record.invoiceNumber === "string" &&
    typeof record.status === "string" &&
    STATUSES.has(record.status as InvoiceStatus)
  ) {
    return {
      kind,
      invoiceNumber: record.invoiceNumber.trim().toUpperCase(),
      status: record.status as InvoiceStatus,
    };
  }
  if (kind === "only_invoice_touch" && typeof record.invoiceNumber === "string") {
    return { kind, invoiceNumber: record.invoiceNumber.trim().toUpperCase() };
  }
  if (kind === "human_resolution") {
    return { kind, after: typeof record.after === "number" && record.after >= 0 ? record.after : 0 };
  }
  if (kind === "no_new_ledger_entries" || kind === "no_invoice_status_changes" || kind === "cites_policy" || kind === "answered_with_evidence") {
    return { kind };
  }
  if (kind === "open_invoices_due_through_covered" && typeof record.through === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.through)) {
    return { kind, through: record.through };
  }
  return null;
}

function newcomers(world: World, baseline: Baseline) {
  const known = new Set(baseline.ledgerIds);
  return world.ledger.filter((entry) => !known.has(entry.id));
}

function statusChanges(world: World, baseline: Baseline) {
  return world.invoices.filter((invoice) => baseline.invoiceStatus[invoice.number] !== invoice.status);
}

function claimBacked(world: World, claim: Claim): string | null {
  if (!claim.evidenceIds.length) return "A claim is missing evidence ids.";
  const hits = claim.evidenceIds.map((id) => findEvidence(world, id));
  if (hits.some((hit) => !hit)) return `Unknown evidence id: ${claim.evidenceIds.filter((id) => !findEvidence(world, id)).join(", ")}.`;
  const present = hits.flatMap((hit) => (hit ? [hit] : []));
  if (claim.amount != null) {
    const ok = present.some((hit) => hit.amounts.includes(claim.amount!) || textHasAmount(hit.text, claim.amount!));
    if (!ok) return `None of the cited records contain amount ${claim.amount}.`;
  }
  if (claim.date) {
    const ok = present.some((hit) => hit.dates.includes(claim.date!) || hit.text.includes(claim.date!));
    if (!ok) return `None of the cited records contain date ${claim.date}.`;
  }
  if (claim.invoiceNumber) {
    const number = claim.invoiceNumber.toUpperCase();
    const ok = present.some((hit) => hit.invoiceNumbers.includes(number) || hit.text.toUpperCase().includes(number));
    if (!ok) return `None of the cited records contain ${number}.`;
  }
  return null;
}

function humanStopped(world: World): boolean {
  if (world.approvals.some((approval) => approval.status === "rejected")) return true;
  return world.humanNotes.some((note) => /\b(don't|do not|stop|cancel|reject|declin)\b/i.test(note));
}

export function evaluateFinish(
  world: World,
  baseline: Baseline,
  plan: Plan,
  proposal: FinishProposal,
): { ok: boolean; errors: string[]; checks: CheckResult[]; blocked: boolean } {
  const errors: string[] = [];
  const checks: CheckResult[] = [];
  const added = newcomers(world, baseline);
  const changed = statusChanges(world, baseline);

  for (const entry of added) {
    const invoice = findInvoice(world, entry.invoiceNumber);
    if (!invoice || invoice.amount !== entry.amount || invoice.due !== entry.dueDate || invoice.vendorId === "") {
      errors.push(`Ledger row ${entry.invoiceNumber} does not match an invoice.`);
      continue;
    }
    // Read-after-write: compare the row with what the printed document says, not with the structured record.
    const doc = parseInvoiceDocument(invoice.document);
    if (doc.total == null || doc.total !== entry.amount) {
      errors.push(`Ledger row ${entry.invoiceNumber} has amount ${entry.amount} but the document total is ${doc.total ?? "unreadable"}.`);
    }
    if (!doc.due || doc.due !== entry.dueDate) {
      errors.push(`Ledger row ${entry.invoiceNumber} has due date ${entry.dueDate} but the document says ${doc.due ?? "nothing"}.`);
    }
  }

  const positive = plan.successChecks.filter(
    (check) =>
      check.kind === "ledger_matches_latest_invoice" ||
      check.kind === "ledger_matches_invoice_number" ||
      check.kind === "invoice_status" ||
      check.kind === "open_invoices_due_through_covered",
  );

  if (proposal.blocked) {
    if (!humanStopped(world)) {
      errors.push("Blocked is only allowed after a person rejects the approval or tells you to stop.");
    }
    if (added.length || changed.length) {
      errors.push("Records changed, so this cannot be closed as blocked. Finish normally and let the checks run.");
    }
  }

  const skipPositive = proposal.blocked && errors.length === 0;

  if (!skipPositive && positive.length === 0 && added.length) {
    errors.push("A ledger row was posted, but the plan has no ledger success check.");
  }

  const allowedNumbers = new Set<string>();
  for (const check of plan.successChecks) {
    if (check.kind === "ledger_matches_invoice_number") allowedNumbers.add(check.invoiceNumber);
    if (check.kind === "ledger_matches_latest_invoice") {
      const latest = latestInvoiceForVendorQuery(world, check.vendorQuery);
      if (latest) allowedNumbers.add(latest.number);
    }
  }
  if (allowedNumbers.size) {
    for (const entry of added) {
      if (!allowedNumbers.has(entry.invoiceNumber)) {
        errors.push(`Unexpected ledger post ${entry.invoiceNumber}.`);
      }
    }
  }

  for (const check of plan.successChecks) {
    const result = runCheck(world, baseline, proposal, check, skipPositive);
    checks.push(result);
    if (!result.ok) errors.push(result.detail);
  }

  if (proposal.summary.trim().length < 12) {
    errors.push("The summary is too thin to be the result.");
  }

  const unique = [...new Set(errors)];
  return { ok: unique.length === 0, errors: unique, checks, blocked: proposal.blocked && unique.length === 0 };
}

function runCheck(
  world: World,
  baseline: Baseline,
  proposal: FinishProposal,
  check: SuccessCheck,
  skipPositive: boolean,
): CheckResult {
  switch (check.kind) {
    case "answered_with_evidence": {
      if (!proposal.claims.length) {
        return { kind: check.kind, ok: false, detail: "Finish needs at least one claim tied to evidence ids." };
      }
      for (const claim of proposal.claims) {
        const problem = claimBacked(world, claim);
        if (problem) return { kind: check.kind, ok: false, detail: problem };
      }
      return { kind: check.kind, ok: true, detail: "Claims cite real records." };
    }
    case "no_new_ledger_entries": {
      const extra = newcomers(world, baseline);
      return extra.length
        ? { kind: check.kind, ok: false, detail: `New ledger rows were not requested: ${extra.map((entry) => entry.invoiceNumber).join(", ")}.` }
        : { kind: check.kind, ok: true, detail: "Ledger unchanged." };
    }
    case "no_invoice_status_changes": {
      const changed = statusChanges(world, baseline);
      return changed.length
        ? { kind: check.kind, ok: false, detail: `Invoice status changed: ${changed.map((invoice) => invoice.number).join(", ")}.` }
        : { kind: check.kind, ok: true, detail: "Invoice statuses unchanged." };
    }
    case "only_invoice_touch": {
      const changed = statusChanges(world, baseline).filter((invoice) => invoice.number !== check.invoiceNumber);
      return changed.length
        ? { kind: check.kind, ok: false, detail: `Only ${check.invoiceNumber} could change. Also changed: ${changed.map((invoice) => invoice.number).join(", ")}.` }
        : { kind: check.kind, ok: true, detail: `Only ${check.invoiceNumber} was eligible to change.` };
    }
    case "human_resolution": {
      const answered = humanAnswers(world).length;
      return answered > check.after
        ? { kind: check.kind, ok: true, detail: "A person answered the open question." }
        : { kind: check.kind, ok: false, detail: "This goal cannot be completed as stated. Call ask_user and wait for a person before finishing." };
    }
    case "cites_policy": {
      const cited = proposal.claims.some((claim) => claim.evidenceIds.some((id) => findEvidence(world, id)?.policy));
      return cited
        ? { kind: check.kind, ok: true, detail: "Policy file cited." }
        : { kind: check.kind, ok: false, detail: "Cite a policy file from list_files. Read it before you refuse." };
    }
    case "invoice_status": {
      if (skipPositive) return { kind: check.kind, ok: true, detail: "Skipped because a person stopped the task." };
      const invoice = findInvoice(world, check.invoiceNumber);
      if (!invoice) return { kind: check.kind, ok: false, detail: `${check.invoiceNumber} does not exist.` };
      return invoice.status === check.status
        ? { kind: check.kind, ok: true, detail: `${invoice.number} is ${invoice.status}.` }
        : { kind: check.kind, ok: false, detail: `${invoice.number} is ${invoice.status}, not ${check.status}.` };
    }
    case "ledger_matches_invoice_number":
    case "ledger_matches_latest_invoice": {
      if (skipPositive) return { kind: check.kind, ok: true, detail: "Skipped because a person stopped the task." };
      const invoice =
        check.kind === "ledger_matches_invoice_number"
          ? findInvoice(world, check.invoiceNumber)
          : latestInvoiceForVendorQuery(world, check.vendorQuery);
      if (!invoice) {
        return { kind: check.kind, ok: false, detail: "No invoice matched that success check." };
      }
      const entry = world.ledger.find((row) => row.invoiceNumber === invoice.number);
      if (!entry) {
        return {
          kind: check.kind,
          ok: false,
          detail: `${invoice.number} (${invoice.amount} USD, due ${invoice.due}) is not on the ledger yet.`,
        };
      }
      const vendor = world.vendors.find((item) => item.id === invoice.vendorId);
      const aligned =
        entry.amount === invoice.amount &&
        entry.dueDate === invoice.due &&
        entry.vendorCode === vendor?.code;
      return aligned
        ? { kind: check.kind, ok: true, detail: `${invoice.number} is posted for ${invoice.amount} USD, due ${invoice.due}.` }
        : { kind: check.kind, ok: false, detail: `Ledger row for ${invoice.number} does not match the invoice document.` };
    }
    case "open_invoices_due_through_covered": {
      if (skipPositive) return { kind: check.kind, ok: true, detail: "Skipped because a person stopped the task." };
      const due = world.invoices.filter((invoice) => invoice.status === "open" && invoice.due <= check.through);
      const blob = `${proposal.summary}\n${proposal.claims.map((claim) => claim.statement).join("\n")}`.toUpperCase();
      const cited = new Set(proposal.claims.flatMap((claim) => claim.evidenceIds));
      const missing = due.filter((invoice) => !blob.includes(invoice.number) || !cited.has(invoice.id));
      return missing.length
        ? {
            kind: check.kind,
            ok: false,
            detail: `Still need amount, due date, and evidence for: ${missing.map((invoice) => invoice.number).join(", ")}. Include overdue open bills due on or before ${check.through}.`,
          }
        : { kind: check.kind, ok: true, detail: `Covered ${due.length} open bills due on or before ${check.through}.` };
    }
    default:
      return { kind: "unknown", ok: false, detail: "Unknown check." };
  }
}
