export type InvoiceStatus = "open" | "posted" | "paid" | "disputed";

export type Vendor = {
  id: string;
  name: string;
  aliases: string[];
  code: string;
  retiredCodes: string[];
  approvalAtOrAbove: number;
  bankLast4: string;
  bankChangesLocked: boolean;
  terms: string;
};

export type InvoiceLine = { description: string; amount: number };

export type Invoice = {
  id: string;
  number: string;
  vendorId: string;
  issued: string;
  due: string;
  amount: number;
  status: InvoiceStatus;
  po: string;
  lines: InvoiceLine[];
  /** Null when the index must not be trusted until the document is opened. */
  indexedAmount: number | null;
  document: string;
};

export type MailMessage = {
  id: string;
  date: string;
  from: string;
  subject: string;
  body: string;
  invoiceNumber: string | null;
};

export type LedgerEntry = {
  id: string;
  invoiceNumber: string;
  vendorCode: string;
  vendorName: string;
  amount: number;
  dueDate: string;
  memo: string;
  approvalId: string | null;
  postedOn: string;
};

export type OfficeFile = {
  id: string;
  path: string;
  title: string;
  body: string;
};

export type ApprovalStatus = "pending" | "approved" | "rejected";

export type Approval = {
  id: string;
  vendorId: string;
  invoiceNumber: string;
  amount: number;
  reason: string;
  status: ApprovalStatus;
};

export type MemoryNote = { key: string; value: string };

export type World = {
  today: string;
  company: string;
  vendors: Vendor[];
  invoices: Invoice[];
  messages: MailMessage[];
  ledger: LedgerEntry[];
  files: OfficeFile[];
  approvals: Approval[];
  memory: MemoryNote[];
  humanNotes: string[];
};

export type Baseline = {
  ledgerIds: string[];
  invoiceStatus: Record<string, InvoiceStatus>;
};

export type SuccessCheck =
  | { kind: "ledger_matches_latest_invoice"; vendorQuery: string }
  | { kind: "ledger_matches_invoice_number"; invoiceNumber: string }
  | { kind: "invoice_status"; invoiceNumber: string; status: InvoiceStatus }
  | { kind: "only_invoice_touch"; invoiceNumber: string }
  | { kind: "no_new_ledger_entries" }
  | { kind: "no_invoice_status_changes" }
  | { kind: "cites_policy" }
  /** The goal cannot be completed as stated. A person must answer before Keel may finish. `after` = answers already seen when the plan was made. */
  | { kind: "human_resolution"; after: number }
  | { kind: "open_invoices_due_through_covered"; through: string }
  | { kind: "answered_with_evidence" };

export type Plan = {
  understanding: string;
  approach: string[];
  risks: string[];
  successChecks: SuccessCheck[];
  criticNotes: string[];
  /** How many human answers had been given when this plan was built. */
  clarifiedBy?: number;
};

export type Claim = {
  statement: string;
  evidenceIds: string[];
  amount?: number;
  date?: string;
  invoiceNumber?: string;
};

export type ToolCallRecord = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  spotlight?: string;
};

export type AssistantTurn = {
  role: "assistant";
  content: string | null;
  tool_calls: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
};

export type TranscriptTurn = {
  thought: string;
  calls: ToolCallRecord[];
  assistant: AssistantTurn;
};

export type Resolution =
  | { kind: "approval"; approvalId: string; decision: "approved" | "rejected" }
  | { kind: "answer"; text: string };

export type PendingAsk = {
  kind: "approval" | "clarify";
  question: string;
  detail: string;
  approvalId?: string;
};

export type CheckResult = { kind: string; ok: boolean; detail: string };

export type Outcome = {
  summary: string;
  claims: Claim[];
  checks: CheckResult[];
  blocked: boolean;
};

export type StepStatus = "continue" | "needs_user" | "done" | "stopped" | "error";

export type Brain = "grok" | "local";

export type StepInput = {
  goal: string;
  world: World;
  baseline: Baseline;
  plan: Plan | null;
  transcript: TranscriptTurn[];
  resolution?: Resolution | null;
  brain?: Brain;
};

export type StepResult = {
  status: StepStatus;
  world: World;
  plan: Plan | null;
  transcript: TranscriptTurn[];
  pending: PendingAsk | null;
  outcome: Outcome | null;
  brain: Brain;
  error?: string;
};

export type FinishProposal = {
  summary: string;
  claims: Claim[];
  blocked: boolean;
};
