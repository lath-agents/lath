"use client";

import { ReactNode, useState } from "react";
import { EpochRecord, EventRecord, hex } from "@lath/sdk/browser";
import { Badge, CheckIcon, Copyable, CopyIcon, ExplorerLink } from "@/components/ui";
import { truncate } from "@/lib/format";
import { ResolvedEpoch, ResolvedTrace } from "@/lib/traces";
import { useTempoTreasury } from "@/lib/tempo";
import { TempoMark } from "@/components/Tempo";
import {
  type CheckCommand,
  auditCommand,
  blobCheckCommand,
  bundleCheckCommand,
  gatewayBase,
  keyAuditCommand,
  schemeLabel,
  verifyChannelCommand,
} from "@/lib/verify";

/**
 * "Don't take this page's word for it" — the block under every trace and every epoch.
 *
 * The console verifies as it renders: a trace is only shown after `sha256(bytes)` matched the
 * `payload_hash` the chain carries, and an epoch's steps are only shown after their Merkle root
 * was rebuilt in the browser and matched the root the chain folded. Both are stated on screen,
 * and both are worth precisely as much as the reader's trust in us.
 *
 * So this block hands over the two halves the check is made of, as things a reader can open in
 * another tab or another program:
 *
 * 1. **the fingerprint**, and the compressed account it was read out of — the chain side;
 * 2. **the bytes**, at the gateway url this browser actually fetched — the storage side;
 * 3. **the command** that redoes the comparison with `curl` and `shasum`, neither of which is
 *    ours, against a digest that came off the chain.
 *
 * Nothing here is a second source of truth: every string is derived from the same public config
 * and the same resolved locator the fetch used, so a link that is wrong here was a link that was
 * wrong when the app fetched it.
 */

function Row({ n, label, children }: { n: number; label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-2">
      <span className="num mt-px flex h-5 w-5 flex-none items-center justify-center rounded-full border border-line/[0.12] text-[10px] text-ink-3">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="eyebrow">{label}</div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-2">{children}</div>
      </div>
    </div>
  );
}

/** A shell snippet with one button: the whole point is that it is pasted somewhere else. */
export function CommandBox({ command, testId }: { command: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative w-full rounded-md border border-line/[0.08] bg-canvas p-2.5 pr-9" data-testid={testId}>
      <pre className="overflow-x-auto whitespace-pre font-mono text-[11px] leading-relaxed text-ink-1">{command}</pre>
      <button
        type="button"
        title="Copy command"
        aria-label="Copy command"
        className={`absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-line/[0.06] ${
          copied ? "text-spine-green" : "text-ink-3 hover:text-ink-1"
        }`}
        onClick={() => {
          // The tick only once the write resolved: a rejected write (no permission, an insecure context
          // with no `navigator.clipboard`) would leave the old tick saying copied over an empty clipboard.
          Promise.resolve()
            .then(() => navigator.clipboard.writeText(command))
            .then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              },
              () => undefined
            );
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
}

/** The gateway url, clickable and whole in the title, with the backend that serves it named. */
function BlobLink({ url, scheme, id }: { url?: string; scheme?: number; id?: Uint8Array }) {
  if (!url) return <span className="text-ink-3">no gateway configured</span>;
  return (
    <>
      {scheme !== undefined && <Badge tone="neutral">{schemeLabel(scheme)}</Badge>}
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        data-testid="blob-link"
        title={url}
        className="min-w-0 truncate font-mono text-xs text-accent/90 underline decoration-accent/25 underline-offset-[3px] transition-colors hover:text-accent-strong hover:decoration-accent/60"
      >
        {url}
      </a>
      {/* The chain's spelling of the id, unless the url already ends in it (a hex gateway). */}
      {id && !url.toLowerCase().endsWith(hex(id)) && (
        <Copyable value={hex(id)} display={`id ${truncate(hex(id), 6, 4)}`} />
      )}
    </>
  );
}

/** Saves the exact bytes the page hashed, so the reader can hash the same file rather than a render of it. */
function SaveBytes({ bytes, filename }: { bytes: Uint8Array; filename: string }) {
  return <SaveButton bytes={bytes} filename={filename} label={`save the ${bytes.length} bytes`} />;
}

function SaveButton({ bytes, filename, label }: { bytes: Uint8Array; filename: string; label: string }) {
  return (
    <button
      type="button"
      data-testid="save-bytes"
      className="text-xs text-ink-3 underline decoration-line/20 underline-offset-[3px] transition-colors hover:text-ink-1"
      onClick={() => {
        // A copy, because `Blob` wants an `ArrayBuffer` and the view may be a slice of a bigger one.
        const url = URL.createObjectURL(new Blob([bytes.slice()], { type: "application/octet-stream" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }}
    >
      {label}
    </button>
  );
}

/**
 * Collapsed until asked for, because the three lines it holds are long — a bundle check carries a
 * gateway url and an eight-line script — and they answer a question most readers do not have
 * while they are reading the trace above. The summary stays visible so the offer is never hidden;
 * what is hidden is the apparatus behind it.
 *
 * The children are mounted only while open. They are pure functions of a trace that is already
 * resolved, so there is nothing to keep alive across a close, and the commands are built by
 * string concatenation rather than fetched.
 */
function Frame({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="rounded-lg border border-line/[0.06] bg-line/[0.015] px-3 py-1.5 data-[open=true]:divide-y data-[open=true]:divide-line/[0.05]"
      data-testid="verify-block"
      data-open={open}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="verify-toggle"
        className="flex w-full items-center gap-2 py-2 text-left transition-colors hover:text-ink-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
      >
        <span className="eyebrow text-ink-2">Check it without this page</span>
        <span className="text-2xs text-ink-3">{open ? "hide" : "show"}</span>
      </button>
      {open && children}
    </div>
  );
}

/**
 * One trace: `sha256(bytes) == payload_hash` is a comparison anybody can run, so the whole
 * argument fits in three lines and one command.
 *
 * Line 2 and line 3 have three arms, one per `trace.via`, because the three are different
 * claims about the chain and a label that fits two of them lies about the third:
 *
 * - `chain` — the registry maps *this* hash to a locator; the chain points at these bytes;
 * - `hash` — nothing on chain points anywhere; a content-addressed gateway was asked by name;
 * - `bundle` — the chain points at the **session's bundle**, and these bytes are one entry in
 *   it. On a bundle-sealing console that is every record payload, not an edge case: the bundle
 *   is anchored once and the payloads inside it never are. So the link is the bundle's and the
 *   command pulls the entry back out of it, since hashing the bundle would prove nothing about
 *   this record.
 *
 * Across all three, a `sealed` (owner-encrypted) trace gets no line 3: the chain commits to the
 * plaintext and the link serves ciphertext, so the `shasum` line and the bundle walk would both hash
 * to nothing the chain holds. No key is ever written into a box made to be pasted.
 */
export function TraceVerify({
  record,
  trace,
  origin,
}: {
  record: EventRecord;
  trace: ResolvedTrace;
  /** Where this hash sits on chain, when it is not a record account of its own — an epoch leaf. */
  origin?: ReactNode;
}) {
  const hash = hex(record.payloadHash);
  const url = trace.url;
  const bundle = trace.via === "bundle" ? trace.bundle : undefined;
  return (
    <Frame>
      <Row n={1} label="The chain says this hash">
        <Copyable value={hash} display={truncate(hash, 10, 8)} />
        {record.address ? (
          <span className="text-ink-3">
            in record account <ExplorerLink kind="address" value={record.address.toBase58()} />
          </span>
        ) : (
          <span className="text-ink-3">{origin ?? "committed in this owner's hash chain"}</span>
        )}
        {trace.locatorAccount && (
          <span className="text-ink-3">
            · locator anchored in <ExplorerLink kind="address" value={trace.locatorAccount.toBase58()} />
          </span>
        )}
      </Row>
      {trace.via === "bundle" ? (
        <Row n={2} label="The bytes came from this session's bundle">
          {bundle ? (
            <>
              <BlobLink url={bundle.url} scheme={bundle.locator.scheme} id={bundle.locator.id} />
              {bundle.locatorAccount && (
                <span className="text-ink-3">
                  · bundle anchored in <ExplorerLink kind="address" value={bundle.locatorAccount.toBase58()} />
                </span>
              )}
            </>
          ) : (
            // `planByHash` attaches the source for every bundled hit; this is the fallback for an
            // index that answered bytes and could not say from which bundle, not a configuration.
            <span className="text-ink-3">the bundle's locator was not kept — reload to resolve it again</span>
          )}
          {trace.bytes && <SaveBytes bytes={trace.bytes} filename={`${hash.slice(0, 16)}.bin`} />}
        </Row>
      ) : (
        <Row
          n={2}
          label={trace.via === "hash" ? "The gateway serves the bytes by hash" : "The chain points at these bytes"}
        >
          <BlobLink url={url} scheme={trace.locator?.scheme} id={trace.locator?.id} />
          {trace.bytes && <SaveBytes bytes={trace.bytes} filename={`${hash.slice(0, 16)}.bin`} />}
        </Row>
      )}
      {/* Bytes written encrypted are ciphertext of what the chain committed, so hashing the download
          is not the check: no third row for them. */}
      {trace.sealed ? null : bundle?.url ? (
        <Row n={3} label="Pull the entry out of the bundle and hash it">
          <span className="text-ink-3">
            The chain anchored the bundle, not this entry, so hashing the whole download is not the check. The script
            walks the bundle's entries and reports the one that hashes to the digest above.
          </span>
          <CommandBox command={bundleCheckCommand(bundle.url, hash)} testId="verify-command" />
        </Row>
      ) : (
        url && (
          <Row n={3} label="Hash what you downloaded">
            <CommandBox command={blobCheckCommand(url, hash)} testId="verify-command" />
          </Row>
        )
      )}
    </Frame>
  );
}

/**
 * One epoch. Deliberately *not* given a `shasum` line: the chain commits the Merkle root of the
 * steps, not the digest of the blob that carries them, so hashing the download proves nothing
 * here. Rebuilding the root is what proves it — this browser did, and `lath-audit` does it
 * off this machine.
 */
export function EpochVerify({
  epoch,
  resolved,
  ownerId,
}: {
  epoch: EpochRecord;
  resolved: ResolvedEpoch;
  /** The agent this epoch belongs to — the argument `lath-audit` takes. */
  ownerId: string;
}) {
  const root = hex(epoch.epochRoot);
  return (
    <Frame>
      <Row n={1} label="The chain folded this root">
        <Copyable value={root} display={truncate(root, 10, 8)} />
        <span className="text-ink-3">
          in commit <ExplorerLink kind="tx" value={epoch.signature} />
        </span>
      </Row>
      <Row n={2} label="The chain points at these bytes">
        <BlobLink url={resolved.url} scheme={resolved.locator?.scheme} id={resolved.locator?.id} />
      </Row>
      <Row n={3} label="Rebuild the root from them">
        <span className="text-ink-3">
          The root is a Merkle fold over the steps, not a digest of the file — so hashing the download is not the check.
          This browser rebuilt it; the command below does the same off this machine, for every epoch.
        </span>
        <CommandBox command={auditCommand(ownerId, resolved.locator?.scheme)} testId="verify-command" />
      </Row>
    </Frame>
  );
}

/**
 * The whole chain, for a reader who wants no part of this page: one `lath-audit` line, with
 * this cluster's rpc, gateway and scheme already filled in. Collapsed, because it is the answer
 * to a question most visitors will not ask — and one word away for the one who does.
 */
/**
 * Said out loud when this deployment serves its own blobs: the url in the command is reachable
 * while this app is, and not a minute longer. An audit meant to outlive the demo needs a store
 * that outlives it, such as Irys.
 */
function SameOriginNote() {
  const base = gatewayBase();
  if (typeof window === "undefined" || !base || !base.startsWith(window.location.origin)) return null;
  return (
    <p className="text-2xs leading-relaxed text-amber-300/80" data-testid="same-origin-note">
      This deployment serves blobs from the console itself, so that gateway url only answers while this app is running.
      Point <span className="font-mono">--gateway</span> at a public store — an Irys gateway — for an audit that
      outlives it.
    </p>
  );
}

/**
 * _Verify offline_ as two pieces: the toggle sits in a toolbar, and the panel it opens is placed by
 * the caller as a full-width row under it. As one `details` the panel would open inside the toolbar's
 * flex row and push the counts and the export button apart.
 */
export function ChainVerifyToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      data-testid="chain-verify-toggle"
      className="text-xs text-ink-3 underline decoration-line/20 underline-offset-[3px] transition-colors hover:text-ink-1"
    >
      {open ? "Hide the offline check" : "Verify offline"}
    </button>
  );
}

export function ChainVerify({
  ownerId,
  scheme,
  agentName,
}: {
  ownerId: string;
  scheme?: number;
  /**
   * The agent's name, which the Tempo checks take as `--name`. Without one they are left
   * out and the box says why: `idFromString` of the id would audit a different agent.
   */
  agentName?: string;
}) {
  const command = auditCommand(ownerId, scheme);
  // The payer every voucher names on a v2 chain is the operator's treasury; the console states it,
  // and the commands pin it so a voucher signed by anyone else fails rather than passes.
  const treasury = useTempoTreasury();
  const payer = treasury.data?.enabled ? treasury.data.address ?? null : null;
  const tempo: { check: CheckCommand; testId: string; title: string }[] = agentName
    ? [
        {
          check: verifyChannelCommand(agentName, { payer, scheme }),
          testId: "verify-channel-command",
          title: "Every payment channel against what Tempo paid out",
        },
        {
          check: keyAuditCommand(agentName, { payer, scheme }),
          testId: "key-audit-command",
          title: "The chain, with the loop's Tempo access key",
        },
      ]
    : [];
  return (
    <div className="well w-full p-3" data-testid="chain-verify">
      <div className="w-full space-y-2">
        <p className="text-2xs leading-relaxed text-ink-3">
          Walks every record from the chain, opens every epoch through the gateway, re-folds each head and demands the
          preimage behind each hash. Reads only; needs no key and no checkout of this repo.
        </p>
        <CommandBox command={command} testId="audit-command" />
        <SameOriginNote />
        {/* The Tempo half, beside the chain's — each line with the one sentence of what it
            checks, from `lib/tempo-commands.ts`, which builds them with the CLI's own flags. */}
        <div className="space-y-3 border-t border-line/[0.06] pt-3" data-testid="tempo-checks">
          <div className="eyebrow inline-flex items-center gap-1.5">
            <TempoMark /> The Tempo payments, checked on Tempo
          </div>
          {tempo.length === 0 ? (
            <p className="text-2xs leading-relaxed text-ink-3" data-testid="tempo-checks-unnamed">
              These checks take the agent&apos;s name (<span className="font-mono">--name</span>), and this page does
              not know it: no name is published for this agent, none is in this browser and this console did not deploy
              it.
            </p>
          ) : (
            tempo.map((t) => (
              <div key={t.testId} className="space-y-1">
                <div className="text-2xs font-medium text-ink-2">{t.title}</div>
                <p className="text-2xs leading-relaxed text-ink-3" data-testid={`${t.testId}-checks`}>
                  {t.check.checks}
                </p>
                <CommandBox command={t.check.command} testId={t.testId} />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
