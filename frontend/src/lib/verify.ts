import { encodeLocatorId, IRYS_ENCODING, IRYS_GATEWAY, LocatorEncoding, LocatorScheme } from "@lath/sdk/browser";
import { config } from "./config";
import {
  LATH_AUDIT,
  LATH_AUDIT_WHERE,
  keyAuditLine,
  verifyChannelLine,
  verifyChargeLine,
  type CheckCommand,
  type CommandReader,
  type KeyAuditOptions,
  type VerifyChannelOptions,
  type VerifyChargeOptions,
} from "./tempo-commands";

/**
 * The two links and the one command that let somebody repeat, off this machine, what the page
 * just did in front of them.
 *
 * The console already re-hashes every blob it shows and rebuilds every epoch root it opens, and
 * says so on screen. That is worth exactly as much as the reader's trust in the console. What
 * removes the console from the picture is naming the two halves out loud — the chain account
 * that carries the fingerprint, and the gateway url that serves the bytes — so the reader can
 * fetch both with tools that are not ours and get the same answer. Everything here is derived
 * from the same public config the app fetches with; nothing is a service of ours.
 */

/**
 * The scheme to name when nothing on screen resolved one. A deployment with a raw gateway is a
 * development one and its chains are Raw; a deployment without is the hosted console, whose
 * chains are on Irys and whose reader has a gateway for them with no environment at all.
 */
function defaultScheme(): number {
  return config.traceGateway ? config.traceScheme : LocatorScheme.Irys;
}

/** `LocatorScheme` as a reader sees it. Anything ≥ 128 is somebody's private scheme. */
const SCHEME_LABEL: Record<number, string> = {
  [LocatorScheme.Raw]: "raw",
  [LocatorScheme.Irys]: "Irys",
};

export function schemeLabel(scheme: number): string {
  return SCHEME_LABEL[scheme] ?? `scheme ${scheme}`;
}

/**
 * Where the configured gateway serves a locator — byte for byte the url `HttpGatewayBackend`
 * fetched, built the same way (`sdk/src/locator.ts`), so a reader clicking it downloads what
 * this browser hashed and not a re-render of it. `null` when the app is chain-only.
 */
export function gatewayBase(): string | null {
  if (!config.traceGateway) return null;
  const base = config.traceGateway.replace(/\/+$/, "");
  // The default gateway is this app's own read-only route (`/api/traces`), so the configured
  // base is often a path rather than a url. A path is a perfectly good `href`, but it is not a
  // thing anyone can paste into `curl` or hand to `lath-audit` — and pasting it elsewhere is
  // the entire point here — so it is resolved against the origin the reader is looking at.
  if (base.startsWith("/") && typeof window !== "undefined") return `${window.location.origin}${base}`;
  return base;
}

/**
 * The gateway that serves a scheme, and the spelling it serves ids under.
 *
 * The chain carries a scheme tag and never a url (SPEC §14.1), so this is where the tag becomes
 * a place to fetch from. A chain can carry both — an older console chain has Raw locators in
 * its earlier epochs and scheme-4 ones in its later ones — which is why the choice is per locator
 * and not per deployment. Scheme 4 always has somewhere to go; scheme 0 has one only where a
 * raw gateway is configured, and every other tag is unassigned, so nothing serves it.
 */
export function gatewayFor(scheme: number): { base: string; encoding: LocatorEncoding } | null {
  if (scheme === LocatorScheme.Irys) return { base: config.irysGateway.replace(/\/+$/, ""), encoding: IRYS_ENCODING };
  if (scheme !== config.traceScheme) return null;
  const base = gatewayBase();
  return base === null ? null : { base, encoding: config.traceEncoding };
}

export function gatewayUrl(id: Uint8Array, scheme: number = config.traceScheme): string | null {
  const at = gatewayFor(scheme);
  return at === null ? null : `${at.base}/${encodeLocatorId(id, at.encoding)}`;
}

/**
 * An RPC url with its credentials taken out, and whether any were.
 *
 * A ZK-compression endpoint is a paid service and its url carries the key — `?api-key=…` at
 * Helius, `userinfo@` elsewhere. The console is a *public* page whose whole job here is to be
 * screenshotted and shared, so the key must not be in the box people copy out of it. What goes
 * in its place is a shell variable the reader fills with their own endpoint: the command stays
 * runnable, and it is their key rather than the operator's that pays for the audit.
 */
export function redactRpc(url: string): { text: string; redacted: boolean } {
  try {
    const u = new URL(url);
    const redacted = u.username !== "" || u.password !== "" || [...u.searchParams.keys()].length > 0;
    if (!redacted) return { text: url, redacted };
    u.username = "";
    u.password = "";
    u.search = "";
    return { text: u.toString().replace(/\/$/, ""), redacted };
  } catch {
    return { text: url, redacted: false };
  }
}

// The three check commands live in `check-commands.ts`, which imports nothing, so that the root
// tsconfig can load it and `tests/trace-routing.ts` can run what it builds. Re-exported
// here so every caller imports them from one place.
export { blobCheckCommand, bundleCheckCommand } from "./check-commands";

/**
 * The whole chain, re-derived by a stranger with no checkout: `lath-audit` walks the records
 * from the chain, opens the epochs through the gateway and re-folds every head.
 * `--require-preimages` is what turns "the heads fold" into "and here are the bytes behind each
 * one" — an audit that passes without it has verified structure, not content. For an
 * owner-encrypted agent it also needs `--trace-key`: an encrypted preimage the audit cannot open
 * ends NOT VERIFIED. The line leaves the key out, because the page never holds it for a
 * visitor; `ChainVerify` says so beside the command.
 *
 * `scheme` is the chain's, not the deployment's: a caller holding a resolved locator passes the
 * scheme it came back with, and a caller that holds none gets the gateway this reader would
 * have used anyway.
 */
/**
 * One Action's payment, rechecked off this machine: `lath-audit verify-inference` fetches the
 * blob behind the record, re-hashes it, checks the payer (`--payer`: the operator treasury for a
 * v2 record, the address the agent's key derives for a v1 one) and reads the channel on Tempo's
 * own public RPC.
 *
 * Two endpoints, so two shell variables: `$R` is a ZK-compression RPC for this cluster — the
 * reader's, not the operator's, since the console's carries a key — and `$T` is Tempo's, which is
 * public and filled in. The verdict is `VERIFIED`, `PENDING` or `FAILED` with exit 0, 4 or 2, so
 * the same line is usable in a script as it is on a terminal.
 */
export function tempoVerifyCommand(
  agentId: string,
  seq: string | number | bigint,
  rpcUrl: string = config.rpcUrl,
  tempoRpc = "https://rpc.tempo.xyz",
  payer?: string | null,
  scheme: number = defaultScheme()
): string {
  const hint = readerRpcLine(rpcUrl, `a ZK-compression RPC for ${config.cluster}`);
  const parts = [
    `${LATH_AUDIT} verify-inference ${agentId} ${seq.toString()}`,
    `  --rpc "$R" --tempo-rpc "$T"` + (payer ? ` --payer ${payer}` : ""),
    // The voucher is in the blob, and every Action a console session writes is a step of an
    // epoch, so without a gateway the line can only ever answer "no preimage" — the verdict the
    // reader was promised is behind the same flags the chain audit prints. This record's own scheme picks
    // them: a record on Irys verifies from anywhere.
    ...readerFlags(scheme),
  ];
  return [LATH_AUDIT_WHERE, hint, `T="${tempoRpc}"`, parts.join(" \\\n")].join("\n");
}

/**
 * The reader flags for a locator of `scheme`, as `lath-audit` layers them (`sdk/src/cli.ts`
 * `readPlan`): `--gateway` names where the raw scheme is served, and scheme 4 reads through the
 * Irys gateway with no flag at all, so a line for a raw locator names the raw gateway and still
 * reaches the Irys half of a chain that switched backends partway. `--irys-gateway`
 * only appears when this deployment reads Irys somewhere other than the default.
 */
function readerFlags(scheme: number): string[] {
  const at = gatewayFor(scheme);
  if (!at) return [];
  const parts = [`  --gateway ${at.base} --scheme ${scheme} --encoding ${at.encoding}`];
  if (config.traceRegistry && scheme === config.traceScheme) parts.push(`  --registry ${config.traceRegistry}`);
  const irys = config.irysGateway.replace(/\/+$/, "");
  if (irys !== IRYS_GATEWAY && scheme !== LocatorScheme.Irys) parts.push(`  --irys-gateway ${irys}`);
  return parts;
}

// The Tempo half of _Check it yourself_ is built in `tempo-commands.ts`, import-free like
// `check-commands.ts` so `tests/tempo-commands.ts` can parse what it builds; the wrappers below fill
// in the `R=` line and the gateway flags from this page's config, as `tempoVerifyCommand` does.
export type { CheckCommand, KeyAuditOptions, VerifyChannelOptions, VerifyChargeOptions } from "./tempo-commands";

/** Where a Tempo check reads from. Each defaults to what `tempoVerifyCommand` uses. */
export interface TempoReaderOptions {
  /** The cluster RPC the `R=` line names (redacted, or a placeholder behind this origin's proxy). */
  rpcUrl?: string;
  tempoRpc?: string;
  /** The chain's locator scheme, which picks the gateway flags where no raw gateway is configured. */
  scheme?: number;
}

const TEMPO_RPC = "https://rpc.tempo.xyz";

function commandReader(o: TempoReaderOptions): CommandReader {
  return {
    rpcLine: readerRpcLine(o.rpcUrl ?? config.rpcUrl, `a ZK-compression RPC for ${config.cluster}`),
    // As `auditCommand` picks them, since these too read the whole chain: where this deployment
    // serves the raw scheme the line names that gateway, which still reaches the Irys half of a
    // chain that switched backends partway, and a resolved scheme does not talk it out of that.
    flags: readerFlags(gatewayBase() !== null ? config.traceScheme : o.scheme ?? defaultScheme()),
    tempoRpc: o.tempoRpc ?? TEMPO_RPC,
  };
}

/** `lath-audit verify-channel --name <agent>`: every channel's vouchers against what its close paid out. */
export function verifyChannelCommand(
  agentName: string,
  opts: VerifyChannelOptions & TempoReaderOptions = {}
): CheckCommand {
  return verifyChannelLine(agentName, opts, commandReader(opts));
}

/** `lath-audit verify-charge --name <agent>`: every Tempo storage payment against its Tempo transfer. */
export function verifyChargeCommand(
  agentName: string,
  opts: VerifyChargeOptions & TempoReaderOptions = {}
): CheckCommand {
  return verifyChargeLine(agentName, opts, commandReader(opts));
}

/** `lath-audit --name <agent> --key`: the chain audit, with the loop's Tempo access key checked beside it. */
export function keyAuditCommand(agentName: string, opts: KeyAuditOptions & TempoReaderOptions = {}): CheckCommand {
  return keyAuditLine(agentName, opts, commandReader(opts));
}

export function auditCommand(id: string, scheme: number = defaultScheme()): string {
  const parts = [`${LATH_AUDIT} ${id}`, `  --rpc "$R"`];
  // The audit reads the whole chain, and an older console chain that switched backends carries Raw
  // locators in its earlier epochs and Irys ones in its later. One command has
  // to reach both, so where this deployment serves the raw scheme the line names that gateway —
  // the CLI reads scheme 4 through Irys regardless — and a resolved Irys locator does not talk it
  // out of that.
  const flags = readerFlags(gatewayBase() !== null ? config.traceScheme : scheme);
  if (flags.length > 0) parts.push(...flags, "  --require-preimages");
  const command = parts.join(" \\\n");
  // The reader's own endpoint, not ours: `$R` is set on the line above so the whole block is
  // still one paste. When the configured url carries no credentials it is filled in as the
  // default, which is the public-endpoint case.
  const hint = readerRpcLine(config.rpcUrl, `a ZK-compression RPC for ${config.cluster} (Photon + prover on one url)`);
  return `${LATH_AUDIT_WHERE}\n${hint}\n${command}`;
}

/**
 * The `R=` line of a check command. When the page reads through this origin's proxy it knows no url
 * a reader could use: the proxy serves this site's pages, not a terminal's audit, and the endpoint
 * behind it is the operator's, key and all. So the line is a placeholder for the reader's own. It is
 * decided on `config.rpcProxied` rather than on the url, whose origin differs between the server
 * render and the browser and would make the command box a hydration mismatch.
 */
function readerRpcLine(url: string, what: string): string {
  if (config.rpcProxied && url === config.rpcUrl) return `R="…"   # ${what}`;
  const rpc = redactRpc(url);
  return rpc.redacted ? `R="${rpc.text}/?api-key=…"   # ${what}` : `R="${rpc.text}"`;
}
