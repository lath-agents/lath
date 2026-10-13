/**
 * Every read the evidence page needs, and nothing that writes: HTTP GETs to the console's open
 * routes, read calls to a Solana devnet RPC, read calls to Tempo's public RPC, and GETs to the Irys
 * gateway. No key is loaded and no transaction is built; the Solana clients are handed a signer that
 * throws, so a write could not be signed even by mistake.
 *
 * Each read stands alone. One that fails is written into `unread` in plain words, with any RPC key
 * masked, and the page says what it could not show instead of failing whole: a page with the Tempo
 * half and without the Solana half is still worth publishing, and a page that silently dropped a
 * section would not be.
 */
import { createRpc } from "@lightprotocol/stateless.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { toEventSelector } from "viem";
import {
  BillingClient,
  LathClient,
  TEMPO_ACCOUNT_KEYCHAIN,
  TempoRpcReader,
  decodeLoopReceipt,
  decodeSasAttestationAccount,
  hex,
  loopReceiptAddress,
  toBytes32,
} from "../../sdk/src";
import type { LoopView } from "../../frontend/src/types/loop";
import type { ChainFacts, ChainRecord, EvidenceInput, ReceiptAccountFacts, SourcesFacts, TempoFacts } from "./build";
import { type ChargeFact, type TempoChannelFact, maskSecrets } from "./model";

export interface GatherOptions {
  loopId: string;
  /** The console's origin, e.g. `http://localhost:3000`. */
  console: string;
  /** A ZK-compression RPC for Solana devnet (Photon and the prover on one url). */
  rpc: string;
  /** Tempo mainnet's RPC. */
  tempoRpc: string;
  /** The lath-billing treasury's admin, whose PDAs hold the owner's balance. */
  billingAdmin: string;
  /** `demo-links.json` from the take, when given: a fallback for what the console's view lacks. */
  links?: Record<string, any> | null;
  log?: (line: string) => void;
}

/** A signer that cannot sign: the SDK's clients want one, and this one makes every write throw. */
const READ_ONLY = {
  publicKey: PublicKey.default,
  async signTransaction(): Promise<never> {
    throw new Error("the evidence generator is read-only");
  },
  async signAllTransactions(): Promise<never> {
    throw new Error("the evidence generator is read-only");
  },
};

/** The KeyRevoked event, as `viem/tempo`'s `Abis.accountKeychain` declares it. */
const KEY_REVOKED_SIGNATURE = "KeyRevoked(address,address)";
/** rpc.tempo.xyz refuses an `eth_getLogs` range past 100 000 blocks (as measured). */
const TEMPO_LOG_SPAN = BigInt(98_000);

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

/** One Irys object as the runtime writes it: a tag line, then canonical JSON (`SOURCES_TAG`). */
async function irysJson(gateway: string, id: string): Promise<any> {
  const res = await fetch(`${gateway.replace(/\/+$/, "")}/${id}`);
  if (!res.ok) throw new Error(`Irys answered ${res.status} for ${id}`);
  const text = await res.text();
  return JSON.parse(text.slice(text.indexOf("\n") + 1));
}

const pad32 = (address: string) => `0x${address.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;

export async function gather(opts: GatherOptions): Promise<EvidenceInput> {
  const log = opts.log ?? (() => {});
  const unread: string[] = [];
  const fail = (what: string, e: unknown) => {
    const line = `${what}: ${maskSecrets(e instanceof Error ? e.message : String(e))}`;
    unread.push(line);
    log(`  ! ${line}`);
  };

  // ── The console's open reads. The loop row is the one read the page cannot do without.
  log(`console: GET /api/loops?id=${opts.loopId}`);
  const answer = await getJson(`${opts.console}/api/loops?id=${encodeURIComponent(opts.loopId)}`);
  const loop: LoopView | undefined = answer?.loop;
  if (!loop?.id) throw new Error(`the console has no loop ${opts.loopId}`);
  if (answer.cluster && answer.cluster !== "devnet") throw new Error(`the console is on ${answer.cluster}, not devnet`);

  let treasury: EvidenceInput["treasury"] = null;
  try {
    const t = await getJson(`${opts.console}/api/tempo/treasury`);
    treasury = { address: t?.address ?? null, token: t?.token ?? null };
  } catch (e) {
    fail("The console's treasury route did not answer", e);
  }

  let irys: { index?: string; gateway?: string } | null = null;
  try {
    log(`console: GET /api/zeroclaw/${opts.loopId}`);
    const z = await getJson(`${opts.console}/api/zeroclaw/${encodeURIComponent(opts.loopId)}`);
    irys = z?.sandbox?.irys?.value ?? null;
  } catch (e) {
    fail("The console's sandbox route did not answer", e);
  }
  // The row carries the same index; the sandbox route is preferred because it is what the take reads.
  if (!irys?.index && loop.sandbox?.irys?.index) {
    irys = { index: loop.sandbox.irys.index, gateway: loop.sandbox.irys.gateway };
  }

  const [chain, receiptAccount] = await readSolana(loop, opts, fail, log);
  const tempo = await readTempo(loop, opts, fail, log);
  const sources = await readSources(irys, fail, log);

  if (opts.links && loop.receipt && !loop.receipt.signature && typeof opts.links.receiptTransaction === "string") {
    const sig = /\/tx\/([1-9A-HJ-NP-Za-km-z]{64,90})/.exec(opts.links.receiptTransaction)?.[1];
    if (sig && receiptAccount && !receiptAccount.signature) receiptAccount.signature = sig;
  }

  return {
    generatedAt: new Date().toISOString(),
    loop,
    treasury,
    chain,
    tempo,
    receiptAccount,
    sources,
    unread,
  };
}

async function readSolana(
  loop: LoopView,
  opts: GatherOptions,
  fail: (what: string, e: unknown) => void,
  log: (line: string) => void
): Promise<[ChainFacts | null, ReceiptAccountFacts | null]> {
  const rpc = createRpc(opts.rpc, opts.rpc, opts.rpc, { commitment: "confirmed" });
  const client = LathClient.fromIdl(rpc, READ_ONLY as any);
  const connection = new Connection(opts.rpc, "confirmed");
  const agentId = toBytes32(loop.agentId);
  const chain: ChainFacts = {};

  try {
    const genesis = await connection.getGenesisHash();
    if (genesis !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") {
      throw new Error(`the RPC is not Solana devnet (genesis ${genesis})`);
    }
  } catch (e) {
    fail("The Solana RPC could not be used", e);
    return [null, null];
  }

  // The agent's key: the only key that may append to its chain, and the `agentAuthority` its charges name.
  try {
    log("solana: the agent's state");
    const state = await client.getAgentState(agentId);
    chain.authority = state ? state.state.authority.toBase58() : null;
  } catch (e) {
    fail("The agent's state was not read", e);
  }

  // Every signature on the agent's compressed address, oldest last: the oldest is `register_agent`,
  // the only instruction that creates the address, and the times place each record in the loop.
  try {
    log("solana: the agent's signatures");
    const address = client.agentAddress(agentId);
    const items: { signature: string; slot: number; blockTime: number }[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 200; page++) {
      const res = await rpc.getCompressionSignaturesForAddress(address, { cursor });
      items.push(...res.items);
      if (!res.cursor || seen.has(res.cursor)) break;
      seen.add(res.cursor);
      cursor = res.cursor;
    }
    chain.times = Object.fromEntries(items.map((s) => [s.signature, { slot: s.slot, blockTime: s.blockTime }]));
    const oldest = items.reduce<(typeof items)[number] | null>((o, s) => (!o || s.slot < o.slot ? s : o), null);
    if (oldest) chain.registration = { signature: oldest.signature, slot: oldest.slot, blockTime: oldest.blockTime };
  } catch (e) {
    fail("The agent's transaction list was not read", e);
  }

  // The records, epochs and cells, decoded from those transactions by the SDK's own history reader
  // (the one `lath-audit --recover` uses). It reads every transaction of the agent, so a fresh demo
  // agent is a few dozen reads and an old one a few hundred.
  try {
    log("solana: the agent's history (one read per transaction)");
    const h = await client.readHistory(agentId);
    chain.records = h.events.map(
      (r): ChainRecord => ({
        seq: r.seq.toString(),
        kind: r.kind,
        status: r.status,
        reference: hex(r.reference),
        signature: r.signature ?? "",
      })
    );
    chain.epochs = h.epochs.map((e) => ({
      startSeq: e.startSeq.toString(),
      endSeq: e.endSeq.toString(),
      signature: e.signature,
    }));
    chain.cells = h.cells.map((c) => ({ opSeq: c.opSeq.toString(), signature: c.signature }));
  } catch (e) {
    fail("The agent's records were not read from Solana", e);
  }

  // The charges: `Charged` events on the owner's balance by this agent's key, in the loop's window. The
  // window's signatures are found first (a signature list carries its time), so the decoding read
  // (`BillingClient.chargeHistory`) asks for exactly those transactions and no others.
  try {
    log("solana: the owner's charges");
    const billing = BillingClient.fromIdl(connection, READ_ONLY as any, { admin: new PublicKey(opts.billingAdmin) });
    const owner = new PublicKey(loop.owner);
    const balance = billing.balanceAddress(owner);
    chain.balanceAccount = balance.toBase58();
    const history = loop.history ?? [];
    const from = Math.floor(loop.createdAt / 1000) - 120;
    const lastEnd = Math.max(loop.lastStepAt ?? 0, ...history.map((x: any) => x.endedAt ?? 0));
    const to = Math.floor(lastEnd / 1000) + 900;
    let before: string | undefined;
    let newerThanWindow: string | undefined;
    const inWindow: string[] = [];
    for (let page = 0; page < 50; page++) {
      const sigs = await connection.getSignaturesForAddress(balance, { limit: 1000, before });
      if (!sigs.length) break;
      for (const s of sigs) {
        const t = s.blockTime ?? 0;
        if (t > to) newerThanWindow = s.signature;
        else if (t >= from && !s.err) inWindow.push(s.signature);
      }
      before = sigs[sigs.length - 1].signature;
      if ((sigs[sigs.length - 1].blockTime ?? 0) < from) break;
    }
    const charges: ChargeFact[] = [];
    if (inWindow.length) {
      const activity = await billing.chargeHistory(owner, { before: newerThanWindow, limit: inWindow.length + 5 });
      const recordSig = new Map((chain.records ?? []).map((r) => [r.signature, r.seq]));
      for (const a of activity) {
        if (a.name !== "Charged") continue;
        if (chain.authority && a.agentAuthority?.toBase58() !== chain.authority) continue;
        if ((a.blockTime ?? 0) < from || (a.blockTime ?? 0) > to) continue;
        const seq = recordSig.get(a.signature);
        charges.push({
          signature: a.signature,
          slot: a.slot,
          blockTime: a.blockTime,
          amountMicroUsdc: a.amount.toString(),
          ...(seq ? { seq } : {}),
        });
      }
    }
    chain.charges = charges;
  } catch (e) {
    fail("The owner's charges were not read from Solana", e);
  }

  // The receipt, when the loop's policy commits one: the account at the address its pointer and the
  // loop id derive, decoded, and the transaction that created it.
  let receiptAccount: ReceiptAccountFacts | null = null;
  const r = loop.receipt;
  if (r) {
    try {
      const derived = loopReceiptAddress({ credential: r.credential, schema: r.schema }, loop.id);
      if (derived !== r.address) throw new Error(`the console names ${r.address}, and the pointer derives ${derived}`);
      log("solana: the receipt account");
      const info = await connection.getAccountInfo(new PublicKey(derived), "confirmed");
      if (info) {
        const att = decodeSasAttestationAccount(new Uint8Array(info.data));
        const values = att ? decodeLoopReceipt(att.data) : null;
        let signature = r.signature;
        if (!signature) {
          const sigs = await connection.getSignaturesForAddress(new PublicKey(derived), { limit: 20 });
          signature = sigs.filter((s) => !s.err).at(-1)?.signature;
        }
        receiptAccount = {
          owner: info.owner.toBase58(),
          credential: att?.credential ?? "",
          schema: att?.schema ?? "",
          signer: att?.signer ?? "",
          values: values
            ? {
                agent: values.agent,
                loop: values.loop,
                seq: values.seq,
                head: values.head,
                steps: values.steps,
                goal: values.goal,
                usdcCharged: values.usdcCharged,
                tempoSpent: values.tempoSpent,
                tempoPayer: values.tempoPayer,
              }
            : null,
          ...(signature ? { signature } : {}),
        };
        if (!att) fail(`The account at ${derived} does not decode as an attestation`, `owner ${info.owner.toBase58()}`);
        else if (!values)
          fail(`The receipt at ${derived} does not decode as loop-receipt v1`, "its data did not decode");
      } else if (r.status === "published") {
        throw new Error(`no account at ${derived}`);
      }
    } catch (e) {
      fail("The receipt account was not read", e);
    }
  }
  return [chain, receiptAccount];
}

async function readTempo(
  loop: LoopView,
  opts: GatherOptions,
  fail: (what: string, e: unknown) => void,
  log: (line: string) => void
): Promise<TempoFacts | null> {
  if (!loop.tempo && !loop.tempoKey) return null;
  const reader = new TempoRpcReader({ url: opts.tempoRpc });
  const facts: TempoFacts = { channels: [] };
  const history = loop.history ?? [];
  const key = loop.tempoKey ?? null;
  const payer = loop.tempo?.payer ?? null;

  // The key: its authorization as Tempo's receipt says it, whether the keychain reads it revoked now,
  // and the revoke itself, which the console does not keep — found as the keychain's own `KeyRevoked`
  // log for this key on this root, after the settlement.
  if (key) {
    facts.key = { revoked: null };
    try {
      log("tempo: the key's authorization");
      if (key.authorizeTx) {
        const auth = await reader.keyAuthorized(key.authorizeTx, key.address);
        if (auth?.blockNumber) facts.key.authorizeBlock = auth.blockNumber;
        const limit = auth?.limits.find((l) => l.token.toLowerCase() === key.token.toLowerCase());
        if (limit) facts.key.limitBase = limit.amount.toString();
      }
    } catch (e) {
      fail("The key's authorization was not read from Tempo", e);
    }
    if (payer) {
      try {
        const calls = await reader.allowedCalls(payer, key.address);
        if (calls) facts.key.revoked = !!calls.revoked;
      } catch (e) {
        fail("The key's state was not read from Tempo", e);
      }
      try {
        const from = loop.tempo?.services?.closeBlock ?? facts.key.authorizeBlock;
        if (from) {
          log("tempo: the key's revoke");
          // The window ends at Tempo's head, not past it: a loop that stopped less than a window ago would
          // otherwise ask for blocks that do not exist yet, which rpc.tempo.xyz refuses outright
          // ("block range extends beyond current head block").
          const headRes = await fetch(opts.tempoRpc, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
          });
          const head = BigInt(((await headRes.json()) as { result?: string }).result ?? "0x0");
          const span = BigInt(from) + TEMPO_LOG_SPAN;
          const to = head > 0n && head < span ? head : span;
          const res = await fetch(opts.tempoRpc, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "eth_getLogs",
              params: [
                {
                  address: TEMPO_ACCOUNT_KEYCHAIN,
                  topics: [toEventSelector(KEY_REVOKED_SIGNATURE), pad32(payer), pad32(key.address)],
                  fromBlock: `0x${BigInt(from).toString(16)}`,
                  toBlock: `0x${to.toString(16)}`,
                },
              ],
            }),
          });
          const body = (await res.json()) as { result?: { transactionHash?: string }[]; error?: { message?: string } };
          if (body.error) throw new Error(body.error.message ?? "eth_getLogs refused");
          const tx = body.result?.find((l) => l.transactionHash)?.transactionHash;
          if (tx) facts.key.revokeTx = tx;
        }
      } catch (e) {
        fail("The key's revoke was not looked up on Tempo", e);
      }
    }
  }

  // The model channel(s): every id a step's snapshot names, and the row's. A keyed loop that reopened
  // has more than one; each is opened from the block the first snapshot that names it was read at,
  // or from the key's authorization, which precedes every channel the key signs.
  const ids: string[] = [];
  const firstBlock = new Map<string, string>();
  for (const h of history) {
    const id = h.tempoSnapshot?.channel?.id;
    if (!id) continue;
    if (!ids.includes(id)) ids.push(id);
    if (!firstBlock.has(id) && h.tempoSnapshot?.block) firstBlock.set(id, h.tempoSnapshot.block);
  }
  if (loop.tempo?.channelId && !ids.includes(loop.tempo.channelId)) ids.push(loop.tempo.channelId);
  for (const id of ids) {
    const ch: TempoChannelFact = { id, role: "model" };
    try {
      log(`tempo: channel ${id.slice(0, 10)}… opened`);
      const near = facts.key?.authorizeBlock ?? firstBlock.get(id);
      // The open is before the first snapshot that names the channel, by up to a step's length; a few
      // thousand blocks back covers any step this console runs, and the read's own window looks ahead.
      const fromBlock = near
        ? (facts.key?.authorizeBlock
            ? BigInt(near)
            : BigInt(near) > BigInt(4000)
            ? BigInt(near) - BigInt(4000)
            : BigInt(0)
          ).toString()
        : undefined;
      const open = await reader.channelOpened(id, fromBlock);
      if (open) {
        ch.openBlock = open.blockNumber;
        if (open.txHash) ch.openTx = open.txHash;
        ch.depositBase = open.deposit.toString();
        ch.signer = open.authorizedSigner;
        ch.payer = open.payer;
        ch.payee = open.payee;
      } else {
        fail(`The open of channel ${id} was not found on Tempo`, "no ChannelOpened log in the blocks searched");
      }
    } catch (e) {
      fail(`The open of channel ${id} was not read from Tempo`, e);
    }
    if (loop.tempo?.channelId === id && loop.tempo.closed && loop.tempo.txHash) {
      ch.closeTx = loop.tempo.txHash;
      try {
        log("tempo: the channel's settlement");
        const close = await reader.closeReceipt(loop.tempo.txHash, id);
        const closed = close?.closures?.find((c) => c.channelId.toLowerCase() === id.toLowerCase()) ?? close?.closed;
        if (close && close.status === 1 && closed && closed.channelId.toLowerCase() === id.toLowerCase()) {
          ch.paidBase = closed.finalAmount.toString();
          ch.refundBase = closed.refund.toString();
          ch.payee = closed.payee;
        } else {
          throw new Error(`its receipt carries no ChannelClosed for ${id}`);
        }
      } catch (e) {
        fail("The channel's settlement was not read from Tempo", e);
      }
    }
    facts.channels!.push(ch);
  }

  // Lath's own RPC session: the console records its close and what it spent; Lath pays it.
  const rpcSession = loop.tempo?.services?.rpc;
  if (rpcSession?.channelId) {
    facts.channels!.push({
      id: rpcSession.channelId,
      role: "rpc",
      ...(rpcSession.closed && rpcSession.txHash ? { closeTx: rpcSession.txHash } : {}),
      ...(rpcSession.spent ? { paidBase: rpcSession.spent } : {}),
    });
  }

  // Each storage PUT's transaction, read so a reference the console kept but Tempo does not have is
  // said rather than linked as if it were there.
  for (const h of history) {
    const ref = h.tempoStorage?.reference;
    if (!ref) continue;
    try {
      const receipt = await reader.txReceipt(ref);
      if (!receipt) fail(`Step ${h.step}'s storage PUT ${ref} was not found on Tempo`, "no receipt");
      else if (receipt.status !== 1)
        fail(`Step ${h.step}'s storage PUT ${ref} reverted on Tempo`, `status ${receipt.status}`);
    } catch (e) {
      fail(`Step ${h.step}'s storage PUT was not read from Tempo`, e);
    }
  }
  return facts;
}

async function readSources(
  irys: { index?: string; gateway?: string } | null,
  fail: (what: string, e: unknown) => void,
  log: (line: string) => void
): Promise<SourcesFacts | null> {
  if (!irys?.index) return null;
  const gateway = irys.gateway ?? "https://gateway.irys.xyz";
  try {
    log("irys: the sources index and manifest");
    const index = await irysJson(gateway, irys.index);
    const facts: SourcesFacts = {
      index: irys.index,
      ...(index.manifest ? { manifest: index.manifest } : {}),
      ...(index.sourcesHash ? { sourcesHash: index.sourcesHash } : {}),
      files: index.files ?? {},
    };
    if (index.manifest) {
      const manifest = await irysJson(gateway, index.manifest);
      facts.entries = manifest.sources ?? [];
    }
    return facts;
  } catch (e) {
    fail("The sources were not read from Irys", e);
    return { index: irys.index };
  }
}
