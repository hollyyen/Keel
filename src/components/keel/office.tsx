import type { ReactNode } from "react";
import { money, prettyDate } from "@/lib/world/format";
import type { Baseline, World } from "@/lib/world/types";

export type OfficeTab = "mail" | "invoices" | "ledger" | "vendors" | "files";

const TABS: { id: OfficeTab; label: string }[] = [
  { id: "mail", label: "Mail" },
  { id: "invoices", label: "Invoices" },
  { id: "ledger", label: "Ledger" },
  { id: "vendors", label: "Vendors" },
  { id: "files", label: "Files" },
];

export function tabForRecord(id: string): OfficeTab | null {
  if (id.startsWith("msg-")) return "mail";
  if (id.startsWith("inv-")) return "invoices";
  if (id.startsWith("led-") || id.startsWith("apr-")) return "ledger";
  if (id.startsWith("ven-")) return "vendors";
  if (id.startsWith("file-")) return "files";
  return null;
}

type Props = {
  world: World;
  baseline: Baseline;
  tab: OfficeTab;
  selected: string | null;
  onTab: (tab: OfficeTab) => void;
  onSelect: (id: string) => void;
};

export function Office({ world, baseline, tab, selected, onTab, onSelect }: Props) {
  const knownLedger = new Set(baseline.ledgerIds);
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-bg">
      <div className="border-b border-line px-4 py-4">
        <p className="text-xs font-medium tracking-wide text-subtle uppercase">Back office</p>
        <h2 className="font-display text-xl leading-tight">{world.company}</h2>
        <p className="mt-1 text-sm text-muted">
          Books as of {prettyDate(world.today)}. Keel only sees what a tool returns.
        </p>
      </div>
      <div className="flex gap-1 overflow-x-auto border-b border-line px-3" role="tablist">
        {TABS.map((item) => {
          const active = item.id === tab;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={
                "h-11 shrink-0 border-b-2 px-3 text-sm font-medium " +
                (active ? "border-fg text-fg" : "border-transparent text-muted")
              }
              onClick={() => onTab(item.id)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {tab === "mail" && (
          <RecordList>
            {[...world.messages]
              .sort((a, b) => (a.date < b.date ? 1 : -1))
              .map((message) => (
                <RecordButton
                  key={message.id}
                  active={selected === message.id}
                  onClick={() => onSelect(message.id)}
                  title={message.subject}
                  meta={`${prettyDate(message.date)} · ${message.from}`}
                />
              ))}
          </RecordList>
        )}
        {tab === "invoices" && (
          <RecordList>
            {[...world.invoices]
              .sort((a, b) => (a.issued < b.issued ? 1 : -1))
              .map((invoice) => {
                const vendor = world.vendors.find((item) => item.id === invoice.vendorId);
                const changed = baseline.invoiceStatus[invoice.number] !== invoice.status;
                return (
                  <RecordButton
                    key={invoice.id}
                    active={selected === invoice.id}
                    changed={changed}
                    onClick={() => onSelect(invoice.id)}
                    title={`${invoice.number} · ${money(invoice.amount)}`}
                    meta={`${vendor?.name ?? ""} · ${invoice.status} · due ${prettyDate(invoice.due)}`}
                  />
                );
              })}
          </RecordList>
        )}
        {tab === "ledger" && (
          <div className="space-y-4">
            <RecordList>
              {world.ledger.map((entry) => (
                <RecordButton
                  key={entry.id}
                  active={selected === entry.id}
                  changed={!knownLedger.has(entry.id)}
                  onClick={() => onSelect(entry.id)}
                  title={`${entry.invoiceNumber} · ${money(entry.amount)}`}
                  meta={`${entry.vendorCode} · due ${prettyDate(entry.dueDate)}`}
                />
              ))}
            </RecordList>
            {world.approvals.length > 0 && (
              <div>
                <p className="mb-2 px-1 text-xs font-medium tracking-wide text-subtle uppercase">Approvals</p>
                <RecordList>
                  {world.approvals.map((approval) => (
                    <RecordButton
                      key={approval.id}
                      active={selected === approval.id}
                      changed
                      onClick={() => onSelect(approval.id)}
                      title={`${approval.id} · ${approval.invoiceNumber}`}
                      meta={`${approval.status} · ${money(approval.amount)}`}
                    />
                  ))}
                </RecordList>
              </div>
            )}
          </div>
        )}
        {tab === "vendors" && (
          <RecordList>
            {world.vendors.map((vendor) => (
              <RecordButton
                key={vendor.id}
                active={selected === vendor.id}
                onClick={() => onSelect(vendor.id)}
                title={vendor.name}
                meta={`${vendor.code} · approval at ${money(vendor.approvalAtOrAbove)}`}
              />
            ))}
          </RecordList>
        )}
        {tab === "files" && (
          <RecordList>
            {world.files.map((file) => (
              <RecordButton
                key={file.id}
                active={selected === file.id}
                onClick={() => onSelect(file.id)}
                title={file.title}
                meta={file.path}
              />
            ))}
          </RecordList>
        )}
        <Detail world={world} selected={selected} />
      </div>
    </section>
  );
}

function RecordList({ children }: { children: ReactNode }) {
  return <div className="space-y-2">{children}</div>;
}

function RecordButton({
  title,
  meta,
  active,
  changed,
  onClick,
}: {
  title: string;
  meta: string;
  active: boolean;
  changed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "w-full rounded-md border px-3 py-3 text-left " +
        (active ? "border-muted bg-raised" : "border-line bg-surface")
      }
    >
      <span className="flex items-start justify-between gap-3">
        <span className="text-sm font-medium text-fg">{title}</span>
        {changed && <span className="shrink-0 text-xs font-medium text-ok">Changed</span>}
      </span>
      <span className="mt-1 block text-sm text-muted">{meta}</span>
    </button>
  );
}

function Detail({ world, selected }: { world: World; selected: string | null }) {
  if (!selected) {
    return <p className="px-1 py-4 text-sm text-subtle">Select a record to read it.</p>;
  }
  const message = world.messages.find((item) => item.id === selected);
  const invoice = world.invoices.find((item) => item.id === selected);
  const entry = world.ledger.find((item) => item.id === selected);
  const vendor = world.vendors.find((item) => item.id === selected);
  const file = world.files.find((item) => item.id === selected);
  const approval = world.approvals.find((item) => item.id === selected);
  const body = message?.body || invoice?.document || file?.body;
  const heading =
    message?.subject ||
    invoice?.number ||
    (entry ? `${entry.invoiceNumber} posted` : "") ||
    vendor?.name ||
    file?.title ||
    approval?.id ||
    selected;
  const facts: { label: string; value: string }[] = [];
  if (entry) {
    facts.push(
      { label: "Vendor", value: `${entry.vendorName} (${entry.vendorCode})` },
      { label: "Amount", value: money(entry.amount) },
      { label: "Due", value: prettyDate(entry.dueDate) },
      { label: "Posted", value: prettyDate(entry.postedOn) },
      { label: "Approval", value: entry.approvalId ?? "Not required" },
      { label: "Memo", value: entry.memo },
    );
  }
  if (vendor) {
    facts.push(
      { label: "Master code", value: vendor.code },
      { label: "Retired", value: vendor.retiredCodes.join(", ") },
      { label: "Threshold", value: money(vendor.approvalAtOrAbove) },
      { label: "Bank ends", value: vendor.bankLast4 },
      { label: "Bank changes", value: vendor.bankChangesLocked ? "Locked" : "Open" },
    );
  }
  if (approval) {
    facts.push(
      { label: "Invoice", value: approval.invoiceNumber },
      { label: "Amount", value: money(approval.amount) },
      { label: "Status", value: approval.status },
      { label: "Reason", value: approval.reason },
    );
  }
  return (
    <article className="mt-4 rounded-xl bg-surface p-4">
      <h3 className="text-sm font-medium">{heading}</h3>
      {facts.length > 0 && (
        <dl className="mt-3 space-y-2">
          {facts.map((fact) => (
            <div key={fact.label} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 text-sm">
              <dt className="text-subtle">{fact.label}</dt>
              <dd className="text-fg">{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {body && (
        <pre className="mt-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted">{body}</pre>
      )}
    </article>
  );
}
