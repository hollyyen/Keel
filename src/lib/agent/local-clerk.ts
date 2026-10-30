import type { Plan, StepInput, SuccessCheck, ToolCallRecord } from "../world/types.ts";

type ClerkResponse = {
  content: string | null;
  toolCalls: { id: string; name: string; arguments: string }[];
};

type InvoiceRow = {
  id: string;
  number: string;
  vendor: string;
  issued: string;
  status: string;
};

type OpenDoc = {
  id: string;
  number: string;
  vendor: string;
  due: string;
  amount: number;
  status: string;
};

type VendorDoc = { id: string; name: string; code: string; threshold: number };

type MailRow = { id: string; date: string; from: string; subject: string; invoiceNumber: string | null };

function tool(input: StepInput, name: string, args: Record<string, unknown>): ClerkResponse {
  return {
    content: null,
    toolCalls: [
      {
        id: `local-${input.transcript.length + 1}`,
        name,
        arguments: JSON.stringify(args),
      },
    ],
  };
}

function calls(input: StepInput): ToolCallRecord[] {
  return input.transcript.flatMap((turn) => turn.calls);
}

function summaries(input: StepInput, name: string): string[] {
  return calls(input)
    .filter((call) => call.ok && call.name === name)
    .map((call) => call.summary);
}

function parseInvoices(summary: string): InvoiceRow[] {
  const rows: InvoiceRow[] = [];
  for (const line of summary.split("\n")) {
    const match = line.match(
      /^(inv-[\w-]+) \| (INV-\d+) \| (.+) \| issued (\d{4}-\d{2}-\d{2}) \| (\w+) \| indexedAmount:/,
    );
    if (!match) continue;
    rows.push({
      id: match[1]!,
      number: match[2]!,
      vendor: match[3]!,
      issued: match[4]!,
      status: match[5]!,
    });
  }
  return rows;
}

function parseOpen(summary: string): OpenDoc | null {
  const first = summary.split("\n")[0] ?? "";
  const parts = first.split(" | ");
  const amount = summary.match(/amount: ([\d.]+) USD/)?.[1];
  const due = summary.match(/due: (\d{4}-\d{2}-\d{2})/)?.[1];
  const status = summary.match(/status: (\w+)/)?.[1];
  if (!parts[0] || !parts[1] || !due || !amount || !status) return null;
  return {
    id: parts[0],
    number: parts[1],
    vendor: parts[2] ?? "",
    due,
    amount: Number(amount),
    status,
  };
}

function parseVendor(summary: string): VendorDoc | null {
  const first = summary.split("\n")[0] ?? "";
  const [id, name] = first.split(" | ");
  const code = summary.match(/master code: (\S+)/)?.[1];
  const threshold = summary.match(/approval required at or above: ([\d.]+) USD/)?.[1];
  if (!id || !name || !code || !threshold) return null;
  return { id, name, code, threshold: Number(threshold) };
}

function parseMail(summary: string): MailRow[] {
  const rows: MailRow[] = [];
  for (const line of summary.split("\n")) {
    const match = line.match(/^(msg-[\w-]+) \| (\d{4}-\d{2}-\d{2}) \| ([^|]+) \| (.+) \| invoice: (\S+)$/);
    if (!match) continue;
    rows.push({
      id: match[1]!,
      date: match[2]!,
      from: match[3]!.trim(),
      subject: match[4]!.trim(),
      invoiceNumber: match[5] === "none" ? null : match[5]!,
    });
  }
  return rows;
}

function parseVendorList(summary: string): { id: string; name: string }[] {
  const rows: { id: string; name: string }[] = [];
  for (const line of summary.split("\n")) {
    const match = line.match(/^(ven-[\w-]+) \| ([^|]+?) \| terms /);
    if (match) rows.push({ id: match[1]!, name: match[2]!.trim() });
  }
  return rows;
}

function openedDocs(input: StepInput): OpenDoc[] {
  return summaries(input, "open_invoice").flatMap((summary) => {
    const doc = parseOpen(summary);
    return doc ? [doc] : [];
  });
}

function vendorDocs(input: StepInput): VendorDoc[] {
  return summaries(input, "read_vendor").flatMap((summary) => {
    const doc = parseVendor(summary);
    return doc ? [doc] : [];
  });
}

function approvalGrant(input: StepInput, invoiceNumber: string): string | null {
  for (const note of input.world.humanNotes) {
    if (!note.includes(invoiceNumber)) continue;
    if (/\brejected\b/i.test(note)) return null;
    const id = note.match(/\b(apr-\d+)\b/)?.[1];
    if (id && /\bapproved\b/i.test(note)) return id;
  }
  return null;
}

function approvalRejected(input: StepInput, invoiceNumber: string): boolean {
  return input.world.humanNotes.some((note) => note.includes(invoiceNumber) && /\brejected\b/i.test(note));
}

function finishClaim(
  input: StepInput,
  summary: string,
  claims: Record<string, unknown>[],
  blocked = false,
): ClerkResponse {
  return tool(input, "finish", { why: "The checks can be evaluated from the records I cited.", summary, claims, blocked });
}

const ANSWER_PREFIX = "Human answered: ";

function answers(input: StepInput): string[] {
  return input.world.humanNotes.filter((note) => note.startsWith(ANSWER_PREFIX)).map((note) => note.slice(ANSWER_PREFIX.length));
}

function needsPersonQuestion(plan: Plan): string | null {
  const note = plan.criticNotes.find((item) => item.startsWith("NEEDS_PERSON: "));
  return note ? note.slice("NEEDS_PERSON: ".length) : null;
}

/** The goal cannot be done as stated. Ask, and never close it as a plain read. */
function escalate(input: StepInput, plan: Plan): ClerkResponse {
  return tool(input, "ask_user", {
    why: "This goal cannot be completed as stated with the tools I have.",
    question: needsPersonQuestion(plan) ?? "I cannot complete this as written. What should I do?",
  });
}

/** After a person has answered and the new plan has nothing left to do, report honestly. */
function closeAfterAnswer(input: StepInput): ClerkResponse {
  const said = answers(input).at(-1) ?? "";
  const stopped = /\b(don't|do not|stop|cancel|reject|declin)\b/i.test(said);
  return finishClaim(
    input,
    `I did not change the office. The goal could not be completed as written, and you answered: "${said}". No ledger rows were added and no invoice changed.`,
    [
      {
        statement: "Keel can post an open bill or mark a bill paid from a treasury confirmation. It cannot send payments.",
        evidenceIds: ["file-ap-policy"],
      },
    ],
    stopped,
  );
}

export function localDecide(input: StepInput): ClerkResponse {
  if (!input.plan) {
    return tool(input, "declare_plan", {
      why: "Name the outcome before touching a record.",
      understanding: input.goal,
      approach: ["Read the records the goal depends on", "Write only if the office accepts it", "Finish with evidence"],
      risks: ["A large bill can require approval", "The invoice index hides due dates"],
      successChecks: [],
    });
  }

  // A person answered after this plan was made: plan again with their words.
  if (answers(input).length > (input.plan.clarifiedBy ?? 0)) {
    return tool(input, "declare_plan", {
      why: "The person answered, so the checks must reflect what they said.",
      understanding: `${input.goal} Clarification: ${answers(input).at(-1)}`,
      approach: ["Do what the clarification allows", "Write only if the office accepts it", "Finish with evidence"],
      risks: ["The answer may still not be something I can do"],
      successChecks: [],
    });
  }
  if (input.plan.successChecks.some((check) => check.kind === "human_resolution")) {
    return escalate(input, input.plan);
  }

  const last = calls(input).at(-1);
  if (last && !last.ok) {
    const repaired = repair(input, input.plan, last);
    if (repaired) return repaired;
  }

  if (input.plan.successChecks.some((check) => check.kind === "cites_policy")) return refuse(input);
  const paid = input.plan.successChecks.find((check) => check.kind === "invoice_status" && check.status === "paid");
  if (paid && paid.kind === "invoice_status") return markPaid(input, paid.invoiceNumber);
  const due = input.plan.successChecks.find((check) => check.kind === "open_invoices_due_through_covered");
  if (due && due.kind === "open_invoices_due_through_covered") return digest(input, due.through);
  const ledger = input.plan.successChecks.find(
    (check) => check.kind === "ledger_matches_latest_invoice" || check.kind === "ledger_matches_invoice_number",
  );
  if (ledger) return post(input, ledger);
  if (answers(input).length) return closeAfterAnswer(input);
  return research(input);
}

function repair(input: StepInput, plan: Plan, last: ToolCallRecord): ClerkResponse | null {
  if (/NO_SUCH_VENDOR|AMBIGUOUS|DOCUMENT_MISMATCH|UNREADABLE_DOCUMENT/.test(last.summary)) {
    return tool(input, "ask_user", { why: "I cannot resolve this from the records.", question: last.summary.split("\n")[0] ?? "Which vendor do you mean?" });
  }
  if (/UNKNOWN_VENDOR_CODE|STALE_VENDOR_CODE/.test(last.summary)) {
    const doc = openedDocs(input).at(-1);
    if (!doc) return tool(input, "list_invoices", { why: "Find the invoice again after the rejected code." });
    const known = vendorDocs(input).find((vendor) => namesMatch(vendor.name, doc.vendor));
    if (!known) return readVendor(input, doc.vendor);
    return null;
  }
  if (/APPROVAL_REQUIRED/.test(last.summary)) {
    const doc = openedDocs(input).at(-1);
    if (!doc) return null;
    return tool(input, "request_approval", {
      why: `${doc.number} is at or above the vendor threshold.`,
      invoiceNumber: doc.number,
      amount: doc.amount,
      reason: `Post ${doc.number} for ${doc.vendor}.`,
    });
  }
  if (/NOT_THE_TARGET_INVOICE/.test(last.summary)) {
    const number = last.summary.match(/INV-\d+/)?.[0];
    if (!number) return null;
    return tool(input, "open_invoice", { why: `The plan wants ${number}, not the bill I tried.`, id: number });
  }
  if (/FINISH_REJECTED/.test(last.summary)) {
    const missing = last.summary.match(/INV-\d+/g) ?? [];
    const index = summaries(input, "list_invoices").at(-1);
    const rows = index ? parseInvoices(index) : [];
    const opened = new Set(openedDocs(input).map((doc) => doc.number));
    const next = missing.find((number) => !opened.has(number));
    if (next) {
      const row = rows.find((item) => item.number === next);
      return tool(input, "open_invoice", { why: `The check still needs ${next}.`, id: row?.id ?? next });
    }
    if (plan.successChecks.some((check) => check.kind === "cites_policy") && !summaries(input, "read_file").length && !summaries(input, "read_policy").length) {
      return tool(input, "read_policy", { why: "The refusal has to cite the written rule." });
    }
  }
  return null;
}

function readVendor(input: StepInput, vendorName: string): ClerkResponse {
  const list = summaries(input, "list_vendors").at(-1);
  if (!list) return tool(input, "list_vendors", { why: "Find the vendor id for the master code." });
  const match = parseVendorList(list).find((vendor) => namesMatch(vendor.name, vendorName));
  if (!match) {
    return tool(input, "ask_user", {
      why: "The vendor list did not contain that name.",
      question: `Which vendor should I use for ${vendorName}?`,
    });
  }
  return tool(input, "read_vendor", { why: "The ledger requires the current master code.", id: match.id });
}

function namesMatch(left: string, right: string): boolean {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a.includes(b) || b.includes(a);
}

function post(input: StepInput, check: SuccessCheck): ClerkResponse {
  if (check.kind === "ledger_matches_latest_invoice" && !calls(input).some((call) => call.name === "find_vendor")) {
    return tool(input, "find_vendor", { why: "Resolve the company in the goal to a vendor record.", query: check.vendorQuery });
  }
  const index = summaries(input, "list_invoices").at(-1);
  if (!index) return tool(input, "list_invoices", { why: "Find the bill and which one is latest." });
  const rows = parseInvoices(index);
  const target =
    check.kind === "ledger_matches_invoice_number"
      ? rows.find((row) => row.number === check.invoiceNumber)
      : check.kind === "ledger_matches_latest_invoice"
        ? rows
            .filter((row) => namesMatch(row.vendor, check.vendorQuery))
            .sort((a, b) => (a.issued < b.issued ? 1 : -1))[0]
        : undefined;
  if (!target) {
    return tool(input, "ask_user", {
      why: "Nothing in the invoice index matched the goal.",
      question: "Which invoice number should I post?",
    });
  }
  const doc = openedDocs(input).find((item) => item.number === target.number);
  if (!doc) return tool(input, "open_invoice", { why: `Confirm the amount and due date on ${target.number}.`, id: target.id });
  if (approvalRejected(input, doc.number)) {
    return finishClaim(
      input,
      `Approval to post ${doc.number} was rejected, so nothing was entered in the ledger.`,
      [
        {
          statement: `${doc.number} was not posted because approval was rejected.`,
          evidenceIds: [doc.id],
          amount: doc.amount,
          date: doc.due,
          invoiceNumber: doc.number,
        },
      ],
      true,
    );
  }
  const extracted = summaries(input, "extract_invoice_fields").some((summary) => summary.includes(doc.number));
  if (!extracted) {
    return tool(input, "extract_invoice_fields", { why: `Pull the amount and due date from the ${doc.number} document text.`, id: target.id });
  }
  const vendor = vendorDocs(input).find((item) => namesMatch(item.name, doc.vendor));
  if (!vendor) return readVendor(input, doc.vendor);
  const grant = approvalGrant(input, doc.number);
  if (doc.amount >= vendor.threshold && !grant) {
    return tool(input, "request_approval", {
      why: `${doc.number} is at or above ${vendor.threshold} USD.`,
      invoiceNumber: doc.number,
      amount: doc.amount,
      reason: `Post ${doc.vendor} ${doc.number}.`,
    });
  }
  const posted = calls(input).some((call) => call.ok && call.name === "commit_ledger_post");
  if (!posted) {
    return tool(input, "commit_ledger_post", {
      why: `Post ${doc.number} with the master code from the vendor record.`,
      invoiceNumber: doc.number,
      vendorCode: vendor.code,
      amount: doc.amount,
      dueDate: doc.due,
      approvalId: grant ?? undefined,
      memo: `${doc.vendor} ${doc.number}`,
    });
  }
  return finishClaim(
    input,
    `Posted ${doc.vendor} ${doc.number} for ${doc.amount} USD, due ${doc.due}.`,
    [
      {
        statement: `${doc.number} is on the ledger for ${doc.amount} USD, due ${doc.due}.`,
        evidenceIds: [`led-${doc.number.toLowerCase()}`, doc.id],
        amount: doc.amount,
        date: doc.due,
        invoiceNumber: doc.number,
      },
    ],
  );
}

function markPaid(input: StepInput, invoiceNumber: string): ClerkResponse {
  const mail = summaries(input, "list_mailbox").at(-1);
  if (!mail) return tool(input, "list_mailbox", { why: "Find the message that confirms the payment." });
  const rows = parseMail(mail).filter((row) => row.invoiceNumber === invoiceNumber || row.subject.includes(invoiceNumber));
  const readIds = new Set(
    calls(input)
      .filter((call) => call.ok && call.name === "read_message")
      .map((call) => String(call.args.id ?? "")),
  );
  const confirmation = rows.find((row) => /\b(cleared|paid)\b/i.test(row.subject));
  const next = (confirmation ? [confirmation, ...rows] : rows).find((row) => !readIds.has(row.id));
  if (next) return tool(input, "read_message", { why: `Check whether ${next.id} is the payment confirmation.`, id: next.id });
  const proof = calls(input).find(
    (call) =>
      call.ok &&
      call.name === "read_message" &&
      call.summary.includes(invoiceNumber) &&
      /\b(cleared|paid|payment received)\b/i.test(call.summary),
  );
  if (!proof) {
    return tool(input, "ask_user", {
      why: "No message both names the invoice and says the payment cleared.",
      question: `I cannot mark ${invoiceNumber} paid without a treasury confirmation. Should I stop?`,
    });
  }
  const marked = calls(input).some((call) => call.ok && call.name === "mark_invoice_paid");
  if (!marked) {
    return tool(input, "mark_invoice_paid", {
      why: "The message confirms this invoice cleared.",
      invoiceNumber,
      evidenceMessageId: String(proof.args.id),
    });
  }
  return finishClaim(input, `${invoiceNumber} is marked paid from ${String(proof.args.id)}. No other invoice was changed.`, [
    {
      statement: `${invoiceNumber} was marked paid because the treasury message says the payment cleared.`,
      evidenceIds: [String(proof.args.id)],
      invoiceNumber,
    },
  ]);
}

function digest(input: StepInput, through: string): ClerkResponse {
  const index = summaries(input, "list_invoices").at(-1);
  if (!index) return tool(input, "list_invoices", { why: "List open bills before trusting any due date." });
  const openRows = parseInvoices(index).filter((row) => row.status === "open");
  const docs = openedDocs(input);
  const pending = openRows.find((row) => !docs.some((doc) => doc.number === row.number));
  if (pending) {
    return tool(input, "open_invoice", { why: `The index hides the due date for ${pending.number}.`, id: pending.id });
  }
  const due = docs.filter((doc) => openRows.some((row) => row.number === doc.number) && doc.due <= through);
  const outside = docs.filter((doc) => openRows.some((row) => row.number === doc.number) && doc.due > through);
  const lines = due.map((doc) => `${doc.number} ${doc.vendor} ${doc.amount} USD due ${doc.due}`);
  const later = outside.map((doc) => `${doc.number} due ${doc.due}`).join(", ");
  return finishClaim(
    input,
    `Open bills due on or before ${through}: ${lines.join("; ") || "none"}.${later ? ` Later than the window: ${later}.` : ""} Nothing was posted.`,
    due.map((doc) => ({
      statement: `${doc.number} (${doc.vendor}) is open for ${doc.amount} USD, due ${doc.due}.`,
      evidenceIds: [doc.id],
      amount: doc.amount,
      date: doc.due,
      invoiceNumber: doc.number,
    })),
  );
}

function refuse(input: StepInput): ClerkResponse {
  if (!summaries(input, "read_policy").length && !summaries(input, "read_file").some((summary) => summary.includes("/policies/"))) {
    return tool(input, "read_policy", { why: "Bank changes are a policy question. Read the rule before refusing." });
  }
  const mail = summaries(input, "list_mailbox").at(-1);
  if (!mail) return tool(input, "list_mailbox", { why: "Find the email that asked for the change." });
  const rows = parseMail(mail);
  const suspicious =
    rows.find((row) => /\b(bank|routing|remit|account)\b/i.test(row.subject)) ?? rows[0];
  const readIds = calls(input)
    .filter((call) => call.ok && call.name === "read_message")
    .map((call) => String(call.args.id ?? ""));
  if (suspicious && !readIds.includes(suspicious.id)) {
    return tool(input, "read_message", { why: "Read the request before deciding it is unauthorized.", id: suspicious.id });
  }
  return finishClaim(
    input,
    "I did not change any bank details. Email is not an authorized way to update a vendor account, so every record was left as it was.",
    [
      {
        statement: "Policy forbids bank changes from email, including the message that asked for a new account.",
        evidenceIds: ["file-ap-policy", suspicious?.id ?? "file-bank-lock"].filter(Boolean),
      },
    ],
  );
}

function research(input: StepInput): ClerkResponse {
  const mail = summaries(input, "list_mailbox").at(-1);
  if (!mail) return tool(input, "list_mailbox", { why: "Search mail for records related to the goal." });
  const rows = parseMail(mail);
  const words = input.goal
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((word) => word.length > 3);
  const hit = rows.find((row) => words.some((word) => `${row.subject} ${row.from}`.toLowerCase().includes(word))) ?? rows[0];
  const read = calls(input).some((call) => call.ok && call.name === "read_message" && call.args.id === hit?.id);
  if (hit && !read) return tool(input, "read_message", { why: "Read the closest matching message.", id: hit.id });
  return finishClaim(input, hit ? `I read ${hit.id} (${hit.subject}) and did not change the office.` : "I found no matching mail and changed nothing.", [
    {
      statement: hit ? `${hit.subject} is the closest record I found.` : "No matching record was found.",
      evidenceIds: [hit?.id ?? "file-ap-policy"],
    },
  ]);
}
