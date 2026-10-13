/**
 * The Tempo half of `verifyInference`: the two reads that turn a voucher in a record into a
 * verdict.
 *
 * This file is the only place in the SDK that touches viem, and it is exported from the **node**
 * entry only — `sdk/src/browser.ts` re-exports `audit.ts`, where the pure half lives, so putting
 * an EVM client behind it would ship one to every page that reads a chain. CI greps
 * `sdk/dist/browser.js` for `viem` and holds it to a size ceiling, because a check that looked
 * only for node built-ins would miss it: viem has none.
 *
 * viem is an **optional** dependency and is loaded at the first read rather than at import, so
 * that installing `@lath/sdk` to read a chain does not install an EVM client, and so that the
 * bundler leaves it alone: `tsup` externalises `dependencies` and `peerDependencies` only, and a
 * static import here would inline the whole of viem into `dist/index.js`. A dynamic `import()`
 * kept out of the compiler's reach is what does it, and it works from both the CommonJS and the
 * ESM build.
 *
 * Two measured facts shape what is here:
 *
 * - `getChannelState(channelId)` on the escrow precompile answers `(settled, deposit,
 *   closeRequestedAt)`, and a **closed channel reads as zeros** — so the state can say a channel
 *   still holds enough for a call, and can never say a channel paid for one.
 * - A close is a transaction sent by the payee to the escrow whose receipt carries
 *   `ChannelClosed(bytes32 channelId, address payer, address payee, uint96 finalAmount,
 *   uint96 refund)`. That receipt is what `verified` is read from.
 *
 * Every call is a raw `eth_call` / `eth_getTransactionReceipt` through `client.request`, never
 * `readContract` or `getTransactionReceipt`: this tree compiles with `strict: false`, under which
 * viem's action parameter types collapse and every optional field reads as required.
 */
import {
  TEMPO_CHAIN_ID,
  TEMPO_ESCROW,
  type AllowedCallsLog,
  type ChannelClosedLog,
  type ChannelOpenedLog,
  type KeyAuthorizedLog,
  type TempoScope,
  type TempoChannelState,
  type TempoCloseReceipt,
  type TempoReader,
  type TempoTxReceipt,
} from "./audit";

/** The public Tempo RPC. Overridable, because an auditor running their own node should use it. */
export const TEMPO_RPC_URL = "https://rpc.tempo.xyz";

/** The signature `topic0` is derived from; the topic itself is pinned by `tests/tempo-verify.ts`. */
export const CHANNEL_CLOSED_SIGNATURE = "ChannelClosed(bytes32,address,address,uint96,uint96)";

/**
 * As much of the TIP-1034 escrow as a verdict reads. `getChannelState` encodes to selector
 * `0xd18da8b1` under exactly these types; `getChannel` decodes to nothing usable through viem
 * here, so it is not in this ABI.
 */
export const ESCROW_ABI = [
  {
    type: "function",
    name: "getChannelState",
    stateMutability: "view",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [
      { name: "settled", type: "uint96" },
      { name: "deposit", type: "uint96" },
      { name: "closeRequestedAt", type: "uint32" },
    ],
  },
  {
    type: "event",
    name: "ChannelClosed",
    inputs: [
      { name: "channelId", type: "bytes32", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "payee", type: "address", indexed: true },
      { name: "finalAmount", type: "uint96", indexed: false },
      { name: "refund", type: "uint96", indexed: false },
    ],
  },
] as const;

/**
 * The escrow's `ChannelOpened`, which carries the channel's whole descriptor and so its
 * `authorizedSigner`: the key a loop's vouchers must be signed by. The same layout
 * `frontend/src/app/api/_lib/tempo.ts` recovers a lost row from; copied, because the SDK does not
 * import the frontend, and its topic is pinned by `tests/tempo-verify-charge.ts`.
 */
export const CHANNEL_OPENED_SIGNATURE =
  "ChannelOpened(bytes32,address,address,address,address,address,bytes32,bytes32,uint96)";
export const CHANNEL_OPENED_ABI = [
  {
    type: "event",
    name: "ChannelOpened",
    inputs: [
      { name: "channelId", type: "bytes32", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "payee", type: "address", indexed: true },
      { name: "operator", type: "address", indexed: false },
      { name: "token", type: "address", indexed: false },
      { name: "authorizedSigner", type: "address", indexed: false },
      { name: "salt", type: "bytes32", indexed: false },
      { name: "expiringNonceHash", type: "bytes32", indexed: false },
      { name: "deposit", type: "uint96", indexed: false },
    ],
  },
] as const;

/**
 * The AccountKeychain precompile (`viem/tempo` `Addresses.accountKeychain`): every access key is
 * authorized, limited and revoked there, and only a log it emitted is evidence about a key — anyone
 * may emit an event with the same topic.
 */
export const TEMPO_ACCOUNT_KEYCHAIN = "0xaAAAaaAA00000000000000000000000000000000";

/** The two keychain events (a) reads, as `viem/tempo`'s `Abis.accountKeychain` declares them. */
export const KEY_AUTHORIZED_SIGNATURE = "KeyAuthorized(address,address,uint8,uint64)";
export const SPENDING_LIMIT_UPDATED_SIGNATURE = "SpendingLimitUpdated(address,address,address,uint256)";
export const KEYCHAIN_EVENTS_ABI = [
  {
    type: "event",
    name: "KeyAuthorized",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "publicKey", type: "address", indexed: true },
      { name: "signatureType", type: "uint8", indexed: false },
      { name: "expiry", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SpendingLimitUpdated",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "publicKey", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "newLimit", type: "uint256", indexed: false },
    ],
  },
] as const;

/**
 * The two keychain views (d) reads, copied from `viem/tempo`'s `Abis.accountKeychain` rather than
 * imported, so this file keeps loading viem itself at the first read: `getKey`, whose `isRevoked`
 * says whether the key's live scopes are evidence at all, and `getAllowedCalls` (a view a Tempo
 * hardfork added, which mainnet answers), the scopes as the keychain enforces them now.
 */
export const KEYCHAIN_VIEWS_ABI = [
  {
    name: "getKey",
    type: "function",
    stateMutability: "view",
    inputs: [
      { type: "address", name: "account" },
      { type: "address", name: "keyId" },
    ],
    outputs: [
      {
        type: "tuple",
        components: [
          { type: "uint8", name: "signatureType" },
          { type: "address", name: "keyId" },
          { type: "uint64", name: "expiry" },
          { type: "bool", name: "enforceLimits" },
          { type: "bool", name: "isRevoked" },
        ],
      },
    ],
  },
  {
    name: "getAllowedCalls",
    type: "function",
    stateMutability: "view",
    inputs: [
      { type: "address", name: "account" },
      { type: "address", name: "keyId" },
    ],
    outputs: [
      { type: "bool", name: "isScoped" },
      {
        type: "tuple[]",
        name: "scopes",
        components: [
          { type: "address", name: "target" },
          {
            type: "tuple[]",
            name: "selectorRules",
            components: [
              { type: "bytes4", name: "selector" },
              { type: "address[]", name: "recipients" },
            ],
          },
        ],
      },
    ],
  },
] as const;

/** One nested call scope, as `getAllowedCalls` returns it and as a key authorization's `allowedCalls` serves it. */
interface NestedCallScope {
  target: string;
  selectorRules?: readonly { selector: string; recipients?: readonly string[] }[];
}

/**
 * The nested `(target, selectorRules[])` form flattened to one scope per selector rule, the way
 * `ox/tempo` `KeyAuthorization.fromRpc` unflattens it: a target with no rules is any selector on it,
 * and a rule with no recipients is any recipient. `audit.ts` normalises case and order.
 */
export function flattenCallScopes(nested: readonly NestedCallScope[]): TempoScope[] {
  return nested.flatMap((c): TempoScope[] => {
    const target = String(c.target);
    if (!c.selectorRules || c.selectorRules.length === 0) return [{ address: target }];
    return c.selectorRules.map((r) => ({
      address: target,
      selector: String(r.selector),
      ...(r.recipients && r.recipients.length ? { recipients: r.recipients.map(String) } : {}),
    }));
  });
}

/**
 * How far around a recorded `openBlock` the `ChannelOpened` read looks. The transport records the
 * block it learned the open in, which can be a little before or after the block the open was mined
 * in — the gateway submits it, not this process — and an open is mined within seconds, so a short
 * slack below and a window above that is still hours of blocks hold it. The whole range, slack and
 * window together, must stay under the span the RPC refuses for `eth_getLogs`: rpc.tempo.xyz
 * answers `query exceeds max block range 100000`, so a window of 100 000 plus the slack would have
 * every read of a channel opened more than 100 000 blocks (about 15 h) before the head refused, and
 * its key check would say `unchecked`.
 */
export const OPEN_BLOCK_SLACK = BigInt(1_000);
export const OPEN_BLOCK_WINDOW = BigInt(98_000);

/**
 * With no `openBlock` (an older record, written before the transport kept one), the read searches
 * back from the head, the way `recoveryFromChain` finds a lost row's descriptor, as far as this
 * horizon: about a month of blocks. A channel opened before it is not found, and the check says
 * `unchecked`, not `failed`.
 */
export const OPEN_SEARCH_HORIZON = BigInt(5_000_000);

/**
 * The span of each `eth_getLogs` that search asks for: the slack and the window together, under
 * the 100 000 blocks the RPC refuses past. Fixed chunks rather than widening windows from the
 * head (50 000, 500 000 and 5 000 000 blocks): the RPC refuses the two wide ones every time, so a
 * search built that way never finds anything opened more than 50 000 blocks (about 7.5 h) before
 * the head.
 */
export const LOG_SEARCH_CHUNK = OPEN_BLOCK_SLACK + OPEN_BLOCK_WINDOW;

/**
 * The inclusive `[fromBlock, toBlock]` ranges a search back from `head` asks for, newest first:
 * consecutive, each at most `chunk` blocks, down to `head − horizon` (or block 0). A caller stops at
 * the first range that holds the log, so a recent open costs one read and a missing one ~51.
 */
export function logSearchRanges(
  head: bigint,
  horizon: bigint = OPEN_SEARCH_HORIZON,
  chunk: bigint = LOG_SEARCH_CHUNK
): [bigint, bigint][] {
  if (chunk < BigInt(1)) throw new Error("a log search chunk is at least one block");
  const floor = head > horizon ? head - horizon : BigInt(0);
  const out: [bigint, bigint][] = [];
  for (let hi = head; ; ) {
    const lo = hi - floor + BigInt(1) > chunk ? hi - chunk + BigInt(1) : floor;
    out.push([lo, hi]);
    if (lo === floor) return out;
    hi = lo - BigInt(1);
  }
}

/**
 * How an RPC refuses an `eth_getLogs` range as too wide: rpc.tempo.xyz answers `query exceeds max
 * block range 100000`. The one failure a search moves past: a node with a tighter cap than
 * `LOG_SEARCH_CHUNK` refuses every range, and the search then finds nothing.
 */
export const LOG_RANGE_REFUSED = /\bblock range\b|\brange (is )?too (large|wide|big)\b/i;

/** `import()` survives the CommonJS transform only where the compiler cannot see it. */
const dynamicImport = new Function("m", "return import(m)") as (m: string) => Promise<any>;

let loading: Promise<any> | null = null;

/**
 * viem, loaded once per process. The message is spelled out because the dependency is optional:
 * an auditor who installed the SDK without it should be told what to install, not handed a module
 * resolution error.
 */
export async function loadViem(): Promise<any> {
  if (!loading) {
    loading = dynamicImport("viem")
      .then((m) => (m?.encodeFunctionData ? m : m?.default))
      .then((m) => {
        if (!m?.encodeFunctionData) throw new Error("viem loaded but exported no encodeFunctionData");
        return m;
      })
      .catch((e: any) => {
        loading = null;
        throw new Error(`reading a Tempo channel needs viem, an optional dependency: npm i viem (${e?.message ?? e})`);
      });
  }
  return loading;
}

/** `topic0` of `ChannelClosed`: `0x5613aed9…06e6`, as a measured close transaction carried it. */
export async function channelClosedTopic(): Promise<string> {
  const { toEventSelector } = await loadViem();
  return toEventSelector(CHANNEL_CLOSED_SIGNATURE);
}

/** The calldata of `getChannelState(channelId)`: selector `0xd18da8b1` and one 32-byte word. */
export async function channelStateCalldata(channelId: string): Promise<string> {
  const { encodeFunctionData } = await loadViem();
  return encodeFunctionData({ abi: ESCROW_ABI, functionName: "getChannelState", args: [channelId] });
}

export interface TempoRpcOptions {
  /** Default `https://rpc.tempo.xyz`; `--tempo-rpc` on the CLI. */
  url?: string;
  /** The escrow precompile. A different address is a different deployment, so it is a parameter. */
  escrow?: string;
  /**
   * Refuse to answer unless the node says it is this chain. Pinned rather than trusted: a record
   * names `chainId: 4217`, and reading a channel off another chain would answer a question nobody
   * asked.
   */
  chainId?: number;
  /**
   * Every JSON-RPC call through this function instead of `url` — a loop's paid session to
   * `rpc.mpp.tempo.xyz`, so the host's own channel read costs a voucher like its other Tempo
   * reads. The chain check is skipped on this path, not trusted away: the session pays only on its
   * pinned chain (mppx's `allowedChainIds`) and checks `eth_chainId` when it opens, and a second
   * check here would be a second paid call for the same answer.
   */
  request?: (method: string, params: unknown[]) => Promise<unknown>;
}

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber?: string;
  transactionHash?: string;
}

interface RpcReceipt {
  status: string;
  to: string | null;
  blockNumber?: string;
  logs: RpcLog[];
}

/**
 * The part of a Tempo transaction (type `0x76`) a key's limit can be read from when no log carries
 * it: the root-signed key authorization, as the node serves it (`ox/tempo/KeyAuthorization` `Rpc`).
 * `limits` absent is an authorization with no limit at all.
 */
interface RpcKeyAuthorization {
  keyId?: string;
  expiry?: string | null;
  limits?: { token: string; limit: string }[];
  /** The call scopes it authorized (node field `allowedCalls`, `ox/tempo` `RpcCallScope`). */
  allowedCalls?: NestedCallScope[] | null;
}

const hexBlock = (n: bigint) => `0x${n.toString(16)}`;

/**
 * `TempoReader` over a Tempo RPC. Read-only by construction: it holds no key, sends no
 * transaction, and the methods it exposes are the reads an auditor needs — the channel, a close, a
 * charge's transfer, and, for a loop that pays under its own access key, a channel's open, a key's
 * authorization and its scopes.
 */
export class TempoRpcReader implements TempoReader {
  private readonly url: string;
  private readonly escrow: string;
  private readonly wantChainId: number;
  private readonly request?: TempoRpcOptions["request"];
  private client: Promise<any> | null = null;

  constructor(opts: TempoRpcOptions = {}) {
    this.url = opts.url ?? TEMPO_RPC_URL;
    this.escrow = opts.escrow ?? TEMPO_ESCROW;
    this.wantChainId = opts.chainId ?? TEMPO_CHAIN_ID;
    this.request = opts.request;
  }

  /**
   * The client, built and chain-checked once. Chain-less on purpose: viem's Tempo chain
   * formatters type every call as a Tempo transaction, and nothing here sends one.
   */
  private async connect(): Promise<any> {
    const route = this.request;
    if (route) return { request: (a: { method: string; params?: unknown[] }) => route(a.method, a.params ?? []) };
    if (!this.client) {
      this.client = (async () => {
        const { createPublicClient, http } = await loadViem();
        const client = createPublicClient({ transport: http(this.url) });
        const id = Number(BigInt(await client.request({ method: "eth_chainId" })));
        if (id !== this.wantChainId) {
          throw new Error(`${this.url} answers chain ${id}, and a record names ${this.wantChainId}`);
        }
        return client;
      })().catch((e) => {
        // Kept retryable: a node that was down once is not a node that is wrong.
        this.client = null;
        throw e;
      });
    }
    return this.client;
  }

  async channelState(channelId: string): Promise<TempoChannelState | null> {
    const client = await this.connect();
    const { decodeFunctionResult } = await loadViem();
    const data = await channelStateCalldata(channelId);
    const raw = await client.request({ method: "eth_call", params: [{ to: this.escrow, data }, "latest"] });
    // An empty answer is a node with no escrow at that address rather than a channel holding
    // nothing, and the two mean different things to a verdict.
    if (!raw || raw === "0x") return null;
    const out = decodeFunctionResult({ abi: ESCROW_ABI, functionName: "getChannelState", data: raw });
    if (!Array.isArray(out)) return null;
    return { settled: BigInt(out[0]), deposit: BigInt(out[1]), closeRequestedAt: Number(out[2]) };
  }

  /**
   * A close's receipt, with the escrow's `ChannelClosed` for `channelId` in `closed` when the receipt
   * carries one (else the first, which `closeProblem` then names) and every one in `closures`: the
   * payee submits a close, and one gateway transaction may close several channels.
   */
  async closeReceipt(txHash: string, channelId?: string): Promise<TempoCloseReceipt | null> {
    const client = await this.connect();
    const receipt = (await client.request({
      method: "eth_getTransactionReceipt",
      params: [txHash],
    })) as RpcReceipt | null;
    // A node that has not seen the transaction answers null. That is "not yet", not "no".
    if (!receipt) return null;
    const closures = await channelClosuresIn(receipt.logs ?? [], this.escrow);
    const closed =
      (channelId ? closures.find((c) => c.channelId.toLowerCase() === channelId.toLowerCase()) : undefined) ??
      closures[0];
    return {
      status: Number(BigInt(receipt.status ?? "0x0")),
      to: receipt.to ?? null,
      closed,
      ...(closures.length > 1 ? { closures } : {}),
    };
  }

  /**
   * A storage charge's transaction, its logs handed back raw: the TIP-20 transfer in them is
   * decoded by `audit.ts`, which needs no viem to read one word.
   */
  async txReceipt(txHash: string): Promise<TempoTxReceipt | null> {
    const client = await this.connect();
    const receipt = (await client.request({
      method: "eth_getTransactionReceipt",
      params: [txHash],
    })) as RpcReceipt | null;
    if (!receipt) return null;
    return {
      status: Number(BigInt(receipt.status ?? "0x0")),
      ...(receipt.blockNumber ? { blockNumber: BigInt(receipt.blockNumber).toString() } : {}),
      logs: (receipt.logs ?? []).map((l) => ({ address: l.address, topics: l.topics ?? [], data: l.data ?? "0x" })),
    };
  }

  /**
   * The escrow's `ChannelOpened` log for `channelId` (check (b)): `[fromBlock − OPEN_BLOCK_SLACK,
   * fromBlock + OPEN_BLOCK_WINDOW]` clipped to the head when the record gave a block, else the
   * search back from the head in `LOG_SEARCH_CHUNK` ranges (`logSearchRanges`). The channel id is
   * the log's first indexed topic, so the node filters by it and no other channel's open is ever
   * decoded.
   *
   * `null` on any failure — not found, refused, unreachable — because every one of them leaves the
   * key check `unchecked`, and a verifier that threw here would turn a node outage into a crash. A
   * range refused as too wide moves the search on; any other failed read ends it, so a node that is
   * down or rate-limiting is not asked fifty more times for an answer that is `unchecked` either way.
   */
  async channelOpened(channelId: string, fromBlock?: string): Promise<ChannelOpenedLog | null> {
    try {
      const client = await this.connect();
      const { decodeEventLog, toEventSelector } = await loadViem();
      const topic = toEventSelector(CHANNEL_OPENED_SIGNATURE);
      const head = BigInt((await client.request({ method: "eth_blockNumber", params: [] })) as string);
      const ranges: [bigint, bigint][] = [];
      if (fromBlock && /^[0-9]+$/.test(fromBlock)) {
        const at = BigInt(fromBlock);
        const lo = at > OPEN_BLOCK_SLACK ? at - OPEN_BLOCK_SLACK : BigInt(0);
        const hi = at + OPEN_BLOCK_WINDOW < head ? at + OPEN_BLOCK_WINDOW : head;
        if (lo <= hi) ranges.push([lo, hi]);
      } else {
        ranges.push(...logSearchRanges(head));
      }
      for (const [lo, hi] of ranges) {
        let failed = false;
        const logs = (await client
          .request({
            method: "eth_getLogs",
            params: [
              { address: this.escrow, topics: [topic, channelId], fromBlock: hexBlock(lo), toBlock: hexBlock(hi) },
            ],
          })
          .catch((e: unknown) => {
            if (!LOG_RANGE_REFUSED.test(String((e as any)?.message ?? e))) failed = true;
            return null;
          })) as RpcLog[] | null;
        if (failed) return null;
        const log = (logs ?? []).find(
          (l) => l.address?.toLowerCase() === this.escrow.toLowerCase() && l.topics?.[0]?.toLowerCase() === topic
        );
        if (!log) continue;
        const args = decodeEventLog({ abi: CHANNEL_OPENED_ABI, data: log.data, topics: log.topics }).args as any;
        return {
          channelId: String(args.channelId),
          payer: String(args.payer),
          payee: String(args.payee),
          token: String(args.token),
          authorizedSigner: String(args.authorizedSigner),
          deposit: BigInt(args.deposit),
          ...(log.blockNumber ? { blockNumber: BigInt(log.blockNumber).toString() } : {}),
          ...(log.transactionHash ? { txHash: log.transactionHash } : {}),
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * An access key's authorization, from the receipt of the transaction the loop's policy names
   * (check (a)): the keychain's `KeyAuthorized` log, and the key's per-token limits.
   *
   * The limits come from `SpendingLimitUpdated` logs in the same receipt when the keychain emits
   * them, and otherwise from the transaction itself: `authorizeSync` carries the root-signed key
   * authorization in the Tempo transaction's `keyAuthorization` field, limits and all, which
   * `eth_getTransactionByHash` serves. When that payload was read the limits are the whole set it
   * authorized (`limitsFrom: "authorization"`), so a token missing from them has no cap; when it was
   * not, `limitsFrom` says only logs were seen, or is absent and the limit half stays unchecked.
   *
   * A receipt with no `KeyAuthorized` from the keychain comes back with an empty `publicKey`: the
   * transaction authorized nothing, which is an answer, not a failure to read. `null` on any failure.
   */
  async keyAuthorized(txHash: string, publicKey?: string): Promise<KeyAuthorizedLog | null> {
    try {
      const client = await this.connect();
      const receipt = (await client.request({
        method: "eth_getTransactionReceipt",
        params: [txHash],
      })) as RpcReceipt | null;
      if (!receipt) return null;
      const { decodeEventLog, toEventSelector } = await loadViem();
      const authorizedTopic = toEventSelector(KEY_AUTHORIZED_SIGNATURE).toLowerCase();
      const limitTopic = toEventSelector(SPENDING_LIMIT_UPDATED_SIGNATURE).toLowerCase();
      const fromKeychain = (receipt.logs ?? []).filter(
        (l) => l.address?.toLowerCase() === TEMPO_ACCOUNT_KEYCHAIN.toLowerCase()
      );
      const status = Number(BigInt(receipt.status ?? "0x0"));
      const blockNumber = receipt.blockNumber ? { blockNumber: BigInt(receipt.blockNumber).toString() } : {};
      // The key being checked, when the transaction authorized several: its own event, else the
      // first, whose key (a) then names as the one authorized instead. The key is the
      // event's second indexed topic, so it is matched there before anything is decoded.
      const candidates = fromKeychain.filter((l) => l.topics?.[0]?.toLowerCase() === authorizedTopic);
      const wanted = publicKey ? `0x${publicKey.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}` : undefined;
      const authorized = (wanted && candidates.find((l) => l.topics?.[2]?.toLowerCase() === wanted)) || candidates[0];
      if (!authorized) return { status, account: "", publicKey: "", expiry: 0, limits: [], ...blockNumber };
      const a = decodeEventLog({ abi: KEYCHAIN_EVENTS_ABI, data: authorized.data, topics: authorized.topics })
        .args as any;
      const account = String(a.account);
      const authorizedKey = String(a.publicKey);
      const limits: { token: string; amount: bigint }[] = [];
      for (const l of fromKeychain) {
        if (l.topics?.[0]?.toLowerCase() !== limitTopic) continue;
        const u = decodeEventLog({ abi: KEYCHAIN_EVENTS_ABI, data: l.data, topics: l.topics }).args as any;
        // Only this key's limits on this root: a transaction can touch other keys too.
        if (String(u.account).toLowerCase() !== account.toLowerCase()) continue;
        if (String(u.publicKey).toLowerCase() !== authorizedKey.toLowerCase()) continue;
        limits.push({ token: String(u.token), amount: BigInt(u.newLimit) });
      }
      let limitsFrom: KeyAuthorizedLog["limitsFrom"] = limits.length ? "logs" : undefined;
      let scopes: AllowedCallsLog | undefined;
      const tx = (await client.request({ method: "eth_getTransactionByHash", params: [txHash] }).catch(() => null)) as {
        keyAuthorization?: RpcKeyAuthorization | null;
      } | null;
      const auth = tx?.keyAuthorization;
      if (auth && typeof auth.keyId === "string" && auth.keyId.toLowerCase() === authorizedKey.toLowerCase()) {
        // The signed payload is what the keychain enforced from; a log for the same token, which
        // would be a later update in the same transaction, keeps precedence.
        for (const l of auth.limits ?? []) {
          if (limits.some((x) => x.token.toLowerCase() === String(l.token).toLowerCase())) continue;
          limits.push({ token: String(l.token), amount: BigInt(l.limit) });
        }
        limitsFrom = "authorization";
        // Only a payload that carries the field says anything about scopes (`KeyAuthorizedLog.scopes`):
        // read as what the root signed, the one record of a key's scopes a revoke does not erase.
        if (Array.isArray(auth.allowedCalls)) {
          scopes = { isScoped: true, scopes: flattenCallScopes(auth.allowedCalls) };
        }
      }
      return {
        status,
        account,
        publicKey: authorizedKey,
        expiry: Number(BigInt(a.expiry)),
        limits,
        ...(limitsFrom ? { limitsFrom } : {}),
        ...(scopes ? { scopes } : {}),
        ...blockNumber,
      };
    } catch {
      return null;
    }
  }

  /**
   * A key's call scopes as the keychain holds them now (check (d)): `getKey` first,
   * then `getAllowedCalls`, both raw `eth_call`s to the keychain. A key `getKey` says is revoked — or
   * answers with a zero `keyId`, no key of that account — comes back `revoked` with no scopes and no
   * second call: whatever the keychain answers for it is not the scopes the loop paid under, and (d)
   * reads the authorization instead.
   *
   * `null` on any failure, both reads included, so an unrevoked answer is always one whose revoked
   * state was read: an unscoped answer for a key whose state is unknown could be a revoked key, and
   * would fail (d) for nothing.
   */
  async allowedCalls(account: string, key: string): Promise<AllowedCallsLog | null> {
    try {
      const client = await this.connect();
      const { encodeFunctionData, decodeFunctionResult } = await loadViem();
      // Lower case, because viem refuses a mixed-case address whose checksum is wrong, and the payer
      // and key arrive as a record or a policy spelled them — a spelling is not a different address.
      const args = [account.toLowerCase(), key.toLowerCase()];
      const view = async (functionName: "getKey" | "getAllowedCalls") => {
        const data = encodeFunctionData({ abi: KEYCHAIN_VIEWS_ABI, functionName, args });
        const raw = await client.request({
          method: "eth_call",
          params: [{ to: TEMPO_ACCOUNT_KEYCHAIN, data }, "latest"],
        });
        // An empty answer is a node with no keychain there, not a key with no scopes.
        if (!raw || raw === "0x") throw new Error(`${functionName} answered nothing`);
        return decodeFunctionResult({ abi: KEYCHAIN_VIEWS_ABI, functionName, data: raw }) as any;
      };
      const k = await view("getKey");
      if (k.isRevoked || BigInt(k.keyId) === BigInt(0)) return { isScoped: false, scopes: [], revoked: true };
      const out = await view("getAllowedCalls");
      if (!Array.isArray(out)) return null;
      return { isScoped: Boolean(out[0]), scopes: flattenCallScopes(out[1] ?? []), revoked: false };
    } catch {
      return null;
    }
  }
}

/**
 * Every `ChannelClosed` log in a receipt, decoded, in log order. Only a log the escrow itself emitted
 * counts: anyone may emit an event with the same topic.
 */
export async function channelClosuresIn(
  logs: readonly RpcLog[],
  escrow: string = TEMPO_ESCROW
): Promise<ChannelClosedLog[]> {
  const topic = (await channelClosedTopic()).toLowerCase();
  const { decodeEventLog } = await loadViem();
  const out: ChannelClosedLog[] = [];
  for (const log of logs) {
    if (log.address?.toLowerCase() !== escrow.toLowerCase()) continue;
    if (log.topics?.[0]?.toLowerCase() !== topic) continue;
    const args = decodeEventLog({ abi: ESCROW_ABI, data: log.data, topics: log.topics }).args as any;
    out.push({
      channelId: String(args.channelId),
      payer: String(args.payer),
      payee: String(args.payee),
      finalAmount: BigInt(args.finalAmount),
      refund: BigInt(args.refund),
    });
  }
  return out;
}
