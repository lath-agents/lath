"use client";

/**
 * The loop's receipt on SAS on its page: whether it is waiting
 * for Jev's `achieved`, published, failed or not to be, and once published the attestation and its
 * transaction on the devnet explorer with the values it carries — the chain position the loop's last step
 * committed, the step count, the goal's hash, and what the loop cost in USDC on Solana and on Tempo.
 *
 * The receipt is an index, not a proof: it points at the loop's records, which the audit replays, and `lath-audit
 * verify-receipt` checks its agent, loop, seq, head, steps and goal against them. The two costs are the console's
 * report, not something the audit replays, and tagged as such. Renders nothing on a loop whose policy commits no
 * receipt — `null` from the console, absent from a row written without the field — so every other loop's page has no
 * receipt card. The words are `lib/plugins-view.ts`'s, which the node suite holds.
 */
import { Badge, Card, CopyButton, Facts, Info } from "@/components/ui";
import { DevnetLink } from "@/components/LoopPlugins";
import { SolanaMark, TempoLink } from "@/components/Tempo";
import { receiptStatusLine, receiptValueLines, shortAddress } from "@/lib/plugins-view";
import type { LoopView } from "@/types/loop";

export function LoopReceipt({ loop }: { loop: LoopView }) {
  const receipt = loop.receipt;
  if (!receipt) return null;
  const status = receiptStatusLine(receipt);
  const published = receipt.status === "published";
  const values = published && receipt.values ? receiptValueLines(receipt.values) : null;

  return (
    // Folded by default, with its status badge still on the header, and titled by the service's name,
    // spelled out: a bare acronym reads as unexplained, and each of the three cards under the steps is
    // named by its chain or service alone.
    <Card
      tone="blue"
      collapsible={{ testId: "loop-receipt-fold" }}
      title={
        <>
          <SolanaMark size={16} />
          Solana Attestation Service (SAS)
          <Badge tone="neutral">devnet</Badge>
        </>
      }
      right={
        <span className="inline-flex items-center gap-1.5">
          <span data-testid="loop-receipt-status" data-status={receipt.status}>
            <Badge tone={status.tone} dot>
              {status.badge}
            </Badge>
          </span>
          {/* The receipt's other values and the sentence on how it is checked, behind one ⓘ on the header:
            the card leads with the attestation, its transaction, the
            steps and the charge, and the chain position, the goal's hash and the Tempo side are a click in.
            On the right, since the title is the fold's button and a button cannot hold another. */}
          <Info label="More of this receipt" wide testId="loop-receipt-more" triggerTestId="loop-receipt-more-open">
            <div className="space-y-2">
              {values && (
                <Facts
                  testId="loop-receipt-more-values"
                  items={[
                    {
                      label: "position",
                      value: values.position,
                      source: "console",
                      mono: true,
                      title: `seq ${receipt.values!.seq}, head ${receipt.values!.head}`,
                    },
                    { label: "goal", value: values.goal, source: "console", mono: true, title: receipt.values!.goal },
                    { label: "Tempo", value: values.tempo, source: "console", mono: true },
                    {
                      label: "Tempo payer",
                      value: values.payer ? (
                        <TempoLink kind="address" value={values.payer} testId="loop-receipt-payer" />
                      ) : (
                        "none"
                      ),
                      source: "console",
                    },
                  ]}
                />
              )}
              <p className="text-2xs leading-relaxed text-ink-3" data-testid="loop-receipt-note">
                This receipt points at the loop&apos;s records; <code>lath-audit verify-receipt</code> checks it against
                them. Its values are what the console built and published.
              </p>
            </div>
          </Info>
        </span>
      }
      // Short, and naming the decision model rather than Jev.
      description="Published when the decision model says achieved."
    >
      <div className="space-y-4" data-testid="loop-receipt-card">
        {status.text && (
          <p
            className={`text-2xs leading-relaxed ${receipt.status === "failed" ? "text-rose-300" : "text-ink-3"}`}
            data-testid="loop-receipt-line"
          >
            {status.text}
          </p>
        )}

        {published && (
          <Facts
            testId="loop-receipt-links"
            items={[
              {
                label: "attestation",
                value: (
                  <span className="inline-flex items-center gap-1">
                    <DevnetLink kind="address" value={receipt.address} testId="loop-receipt-address" />
                    <CopyButton value={receipt.address} />
                  </span>
                ),
                title: receipt.address,
              },
              ...(receipt.signature
                ? [
                    {
                      label: "transaction",
                      value: <DevnetLink kind="tx" value={receipt.signature} testId="loop-receipt-tx" />,
                      title: receipt.signature,
                    },
                  ]
                : []),
            ]}
          />
        )}

        {/* The two values a reader takes in at a glance, up front; the rest is the header's ⓘ (R7). Each is
            the console's: what it built and published, as its view reports it, not a read of the
            attestation; the audit is what compares them with the chain. */}
        {values && (
          <Facts
            testId="loop-receipt-values"
            items={[
              { label: "steps", value: values.steps, source: "console", mono: true },
              { label: "charged", value: values.charged, source: "console", mono: true },
            ]}
          />
        )}

        {/* Before it is published, where it will be: the address is derived from the loop id (R2), so a
            reader can look for it whatever the console says. */}
        {!published && receipt.status !== "none" && (
          <p className="text-2xs leading-relaxed text-ink-3" data-testid="loop-receipt-pending-address">
            It will be at <DevnetLink kind="address" value={receipt.address} />, signed by{" "}
            <span className="num text-ink-2">{shortAddress(receipt.signer)}</span>.
          </p>
        )}
      </div>
    </Card>
  );
}
