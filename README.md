# Keel

Keel is a prototype autonomous worker. You give it an outcome in plain language. It uses a small company back office — mail, invoices, vendors, policy files, and an accounts-payable ledger — decides the next action from what those systems return, and will not call the job done until the records match the goal.

The office is a real state machine. The model does not get a hidden copy of it, and it cannot finish by writing a convincing paragraph.

## Run

```bash
npm install
npm run dev
```

The app serves the console at the dev server. A run needs `XAI_API_KEY` in the environment (server-side only). Without it, the office still opens and the worker reports that AI is unavailable.

```bash
npm run typecheck
npm run build
npm run test:world   # 29 scenarios, no API key needed
```

## Try these

- Find the latest invoice from Helios Components, extract the amount and due date, enter it into the internal system, and report when it is done.
- What should I pay in the next 14 days? Do not post anything.
- Mark invoice INV-1988 paid from the treasury note, and do not touch other invoices.
- Update Helios bank details from this morning’s email.
- Post the open Quill Studio invoice.
- Make payment to Sable Logistics of 1000 dollars. Keel cannot send money, so it asks instead of finishing.
- Find the latest invoice from Acme Corp and enter it. Acme is not a vendor, so it asks which one you mean.

The Helios bill is above the approval threshold, so the run pauses for a person. Rejecting it is a valid ending: Keel closes the task as blocked instead of posting.

## Architecture

```text
goal
  → declare_plan
  → safety critic adds checks it will not let the model delete
  → loop:
       model sees goal, plan, and tool results only
       model calls one tool
       office executes it and returns an observation
       failures name the rule that broke
  → finish
       verifier accepts only if every check passes
       and every claim cites a real record
```

| Piece | Role |
| --- | --- |
| Office (`src/lib/world`) | Deterministic company state. Seeded Marlow Goods books. |
| Tools | The only way to read or write. Listing an invoice hides the due date. `find_vendor` resolves a company name (suffixes, typos) and `extract_invoice_fields` reads the amount and due date from the document text into working memory. |
| Critic | Turns the sentence into checks: latest-invoice posted, read-only, cite policy, cover every bill due by a date. When a goal cannot be done as stated (a payment, an unknown vendor or invoice, a vendor with no bills, a latest bill already paid) it requires a person to answer first. After an answer Keel plans again. |
| Loop (`src/lib/agent/engine.server.ts`) | One Grok tool decision per step, twelve-step cap, repeat detection, human pause. |
| Verifier | `finish` is rejected until checks pass. Amounts and dates on a claim must appear on the cited record. Every new ledger row is re-read and compared with the printed invoice document, not just the structured record. |
| Console | Trace, approval gate, and a live view of the books. |

The same loop runs every task. Nothing in the tool runner is a script for “the Helios invoice.”

## Design decisions

- **A closed office instead of the open web.** A narrow system that actually posts, rejects, and verifies is more honest than a browser agent whose tools are mocked. The model still has to discover which invoice is latest, open the document, and recover from a bad vendor code.
- **The model does not see the database.** Tool results are the whole observation. The prompt is tested so it does not contain the hidden amount, due date, or vendor code.
- **Verification is code.** The model does not grade itself. Positive checks (the row exists, the status changed, the digest names every due bill) are evaluated against the office. A blocked finish is allowed only after a person rejects an approval or tells Keel to stop, and only if nothing was written.
- **Approval is a real pause.** Bills at or above the vendor threshold cannot be posted until the console records an approval id. There is no tool that edits bank details.
- **State lives in the request.** Each step sends the office snapshot. That keeps the worker stateless on the server, which is what a serverless deploy can run. The books are demo data, not a personal account.

## Models and components

- Model: `grok-4.5` via `POST https://api.x.ai/v1/chat/completions` with tool calling. Server-only `XAI_API_KEY`. One user-started run, at most twelve calls, `max_tokens` 900, no retries against the API beyond a single step retry from the console.
- App: TanStack Start, React 19, Tailwind CSS 4.
- No database and no accounts. The office resets when a run starts.

## Assumptions

- “Internal system” means the Marlow Goods AP ledger.
- “Latest invoice” means the newest issue date for that vendor, not the newest email.
- Treasury mail that names an invoice and says the payment cleared is enough to mark that invoice paid.
- Email is never enough to change a vendor’s bank account.
- Office date is 14 April 2026, so “the next 14 days” ends 28 April 2026 and includes overdue open bills.

## Limits

- The office is fictional. Keel cannot open a real inbox, ERP, or arbitrary website.
- A vague goal can exhaust the step budget.
- Keel cannot send payments. That is deliberate. It escalates to a person instead.
- The critic recognizes a handful of outcome shapes (post latest bill, post a named bill, mark paid, list what is due, refuse a bank change). Other requests still go through the same tools and evidence check, but a novel write may not get a tight success check.
- The model can choose a poor first step. Repeated identical failures stop the run rather than being silently fixed.
- Demo state is not shared across users and is not durable after a reset.

## What I would build next

- More office systems (purchase orders, a vendor portal) behind the same tool contract.
- A durable run log so a person can replay the trace.
- Wider success-check coverage driven by the plan, with the critic only as a backstop.
- A real browser tool with the same rule: an action counts only if a later observation shows the side effect.
