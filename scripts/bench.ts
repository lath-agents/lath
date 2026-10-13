/**
 * Cost benchmark (compared against SPEC §8).
 *
 * Logs N events per mode and reports what each one actually cost: lamports/event from the
 * payer's balance delta, and CU/event from the confirmed transactions' metadata.
 *
 * ```bash
 * # devnet, the numbers that matter. The url holds an API key, so prefer the environment —
 * # `--rpc` still works and is the convenient form for a one-off run by hand.
 * LATH_DEVNET_RPC="https://devnet.helius-rpc.com/?api-key=…" ts-node scripts/bench.ts --events 1000 --json bench.json
 * ```
 *
 * Notes on what the numbers include: the client attaches no priority fee by default, so a
 * lamports/event figure is base fee + Light's tree costs and nothing else. Compressed accounts
 * pay no rent, so nothing here is refundable and nothing is a deposit — the balance delta *is*
 * the cost. `register_agent` is measured separately: it is once per agent, not per event.
 */
import { createRpc, Rpc } from "@lightprotocol/stateless.js";
import { DEVNET_GENESIS, assertCluster } from "./_cluster";
import { Keypair, PublicKey } from "@solana/web3.js";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  type ActionPayload,
  EventKind,
  LathClient,
  MAX_EVENTS_PER_TX,
  StructKind,
  idFromString,
  sha256,
  u64le,
  utf8,
} from "../sdk/src";

type EventMode = "full" | "compact" | "batch";
type CellMode = "create_struct" | "cell_append" | "cell_put" | "cell_replace" | "cell_close";
type Mode = EventMode | CellMode;
const CELL_MODES: CellMode[] = ["create_struct", "cell_append", "cell_put", "cell_replace", "cell_close"];

export interface ModeResult {
  mode: Mode;
  events: number;
  transactions: number;
  lamports: number;
  lamportsPerEvent: number;
  cuPerEvent: number;
  cuPerTransaction: number;
  msPerEvent: number;
  failures: number;
}

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * A long run against a public RPC will hit a 429 or a dropped connection sooner or later, and
 * losing a finished mode's measurements to one is not acceptable. Reads are idempotent, so
 * retry them.
 */
async function withRetry<T>(what: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 400 * 2 ** i));
    }
  }
  throw new Error(`${what} failed after ${attempts} attempts: ${String((last as any)?.message ?? last)}`);
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}

/**
 * The RPC url: `--rpc` when it is given, else `LATH_DEVNET_RPC` (or `LATH_RPC_URL`), else the
 * devnet url in `solana config get`. A Helius devnet endpoint carries its API key in the query string, so the flag is
 * the convenient form for a run by hand and the environment is the only form fit for a script or a
 * CI job — an argument is readable from the process table and echoes into any `set -x` trace.
 */
function rpcArg(): string {
  const fromEnv = process.env.LATH_DEVNET_RPC ?? process.env.LATH_RPC_URL;
  const given = arg("rpc", fromEnv ?? "");
  if (given) return given;
  try {
    const out = execSync("solana config get", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = /^RPC URL:\s*(\S+)/m.exec(out);
    if (m && /devnet/.test(m[1])) return m[1];
  } catch {
    // no CLI; fall through to the error below
  }
  throw new Error("no RPC: pass --rpc, set LATH_DEVNET_RPC, or point `solana config` at devnet");
}

/**
 * What may be printed or written to a report file. The key is the credential, not the host, and a
 * `bench.json` gets pasted into the cost figures (docs/ARCHITECTURE.md §11) — `scripts/init-treasury.ts`
 * redacts the same way.
 */
function redactRpc(url: string): string {
  return url.replace(/(api[-_]?key=)[^&]+/gi, "$1…");
}

/** Mean compute units over the given signatures, in bounded-concurrency batches. */
async function meanComputeUnits(rpc: Rpc, signatures: string[], concurrency = 8): Promise<number> {
  let total = 0;
  let counted = 0;
  for (let i = 0; i < signatures.length; i += concurrency) {
    const slice = signatures.slice(i, i + concurrency);
    const txs = await Promise.all(
      slice.map((s) =>
        withRetry("getTransaction", () =>
          rpc.getTransaction(s, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
        )
      )
    );
    for (const tx of txs) {
      const cu = tx?.meta?.computeUnitsConsumed;
      if (typeof cu === "number") {
        total += cu;
        counted++;
      }
    }
  }
  return counted ? Math.round(total / counted) : 0;
}

/**
 * Runs one mode against a fresh agent. `full` and `compact` write one event per transaction;
 * `batch` writes `MAX_EVENTS_PER_TX` per transaction through `log_events`.
 */
export async function benchMode(
  client: LathClient,
  payer: PublicKey,
  mode: EventMode,
  events: number,
  onProgress?: (done: number) => void
): Promise<ModeResult> {
  const agentId = idFromString(`bench-${mode}-${Date.now()}-${Math.round(performance.now())}`);
  await client.registerAgent(agentId, Date.now());

  const signatures: string[] = [];
  let failures = 0;
  const before = await withRetry("getBalance", () => client.rpc.getBalance(payer));
  const startedAt = performance.now();

  const input = (i: number): ActionPayload => ({
    kind: EventKind.Action as const,
    toolId: "bench.tool",
    argsHash: sha256(u64le(BigInt(i))),
    resultHash: sha256(utf8("result")),
    statusCode: 200,
  });

  let written = 0;
  while (written < events) {
    try {
      if (mode === "batch") {
        const n = Math.min(MAX_EVENTS_PER_TX, events - written);
        const res = await client.logEvents(
          agentId,
          Array.from({ length: n }, (_, k) => input(written + k))
        );
        signatures.push(res[0].signature);
        written += n;
      } else {
        const res = await client.logEvent(agentId, input(written), { compact: mode === "compact" });
        signatures.push(res.signature);
        written += 1;
      }
    } catch (e: any) {
      // A failed write still burned a fee; count it so lamports/event stays honest.
      failures++;
      written += 1;
      console.error(`  ${mode} #${written} failed: ${String(e.message ?? e).slice(0, 120)}`);
    }
    onProgress?.(written);
  }

  const elapsed = performance.now() - startedAt;
  const after = await withRetry("getBalance", () => client.rpc.getBalance(payer));
  const lamports = before - after;
  const cuPerTransaction = await meanComputeUnits(client.rpc, signatures);
  const perTx = mode === "batch" ? MAX_EVENTS_PER_TX : 1;

  return {
    mode,
    events,
    transactions: signatures.length,
    lamports,
    lamportsPerEvent: Math.round((lamports / events) * 10) / 10,
    cuPerEvent: Math.round(cuPerTransaction / perTx),
    cuPerTransaction,
    msPerEvent: Math.round(elapsed / events),
    failures,
  };
}

/**
 * One cell op per transaction, N times, against a fresh owner. Setup that is not the
 * measured op — the owner, the header, the cells a `close` will consume — happens before the
 * balance snapshot, so lamports/op is the op alone, same as the event modes.
 */
export async function benchCellMode(
  client: LathClient,
  payer: PublicKey,
  mode: CellMode,
  ops: number,
  onProgress?: (done: number) => void
): Promise<ModeResult> {
  const ownerId = idFromString(`bench-${mode}-${Date.now()}-${Math.round(performance.now())}`);
  await client.registerAgent(ownerId, Date.now());
  const value = (i: number) => sha256(u64le(BigInt(i)));
  const key = (i: number) => sha256(utf8(`key-${i}`));

  // Un-measured setup.
  let structId = idFromString("bench-map");
  if (mode === "cell_append") {
    structId = idFromString("bench-log");
    await client.createStruct(ownerId, { structId, kind: StructKind.Log, createdAt: Date.now() });
  } else if (mode !== "create_struct") {
    await client.createStruct(ownerId, { structId, kind: StructKind.Map, createdAt: Date.now() });
    if (mode === "cell_replace") {
      await client.createCell(ownerId, structId, { keySlot: key(0), valueSlot: value(0), timestamp: Date.now() });
    } else if (mode === "cell_close") {
      for (let i = 0; i < ops; i++) {
        await client.createCell(ownerId, structId, { keySlot: key(i), valueSlot: value(i), timestamp: Date.now() });
        onProgress?.(0);
      }
    }
  }

  const signatures: string[] = [];
  let failures = 0;
  const before = await withRetry("getBalance", () => client.rpc.getBalance(payer));
  const startedAt = performance.now();

  for (let i = 0; i < ops; i++) {
    try {
      let signature: string;
      if (mode === "create_struct") {
        ({ signature } = await client.createStruct(ownerId, {
          structId: sha256(utf8(`bench-struct-${i}`)),
          kind: StructKind.Log,
          createdAt: Date.now(),
        }));
      } else if (mode === "cell_append") {
        ({ signature } = await client.createCell(ownerId, structId, { valueSlot: value(i), timestamp: Date.now() }));
      } else if (mode === "cell_put") {
        ({ signature } = await client.createCell(ownerId, structId, {
          keySlot: key(i),
          valueSlot: value(i),
          timestamp: Date.now(),
        }));
      } else if (mode === "cell_replace") {
        ({ signature } = await client.replaceCell(ownerId, structId, key(0), {
          keySlot: key(0),
          valueSlot: value(i),
          timestamp: Date.now(),
        }));
      } else {
        ({ signature } = await client.closeCell(ownerId, structId, { keySlot: key(i) }, Date.now()));
      }
      signatures.push(signature);
    } catch (e: any) {
      failures++;
      console.error(`  ${mode} #${i} failed: ${String(e.message ?? e).slice(0, 120)}`);
    }
    onProgress?.(i + 1);
  }

  const elapsed = performance.now() - startedAt;
  const after = await withRetry("getBalance", () => client.rpc.getBalance(payer));
  const lamports = before - after;
  const cuPerTransaction = await meanComputeUnits(client.rpc, signatures);

  return {
    mode,
    events: ops,
    transactions: signatures.length,
    lamports,
    lamportsPerEvent: Math.round((lamports / ops) * 10) / 10,
    cuPerEvent: cuPerTransaction,
    cuPerTransaction,
    msPerEvent: Math.round(elapsed / ops),
    failures,
  };
}

/** Cost of `register_agent`, which is once per agent rather than per event. */
export async function benchRegister(client: LathClient, payer: PublicKey): Promise<ModeResult> {
  const agentId = idFromString(`bench-register-${Date.now()}`);
  const before = await withRetry("getBalance", () => client.rpc.getBalance(payer));
  const startedAt = performance.now();
  const { signature } = await client.registerAgent(agentId, Date.now());
  const elapsed = performance.now() - startedAt;
  const after = await withRetry("getBalance", () => client.rpc.getBalance(payer));
  const cu = await meanComputeUnits(client.rpc, [signature]);
  return {
    mode: "full",
    events: 1,
    transactions: 1,
    lamports: before - after,
    lamportsPerEvent: before - after,
    cuPerEvent: cu,
    cuPerTransaction: cu,
    msPerEvent: Math.round(elapsed),
    failures: 0,
  };
}

function table(rows: ModeResult[], solUsd: number): string {
  const usd = (l: number) => `$${((l / LAMPORTS_PER_SOL) * solUsd).toFixed(5)}`;
  const lines = [
    "| mode | events | txs | lamports/event | " + `USD/event @ $${solUsd}/SOL` + " | CU/event | CU/tx | ms/event |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.mode} | ${r.events} | ${r.transactions} | ${r.lamportsPerEvent} | ${usd(r.lamportsPerEvent)} | ` +
        `${r.cuPerEvent} | ${r.cuPerTransaction} | ${r.msPerEvent} |`
    );
  }
  return lines.join("\n");
}

export async function main(): Promise<void> {
  const rpcUrl = rpcArg();
  const indexer = arg("indexer", rpcUrl)!;
  const prover = arg("prover", rpcUrl)!;
  const events = Number(arg("events", "100"));
  const solUsd = Number(arg("sol-usd", "180"));
  // `--modes cells` is shorthand for every cell op.
  const modes = (arg("modes", "full,compact,batch") as string)
    .split(",")
    .flatMap((m) => (m === "cells" ? CELL_MODES : [m])) as Mode[];
  const keypairPath = arg("keypair", process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config/solana/id.json"))!;

  const rpc = createRpc(rpcUrl, indexer, prover, { commitment: "confirmed" });
  // The bench writes hundreds of events from the payer, so the url is asked which cluster it is
  // before the first one: `--rpc` and the env name no cluster (`_cluster.ts`).
  await assertCluster(rpc, DEVNET_GENESIS, "devnet");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))));
  const client = LathClient.fromIdl(rpc, payer);

  console.log(`rpc      ${redactRpc(rpcUrl)}`);
  console.log(
    `payer    ${payer.publicKey.toBase58()} (${(await rpc.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL)`
  );
  console.log(`program  ${client.programId.toBase58()}`);
  console.log(`events   ${events} per mode: ${modes.join(", ")}\n`);

  const register = await benchRegister(client, payer.publicKey);
  console.log(`register_agent: ${register.lamports} lamports, ${register.cuPerEvent} CU\n`);

  const out = arg("json");
  const rows: ModeResult[] = [];
  for (const mode of modes) {
    process.stdout.write(`${mode}: `);
    try {
      const bench = (CELL_MODES as string[]).includes(mode) ? benchCellMode : benchMode;
      const r = await bench(client, payer.publicKey, mode as never, events, (done) => {
        if (done % 25 === 0) process.stdout.write(`${done} `);
      });
      console.log(`done (${r.failures} failures)`);
      rows.push(r);
      // Emitted per mode, so one dead connection at the end cannot cost a finished measurement.
      console.log(table([r], solUsd));
      if (out)
        fs.writeFileSync(out, JSON.stringify({ rpc: redactRpc(rpcUrl), solUsd, register, modes: rows }, null, 2));
    } catch (e: any) {
      console.error(`\n${mode} aborted: ${String(e.message ?? e).slice(0, 200)}`);
    }
  }

  console.log(`\n${table(rows, solUsd)}`);
  if (out) console.log(`\nwrote ${out}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
