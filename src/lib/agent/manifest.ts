export const TOOL_MANIFEST = [
  {
    type: "function",
    function: {
      name: "declare_plan",
      description:
        "Call this first, before any other tool. State what the user wants, the approach, risks, and successChecks. The server may add checks. Kinds: ledger_matches_latest_invoice (vendorQuery), ledger_matches_invoice_number (invoiceNumber), invoice_status (invoiceNumber, status), only_invoice_touch (invoiceNumber), no_new_ledger_entries, no_invoice_status_changes, cites_policy, open_invoices_due_through_covered (through YYYY-MM-DD), answered_with_evidence. If a person has answered a question, call declare_plan again so the checks reflect their answer.",
      parameters: {
        type: "object",
        properties: {
          why: { type: "string" },
          understanding: { type: "string" },
          approach: { type: "array", items: { type: "string" } },
          risks: { type: "array", items: { type: "string" } },
          successChecks: { type: "array", items: { type: "object" } },
        },
        required: ["why", "understanding", "approach", "successChecks"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_mailbox",
      description: "List messages. Does not include bodies.",
      parameters: { type: "object", properties: { why: { type: "string" } }, required: ["why"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_message",
      description: "Read one message body by id.",
      parameters: {
        type: "object",
        properties: { why: { type: "string" }, id: { type: "string" } },
        required: ["why", "id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_invoices",
      description:
        "Invoice index only. Due dates are hidden. indexedAmount can be blank until you open the invoice. Compare issued dates to see which bill is latest.",
      parameters: { type: "object", properties: { why: { type: "string" } }, required: ["why"] },
    },
  },
  {
    type: "function",
    function: {
      name: "open_invoice",
      description: "Open an invoice document. This is the source of truth for amount, due date, and line items.",
      parameters: {
        type: "object",
        properties: {
          why: { type: "string" },
          id: { type: "string", description: "Invoice id or number, such as inv-2077 or INV-2077." },
        },
        required: ["why", "id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_vendors",
      description: "List vendors without master codes.",
      parameters: { type: "object", properties: { why: { type: "string" } }, required: ["why"] },
    },
  },
  {
    type: "function",
    function: {
      name: "find_vendor",
      description:
        "Resolve a vendor name from the goal to a vendor id. Tolerates 'Inc', 'LLC' and small typos. Returns MATCH, AMBIGUOUS, or NO_SUCH_VENDOR. Use this first when the goal names a company. On NO_SUCH_VENDOR or AMBIGUOUS, ask_user rather than guessing.",
      parameters: {
        type: "object",
        properties: { why: { type: "string" }, query: { type: "string", description: "The vendor name as the user wrote it." } },
        required: ["why", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "extract_invoice_fields",
      description:
        "Extract amount, due date, issue date, PO and line items from the invoice document text, check that the lines add up to the total, and save the result to working memory. Use before posting so the values you post come from the document.",
      parameters: {
        type: "object",
        properties: { why: { type: "string" }, id: { type: "string", description: "Invoice id or number." } },
        required: ["why", "id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_vendor",
      description: "Read the vendor master: current code, retired codes, approval threshold, bank lock.",
      parameters: {
        type: "object",
        properties: { why: { type: "string" }, id: { type: "string" } },
        required: ["why", "id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List policy and reference files.",
      parameters: { type: "object", properties: { why: { type: "string" } }, required: ["why"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file by id or path.",
      parameters: {
        type: "object",
        properties: { why: { type: "string" }, id: { type: "string" }, path: { type: "string" } },
        required: ["why"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_policy",
      description: "Read the AP posting policy.",
      parameters: { type: "object", properties: { why: { type: "string" } }, required: ["why"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_ledger",
      description: "List AP ledger rows already posted.",
      parameters: { type: "object", properties: { why: { type: "string" } }, required: ["why"] },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description: "Save a short fact (amount, due date, vendor code) into working memory.",
      parameters: {
        type: "object",
        properties: { why: { type: "string" }, key: { type: "string" }, value: { type: "string" } },
        required: ["why", "key", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_approval",
      description:
        "Ask a person to approve a bill at or above the vendor threshold. Pauses the run. Do not commit until a later observation says the approval was granted.",
      parameters: {
        type: "object",
        properties: {
          why: { type: "string" },
          invoiceNumber: { type: "string" },
          amount: { type: "number" },
          reason: { type: "string" },
        },
        required: ["why", "invoiceNumber", "amount", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "commit_ledger_post",
      description:
        "Post one open invoice to the AP ledger. Amount and due date must match the opened invoice. vendorCode must be the current master code. Large bills need an approved approvalId. A wrong guess returns a specific error — read it and change the arguments.",
      parameters: {
        type: "object",
        properties: {
          why: { type: "string" },
          invoiceNumber: { type: "string" },
          vendorCode: { type: "string" },
          amount: { type: "number" },
          dueDate: { type: "string", description: "YYYY-MM-DD" },
          memo: { type: "string" },
          approvalId: { type: "string" },
        },
        required: ["why", "invoiceNumber", "vendorCode", "amount", "dueDate"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mark_invoice_paid",
      description:
        "Mark one invoice paid. evidenceMessageId must be a message that names that invoice and confirms the payment cleared. Does not post a ledger row.",
      parameters: {
        type: "object",
        properties: {
          why: { type: "string" },
          invoiceNumber: { type: "string" },
          evidenceMessageId: { type: "string" },
        },
        required: ["why", "invoiceNumber", "evidenceMessageId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Pause and ask a person. Use it when the goal needs something you have no tool for (for example sending money), when a vendor or invoice is unknown or ambiguous, or when you cannot safely proceed. Use this instead of guessing.",
      parameters: {
        type: "object",
        properties: { why: { type: "string" }, question: { type: "string" } },
        required: ["why", "question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description:
        "Complete the run. Rejected unless every success check passes and every claim is backed by real evidence ids. Set blocked true only after a person rejected the approval or told you to stop, and only if you changed nothing.",
      parameters: {
        type: "object",
        properties: {
          why: { type: "string" },
          summary: { type: "string" },
          blocked: { type: "boolean" },
          claims: {
            type: "array",
            items: {
              type: "object",
              properties: {
                statement: { type: "string" },
                evidenceIds: { type: "array", items: { type: "string" } },
                amount: { type: "number" },
                date: { type: "string" },
                invoiceNumber: { type: "string" },
              },
              required: ["statement", "evidenceIds"],
            },
          },
        },
        required: ["why", "summary", "claims"],
      },
    },
  },
] as const;
