/**
 * `POST /api/store/<agent id>` — the owner writes one key of their agent's store
 * (`sdk/src/store.ts`).
 *
 * The chain only lets the agent's own key replace a cell, and for a console agent that key is held
 * here, so a wallet's write is a request this server signs for. What makes it the owner's and not the
 * server's is the `"Lath agent"` message: its action line carries the first 128 bits of
 * `sha256(entry)` (`storeWriteBinding`), so the signature covers the key and the value, a nonce makes
 * it good once, and the cell's `tag` records that the write was the owner's.
 *
 * Reads have no route: the browser lists the cells over Photon and re-hashes each entry it fetches
 * from `/api/traces`, the same as it reads anything else.
 *
 * A write is a chain write on the agent, so it takes the run slot a session and a loop step take,
 * and it refuses while the agent's anchor queue still owes the chain records: a cell folded in
 * ahead of them would take the seq the queue is holding.
 */
import { NextRequest } from "next/server";
import { AgentStore, FileTraceStore, LathClient, StoreWriter, storeWriteBinding, toBytes32 } from "@lath/sdk";
import { anchorQueue } from "../../_lib/anchor";
import {
  SessionAuth,
  TRACE_DIR,
  acquireRunSlot,
  consoleOrigin,
  deployedRoles,
  ensureFunded,
  isArchived,
  loadKeypair,
  lookupAgent,
  rateLimit,
  rpcFor,
  verifyAuth,
  walletIn,
} from "../../_lib/runner";
import { asBody, bodyTooLarge, readJsonCapped } from "../../rpc/proxy";
import { betaRefused } from "../../_lib/beta";

export const dynamic = "force-dynamic";

/** Each write funds a chain transaction from the server's SOL, so one wallet gets a few. */
const STORE_WRITES_PER_HOUR = Number(process.env.LATH_STORE_WRITES_PER_HOUR ?? 30);
/** A write is one or two transactions (the header the first time); the slot outlives both. */
const STORE_SLOT_MS = 90_000;
/**
 * A store write's body: a key, a value of at most `MAX_STORE_VALUE_BYTES` (1 KiB) and a signed
 * message. Sixteen times the value leaves room for every character of it written as a `\u` escape
 * and for the signature, and none for a body that is not a store write.
 */
const STORE_BODY_BYTES = 16 * 1024;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id.toLowerCase();
  // Read whole and capped before it is parsed or the signature is looked at: `req.json()` would
  // buffer whatever was sent, unsigned, before the key check below runs.
  const read = await readJsonCapped(req, STORE_BODY_BYTES);
  if (!read) return bodyTooLarge(STORE_BODY_BYTES);
  if (read.json === undefined) return Response.json({ error: "body is not JSON" }, { status: 400 });
  const body = asBody<{ key: unknown; value: unknown; auth: SessionAuth }>(read.json);
  if (typeof body.key !== "string" || typeof body.value !== "string") {
    return Response.json({ error: "key and value are strings" }, { status: 400 });
  }
  const { key, value } = body;

  let binding;
  try {
    binding = storeWriteBinding(id, key, value);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }

  const record = lookupAgent(id);
  if (!record) return Response.json({ error: `no agent ${id} was deployed here` }, { status: 404 });
  if (isArchived(record)) return Response.json({ error: `${record.name} is archived` }, { status: 409 });

  const verified = verifyAuth(
    body.auth,
    body.auth ? walletIn(body.auth.message) : null,
    "Lath agent",
    binding,
    consoleOrigin(req)
  );
  if (!("wallet" in verified)) {
    return Response.json({ error: `a wallet signature is required: ${verified.reason}` }, { status: 401 });
  }
  const wallet = verified.wallet.toBase58();
  // The closed beta (`_lib/beta.ts`): every write funds a chain transaction from the server's SOL —
  // `ensureFunded` tops the agent's key up, and the first write creates the store's header too.
  const closed = betaRefused(wallet);
  if (closed) return closed;
  if (record.owner !== wallet) {
    return Response.json(
      { error: record.owner ? `${record.name} belongs to another wallet` : `${record.name} has no recorded owner` },
      { status: 403 }
    );
  }
  const limited = rateLimit("store writes", `store:${wallet}`, STORE_WRITES_PER_HOUR);
  if (limited) return Response.json({ error: limited }, { status: 429 });

  const server = loadKeypair();
  if (!server) return Response.json({ error: "this console has no server key" }, { status: 503 });

  const slot = acquireRunSlot("a store write", STORE_SLOT_MS);
  if (!slot) return Response.json({ error: "another run is in progress; try again in a minute" }, { status: 429 });
  try {
    const idBytes = toBytes32(id);
    const queue = anchorQueue();
    // Loads the journal as well as reading the tip, so the two lists below are this agent's.
    await queue.tip(idBytes);
    if (queue.pending(idBytes).length > 0 || queue.failed(idBytes).length > 0) {
      return Response.json(
        { error: `${record.name} still has records anchoring; try again when its chain has caught up` },
        { status: 409 }
      );
    }

    const rpc = rpcFor();
    const agentKey = deployedRoles(server, record.name).agent.key;
    // Throws, naming the key and the shortfall, when the server cannot fund the write.
    await ensureFunded(rpc, server, agentKey.publicKey);

    const store = new AgentStore(LathClient.fromIdl(rpc, agentKey), idBytes, new FileTraceStore(TRACE_DIR));
    await store.ensureCreated();
    const written = await store.set(key, value, StoreWriter.Owner);
    await queue.expect(idBytes, BigInt(written.cell.opSeq) + 1n);
    return Response.json({
      key,
      version: written.cell.indexOrVersion.toString(),
      opSeq: written.cell.opSeq.toString(),
      signature: written.signature,
    });
  } catch (e) {
    return Response.json({ error: (e as Error)?.message ?? String(e) }, { status: 500 });
  } finally {
    slot.release();
  }
}
