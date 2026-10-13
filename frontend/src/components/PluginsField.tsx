"use client";

/**
 * _Protocol plugins_ on the loop form: a switch, then a picker over the plugin catalog
 * (`lib/plugin-catalog.ts`).
 *
 * The one entry is SAS · receipt, which is not a grant: picked, the start body carries the console's
 * receipt pointer (`LoopStartForm`), and the section shows its summary. Switching the section on with
 * nothing picked picks it. The grant plugins, Squads · pay and SAS · attest, with the terms every grant
 * shares (the mandate, the bar, proposals a step, the expiry), are on the roadmap and not in this build,
 * and the console refuses a start that carries grants.
 *
 * Shown only on a console that reports `protocolPlugins: on`, and sent only while switched on: a start
 * without it carries no `receipt` key, so its policy hash is the one a policy without plugins hashes to. What it
 * sends rides in the start body, which the one `"Lath loop"` message binds through `Request ID`.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button } from "@/components/ui";
import { SectionToggle } from "@/components/loop-terms";
import { PLUGIN_CATALOG, SAS_RECEIPT, receiptPicked } from "@/lib/plugin-catalog";
import {
  NOTHING_PICKED,
  RECEIPT_CHIPS,
  RECEIPT_SUMMARY,
  SAS_DEMO_CREDENTIAL_NAME,
  SAS_RECEIPT_SCHEMA_NAME,
  pluginsConsoleOf,
  type AttestDemo,
  type PluginsConsole,
} from "@/lib/plugins-view";

/**
 * An agent id no loop has, so the plugin read is the list route's top-level fields over an empty
 * list: `useLoops` keeps only `loops` and `limits` of the answer, and a second full list per form
 * would be a read of every row for two fields.
 */
const NO_AGENT = "0".repeat(64);

/** Whether this console offers protocol plugins, and the SAS issuer the receipt is published under. */
export function usePluginsConsole(enabled = true) {
  return useQuery({
    queryKey: ["loops-plugins-console"] as const,
    enabled,
    queryFn: async (): Promise<PluginsConsole> => {
      const res = await fetch(`/api/loops?agent=${NO_AGENT}`);
      if (!res.ok) throw new Error(`the loop registry answered ${res.status}`);
      return pluginsConsoleOf(await res.json());
    },
    staleTime: 60_000,
  });
}

/** An address as the section shows it: its first and last four characters. */
const short = (s: string) => (s.trim().length > 12 ? `${s.trim().slice(0, 4)}…${s.trim().slice(-4)}` : s.trim());

/**
 * What a protocol plugin is, said for the one this console offers. The plugins that act after each step
 * within a grant the owner signs — Squads · pay, SAS · attest — are on the roadmap, and the copy says so
 * rather than describe a grant the console would refuse.
 */
const PLUGINS_COPY =
  "A protocol plugin lets the loop act on a Solana protocol. This console offers one, SAS · receipt. Plugins " +
  "that act after each step within a grant you sign with the loop are on the roadmap.";

/**
 * SAS · receipt in plain words: an index that points at the records, never the proof, and published only
 * on Jev's `achieved`.
 */
const RECEIPT_COPY =
  "With SAS · receipt, when the decision model answers that the goal is achieved and the loop stops on it, " +
  "the console publishes one attestation on the Solana Attestation Service that points at the loop's records: " +
  "the agent, the loop, its last step's position in the chain, the step count, the goal's hash, and what the " +
  "loop cost in USDC and on Tempo. The console's key signs it under the lath-demo credential and Lath pays its " +
  "rent. A loop stopped by hand, by its budget or by an error gets none.";

export function PluginsField({
  on,
  setOn,
  picked,
  setPicked,
}: {
  on: boolean;
  setOn: (v: boolean) => void;
  /** The catalog ids picked, `sas.receipt` and so on. */
  picked: string[];
  setPicked: (ids: string[]) => void;
}) {
  // The SAS demo from the same cached read the form makes (`usePluginsConsole`), so the form passes
  // no SAS props of its own.
  const consoleRead = usePluginsConsole();
  const attest = consoleRead.data?.attestDemo ?? null;
  const togglePick = (id: string) => {
    if (picked.includes(id)) return setPicked(picked.filter((x) => x !== id));
    setPicked([...picked, id]);
  };
  const receipt = receiptPicked(picked);

  return (
    <div className="rounded-lg border border-line/[0.08] p-3" data-testid="loop-plugins">
      <SectionToggle
        on={on}
        onToggle={() => {
          // Switched on with nothing picked, the receipt is picked with it: the section's default.
          // Whether this console can publish one is said under it, not decided here.
          if (!on && picked.length === 0) togglePick(SAS_RECEIPT);
          setOn(!on);
        }}
        label="Protocol plugins"
        testId="loop-plugins-toggle"
        info={
          <>
            <p>{PLUGINS_COPY}</p>
            <p className="mt-2">{RECEIPT_COPY}</p>
            {/* The receipt's three chips sit in the ⓘ rather than under its one sentence: the sentence
                and _Change_ are what the form shows. */}
            <div className="mt-2 flex flex-wrap gap-1.5" data-testid="plugins-receipt-terms">
              {RECEIPT_CHIPS.map((c) => (
                <Badge key={c}>{c}</Badge>
              ))}
            </div>
          </>
        }
        infoLabel="What protocol plugins do"
        infoTestId="loop-plugins-info"
      />

      {/* Switch → picker → the receipt's summary. The wrapper is `plugins-grant` to the specs, the
          section a grant's terms belong to: the demo spec counts the picker's chips under it. */}
      {on && (
        <div className="mt-3 space-y-4" data-testid="plugins-grant">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Protocol plugins to grant">
            {PLUGIN_CATALOG.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => togglePick(p.id)}
                aria-pressed={picked.includes(p.id)}
                title={p.blurb}
                className="chip"
                data-testid={`plugins-pick-${p.id}`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* The receipt has no terms of its own: picked, its summary and nothing else. */}
          {receipt && <ReceiptSummary attest={attest} />}

          {!receipt && (
            <p className="text-2xs text-ink-3" data-testid="plugins-none-picked">
              {NOTHING_PICKED}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * SAS · receipt picked: one line, with its three chips in the section's ⓘ, and _Change_ opening what
 * the receipt is published under — the credential, the `loop-receipt` schema and the key that signs, all
 * the console's (the only pointer it accepts), so there is nothing to type. No mandate, bar or expiry: the receipt is not a grant.
 */
function ReceiptSummary({ attest }: { attest: AttestDemo | null }) {
  const [open, setOpen] = useState(false);
  const pointer = attest?.receipt ?? null;
  return (
    <div className="space-y-3" data-testid="plugins-config-sas.receipt">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm leading-relaxed text-ink-2" data-testid="plugins-receipt-summary">
          {RECEIPT_SUMMARY}
        </p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setOpen(!open)}
          testId="plugins-receipt-change"
          className="flex-none"
        >
          {open ? "Done" : "Change"}
        </Button>
      </div>
      {!pointer && (
        // Said whether or not _Change_ is open: without the schema the console refuses the start's receipt.
        <p className="text-2xs leading-relaxed text-amber-300" data-testid="plugins-no-receipt-schema">
          This console has no receipt schema. Run <code>npm run -s demo-attest:seed</code>, authorize the console&apos;s
          key, and reload.
        </p>
      )}
      {open && pointer && attest && (
        <div className="space-y-2 rounded-lg border border-line/[0.08] p-3" data-testid="plugins-receipt-details">
          <p className="text-2xs leading-relaxed text-ink-3" data-testid="plugins-receipt-pointer">
            Credential <span className="num text-ink-1">{SAS_DEMO_CREDENTIAL_NAME}</span>{" "}
            <span className="num">({short(attest.credential)})</span>, schema{" "}
            <span className="num text-ink-1">{SAS_RECEIPT_SCHEMA_NAME}</span>{" "}
            <span className="num">({short(pointer.schema)})</span>, signed by{" "}
            <span className="num text-ink-1">{short(pointer.signer)}</span>, on devnet.
          </p>
          <p className="text-2xs leading-relaxed text-ink-3">
            A receipt points at this loop&apos;s records on Solana: its last step&apos;s position in the chain, the step
            count, the goal&apos;s hash, and what the loop cost. Anyone can read it in one call;{" "}
            <code>lath-audit verify-receipt</code> checks it against the records.
          </p>
        </div>
      )}
    </div>
  );
}
