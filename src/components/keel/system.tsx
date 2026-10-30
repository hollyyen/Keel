export function SystemNote() {
  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-8">
      <p className="text-xs font-medium tracking-wide text-subtle uppercase">How Keel works</p>
      <h2 className="mt-2 font-display text-3xl leading-tight tracking-tight">
        A worker that has to touch the books.
      </h2>
      <div className="mt-6 space-y-6 text-sm text-muted">
        <p>
          Keel is not a chatbot with a script for one invoice. You give it the outcome. It uses the
          Marlow Goods back office the way a clerk would: look things up, write only what the system
          accepts, and prove the result from the records.
        </p>
        <Section title="1. Goal, not a click-path">
          The first action is a plan: what the request means, how to approach it, and which checks
          would prove it. A safety critic can add checks. It cannot delete them. “Book the latest
          Helios invoice” becomes a check that the ledger contains that invoice — the latest one by
          issue date, not whichever bill was easiest to see.
        </Section>
        <Section title="2. Tools against a real office">
          Mail, invoices, vendors, files, and the ledger are a small system with rules. The invoice
          index hides due dates. Posting rejects a trade name, a stale vendor code, a mismatched
          total, a duplicate, or a large bill with no approval. Those failures come from the office,
          and the next action is chosen after reading them.
        </Section>
        <Section title="3. One decision at a time">
          The model sees the goal, the plan, and what each tool returned. It does not get a hidden
          copy of the database. The same failing call is stopped after a few repeats. A run is
          capped at twelve steps.
        </Section>
        <Section title="4. People stay on the hook">
          Bills at or above a vendor’s threshold pause for approval. Anything that cannot be decided
          safely becomes a question. A banking-change email cannot be obeyed: there is no tool for
          it, and the plan is forced into a refusal that has to cite policy.
        </Section>
        <Section title="5. Done means checked">
          Finish is rejected until every success check passes and every claim points at a real
          record. If a claim names an amount or a date, that figure has to be on the cited record.
          The summary is the verified one, or it is not shown as done.
        </Section>
        <Section title="What stays the same for a new task">
          The loop, the tools, the office rules, and the verifier. A different sentence — post the
          Quill invoice, list what is due, mark a cleared bill paid — does not need a new program.
          Only the goal changes.
        </Section>
        <Section title="Limits">
          This office is a prototype world, not a live inbox or a browser for the public web. Vague
          goals can use up the step budget. The model can still choose a poor first step. The checks
          are what stop it from declaring victory anyway.
        </Section>
      </div>
    </article>
  );
}

function Section({ title, children }: { title: string; children: string }) {
  return (
    <section>
      <h3 className="text-base font-medium text-fg">{title}</h3>
      <p className="mt-1">{children}</p>
    </section>
  );
}
