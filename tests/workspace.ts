/**
 * The workspace's pure half (`frontend/src/lib/workspace.ts`): the URL it reads and writes, where
 * the retired list routes land, how a wallet's
 * runs nest under their agents, which item a URL selects, what a run row says about Tempo, and the
 * Solana tab's _What it records and charges_ lines. And the lifecycle records on screen
 * (`frontend/src/lib/chain-records.ts`): their names, pinned to the SDK's list, the _On Solana_ lines,
 * the _recording on Solana…_ chip and the read-only state of a row rebuilt from the chain.
 *
 * Node-only: `workspace.ts` imports nothing, and `chain-records.ts` only types.
 */
import { assert } from "chai";
import {
  HISTORY_KEPT,
  NestAgent,
  NestLoop,
  legacyRedirect,
  nestWorkspace,
  parseWorkspaceParams,
  RECEIPT_ACCOUNT_BYTES,
  RECEIPT_RENT_LAMPORTS,
  resolveSelection,
  SOLANA_RECORDS,
  runTempo,
  usdcEText,
  workspaceHref,
} from "../frontend/src/lib/workspace";
import {
  LIFECYCLE_LABELS,
  LIFECYCLE_TOOL_IDS,
  REBUILT_LABEL,
  REBUILT_TITLE,
  chainOwes,
  chainRebuilt,
  chainRecordLines,
  deployRecord,
  lifecycleLabel,
  owedText,
} from "../frontend/src/lib/chain-records";
import { LIFECYCLE_TOOLS } from "../sdk/src/lifecycle";
import type { LifecycleRef } from "../frontend/src/types/loop";

const A = "a".repeat(64);
const B = "b".repeat(64);
const M = "c".repeat(64);
const N = "d".repeat(64);

function agent(agentId: string, activityMs = 0): NestAgent {
  return { agentId, activityMs };
}

function loop(id: string, agentId: string, over: Partial<NestLoop> = {}): NestLoop {
  return { id, agentId, status: "stopped", createdAt: 0, ...over };
}

describe("workspace URL", () => {
  it("reads tab, item and run, and opens on Yours", () => {
    assert.deepEqual(parseWorkspaceParams(""), { tab: "yours", item: null, run: null });
    assert.deepEqual(parseWorkspaceParams("?tab=solana"), { tab: "solana", item: null, run: null });
    assert.deepEqual(parseWorkspaceParams("?tab=tempo"), { tab: "tempo", item: null, run: null });
    assert.deepEqual(parseWorkspaceParams(`?tab=yours&item=${A.toUpperCase()}&run=loop-1`), {
      tab: "yours",
      item: A,
      run: "loop-1",
    });
    // Next's `searchParams` shape, with a repeated parameter.
    assert.deepEqual(parseWorkspaceParams({ tab: ["tempo", "solana"], item: undefined }), {
      tab: "tempo",
      item: null,
      run: null,
    });
  });

  it("treats an unknown tab and empty values as absent", () => {
    assert.deepEqual(parseWorkspaceParams("?tab=agents&item=&run=%20"), { tab: "yours", item: null, run: null });
    // A Market tab link (the marketplace is on the roadmap) opens Yours.
    assert.deepEqual(parseWorkspaceParams(`?tab=market&item=${A}`), { tab: "yours", item: A, run: null });
    assert.deepEqual(parseWorkspaceParams(null), { tab: "yours", item: null, run: null });
  });

  it("writes only what it is given, in order", () => {
    assert.equal(workspaceHref(), "/");
    assert.equal(workspaceHref({ item: A }), `/?item=${A}`);
    assert.equal(
      workspaceHref({ tab: "yours", item: A.toUpperCase(), run: "loop-1" }),
      `/?tab=yours&item=${A}&run=loop-1`
    );
    assert.equal(workspaceHref({ tab: "solana", item: null, run: null }), "/?tab=solana");
  });

  it("round-trips", () => {
    const params = { tab: "tempo" as const, item: B, run: "loop-x" };
    assert.deepEqual(parseWorkspaceParams(workspaceHref(params).slice(1)), params);
  });
});

describe("retired routes", () => {
  it("lands /agents?agent=X on /?item=X", () => {
    assert.equal(legacyRedirect("/agents", `?agent=${A}`), `/?item=${A}`);
    assert.equal(legacyRedirect("/agents", { agent: A.toUpperCase() }), `/?item=${A}`);
    assert.equal(legacyRedirect("/agents", ""), "/");
  });

  it("lands /loops?loop=L on the run, with its agent when it can be found", () => {
    assert.equal(legacyRedirect("/loops", "?loop=loop-1"), "/?run=loop-1");
    assert.equal(
      legacyRedirect("/loops", "?loop=loop-1", (id) => (id === "loop-1" ? A : null)),
      `/?item=${A}&run=loop-1`
    );
    assert.equal(
      legacyRedirect("/loops", "?loop=loop-2", () => null),
      "/?run=loop-2"
    );
    assert.equal(legacyRedirect("/loops/", ""), "/");
  });

  it("lands /zeroclaw and /market on /", () => {
    assert.equal(legacyRedirect("/zeroclaw", ""), "/");
    // The Market tab's (the marketplace is on the roadmap).
    assert.equal(legacyRedirect("/market", ""), "/");
    assert.equal(legacyRedirect("/market/", "?agent=x"), "/");
  });

  it("leaves every other path alone", () => {
    for (const path of ["/", "/agent/x", "/loop/x", "/zeroclaw/x", "/market/publish", "/console", "/billing"])
      assert.isNull(legacyRedirect(path, ""), path);
  });
});

describe("nesting runs under agents", () => {
  it("puts the live run first, folds the rest newest first, and drops archived runs", () => {
    const rows = nestWorkspace(
      [agent(A, 10)],
      [
        loop("old", A, { createdAt: 1 }),
        loop("newer-stopped", A, { createdAt: 3 }),
        loop("paused", A, { status: "paused", createdAt: 2 }),
        loop("archived", A, { status: "running", createdAt: 9, archivedAt: 10 }),
      ]
    );
    assert.lengthOf(rows, 1);
    assert.equal(rows[0].current?.loop.id, "paused");
    assert.deepEqual(
      rows[0].earlier.map((r) => r.loop.id),
      ["newer-stopped", "old"]
    );
    assert.isTrue(rows[0].live);
  });

  it("with no live run, the latest one speaks for the agent", () => {
    const [row] = nestWorkspace([agent(A)], [loop("one", A, { createdAt: 1 }), loop("two", A, { createdAt: 2 })]);
    assert.equal(row.current?.loop.id, "two");
    assert.isFalse(row.live);
  });

  it("an agent with no runs is a row with nothing under it", () => {
    const [row] = nestWorkspace([agent(B)], []);
    assert.isNull(row.current);
    assert.deepEqual(row.earlier, []);
  });

  it("matches ids in any case and lists an agent once", () => {
    const rows = nestWorkspace([agent(A.toUpperCase()), agent(A)], [loop("one", A.toUpperCase())]);
    assert.lengthOf(rows, 1);
    assert.equal(rows[0].agentId, A);
    assert.equal(rows[0].current?.loop.id, "one");
  });

  it("lists every agent as its own row: a team member is not nested under a run", () => {
    // Teams are not in this build, and nor is the nesting: an agent a stored team ran is
    // listed like any other, and a run's view carries no roster to nest it by.
    const rows = nestWorkspace([agent(A), agent(M), agent(N)], [loop("team", A, { status: "running", createdAt: 5 })]);
    assert.deepEqual(rows.map((r) => r.agentId).sort(), [A, M, N].sort());
    assert.deepEqual(rows.find((r) => r.agentId === A)?.current, { loop: rows[0].current!.loop });
  });

  it("orders live rows first, then by activity, and keeps the caller's order on ties", () => {
    const rows = nestWorkspace(
      [agent(A, 100), agent(B, 100), agent(M, 500), agent(N, 1)],
      [loop("live", N, { status: "running", createdAt: 0, lastStepAt: 2 })]
    );
    assert.deepEqual(
      rows.map((r) => r.agentId),
      [N, M, A, B]
    );
  });

  it("a run's last step counts as its agent's activity", () => {
    const rows = nestWorkspace([agent(A, 100), agent(B, 50)], [loop("one", B, { createdAt: 10, lastStepAt: 900 })]);
    assert.deepEqual(
      rows.map((r) => r.agentId),
      [B, A]
    );
    assert.equal(rows[0].activityMs, 900);
  });
});

describe("selecting from the URL", () => {
  const rows = nestWorkspace(
    [agent(A, 2), agent(B, 1), agent(M)],
    [loop("a-live", A, { status: "running", createdAt: 2 }), loop("a-old", A, { createdAt: 1 })]
  );

  it("a run brings its agent, whatever item says", () => {
    assert.deepEqual(resolveSelection(rows, { item: B, run: "a-old" }), { agentId: A, runId: "a-old" });
    assert.deepEqual(resolveSelection(rows, { item: null, run: "a-live" }), { agentId: A, runId: "a-live" });
  });

  it("an item is an agent row, in any case", () => {
    assert.deepEqual(resolveSelection(rows, { item: B, run: null }), { agentId: B, runId: null });
    assert.deepEqual(resolveSelection(rows, { item: M.toUpperCase(), run: null }), { agentId: M, runId: null });
  });

  it("anything the list does not hold falls back to the first row", () => {
    assert.deepEqual(resolveSelection(rows, { item: "f".repeat(64), run: "gone" }), { agentId: A, runId: null });
    assert.deepEqual(resolveSelection(rows, { item: null, run: null }), { agentId: A, runId: null });
    assert.deepEqual(resolveSelection([], { item: A, run: "a-live" }), { agentId: null, runId: null });
  });
});

describe("a run's Tempo line", () => {
  const base = { status: "running" as const, steps: 2, history: [] as { tempoSpent?: string }[] };

  it("sums what the kept steps paid, and says nothing for steps that said nothing", () => {
    const t = runTempo({
      ...base,
      rail: "tempo",
      history: [{ tempoSpent: "1200" }, {}, { tempoSpent: "x" }, { tempoSpent: "800" }],
    });
    assert.equal(t.paidBase, BigInt(2000));
    assert.isTrue(t.onTempo);
    assert.isNull(runTempo({ ...base, rail: "tempo", history: [{}] }).paidBase);
  });

  it("is live only while running with a cumulative on the open channel", () => {
    assert.isTrue(runTempo({ ...base, channel: { cumulative: "10" } }).live);
    assert.isFalse(runTempo({ ...base, channel: { cumulative: "" } }).live);
    assert.isFalse(runTempo({ ...base, status: "paused", channel: { cumulative: "10" } }).live);
    assert.isFalse(runTempo({ ...base, channel: null }).live);
  });

  it("is scripted only when nothing says Tempo", () => {
    assert.isTrue(runTempo({ ...base, inference: "scripted" }).scripted);
    assert.isFalse(runTempo({ ...base, inference: "scripted", rail: "tempo" }).scripted);
    // A settled channel is a run that paid on Tempo, whatever `inference` was stored as.
    assert.isTrue(runTempo({ ...base, inference: "scripted", tempo: { txHash: "0x1" } }).onTempo);
    assert.isFalse(runTempo({ ...base, inference: "scripted", tempo: { txHash: "0x1" } }).scripted);
  });

  it("says when the console kept only the last steps", () => {
    const history = Array.from({ length: HISTORY_KEPT }, () => ({ tempoSpent: "1" }));
    assert.isTrue(runTempo({ ...base, steps: HISTORY_KEPT + 3, history }).capped);
    assert.isFalse(runTempo({ ...base, steps: HISTORY_KEPT, history }).capped);
  });

  it("prints USDC.e with at least two decimals", () => {
    assert.equal(usdcEText(BigInt(104000)), "0.104");
    assert.equal(usdcEText(BigInt(200)), "0.0002");
    assert.equal(usdcEText(BigInt(0)), "0.00");
    assert.equal(usdcEText(BigInt(12_500_000)), "12.50");
  });
});

describe("the Solana tab's records lines", () => {
  const line = (key: string) => {
    const found = SOLANA_RECORDS.find((r) => r.key === key);
    assert.exists(found, key);
    return found!;
  };

  // No `sas.attest` line (a roadmap plugin, paid by the loop's key): the receipt's line, paid by
  // Lath, is the one attestation line.
  it("lists the receipt, paid by Lath, and no loop-paid attestation", () => {
    assert.deepEqual(
      SOLANA_RECORDS.map((r) => r.key),
      ["records", "model-calls", "receipt"]
    );
    assert.notInclude(SOLANA_RECORDS.map((r) => r.who) as string[], "loop");
    assert.isFalse(SOLANA_RECORDS.some((r) => /368 B|0\.0025/.test(r.how)));
    const receipt = line("receipt");
    assert.equal(receipt.who, "Lath");
    assert.include(receipt.how, "one per loop");
    assert.include(receipt.how, "achieved");
    assert.include(receipt.how, "paid by the console's key");
  });

  it("states the receipt's size and rent as the constants say", () => {
    const how = line("receipt").how;
    assert.include(how, `${RECEIPT_ACCOUNT_BYTES} B`);
    // 2 763 520 lamports is 0.00276352 SOL, which the line rounds to four places.
    assert.include(how, `about ${(RECEIPT_RENT_LAMPORTS / 1e9).toFixed(4)} SOL of rent`);
    assert.include(how, "5 000-lamport fee");
  });

  it("says the receipt points at the records, never that it proves them", () => {
    const how = line("receipt").how;
    assert.include(how, "points at the loop's records");
    assert.notMatch(how, /prov/i);
  });

  // No _Loop keys_ line, since no grant plugin is in this build and a receipt-only loop makes no
  // Solana key; and no line says a charge shares the record's transaction, which is false for every
  // loop step, whose charges are journaled ahead of the epoch.
  it("lists no loop-key line and never claims the charge shares the record's transaction", () => {
    assert.notInclude(SOLANA_RECORDS.map((r) => r.key) as string[], "loop-keys");
    assert.isFalse(SOLANA_RECORDS.some((r) => /same transaction/.test(r.how)));
    assert.include(line("model-calls").how, "call by call");
  });
});

describe("lifecycle records on screen", () => {
  function ref(tool: string, seq: string, at = Number(seq), signature?: string): LifecycleRef {
    return { tool, seq, at, ...(signature ? { signature } : {}) };
  }

  it("names every record kind the SDK writes, in its order", () => {
    // The literals stand in for the SDK's list so the browser table needs no rebuilt bundle; a kind
    // added to `LIFECYCLE_TOOLS` fails here until it has a name.
    assert.deepEqual([...LIFECYCLE_TOOL_IDS], [...LIFECYCLE_TOOLS]);
    for (const tool of LIFECYCLE_TOOLS) assert.notEqual(lifecycleLabel(tool), tool, `${tool} has a name`);
    assert.equal(LIFECYCLE_LABELS["loop.start"], "Loop started");
    assert.equal(LIFECYCLE_LABELS["loop.pause"], "Loop paused");
    assert.equal(LIFECYCLE_LABELS["loop.resume"], "Loop resumed");
    assert.equal(LIFECYCLE_LABELS["loop.stop"], "Loop stopped");
    assert.equal(LIFECYCLE_LABELS["agent.deploy"], "Agent deployed");
    // A kind this build does not know shows as its id, never as nothing.
    assert.equal(lifecycleLabel("loop.later"), "loop.later");
  });

  it("lists records oldest first by seq, numerically", () => {
    const lines = chainRecordLines([
      ref("loop.stop", "10", 5, "sigC"),
      ref("loop.start", "2", 1, "sigA"),
      ref("loop.pause", "9", 3),
    ]);
    assert.deepEqual(
      lines.map((l) => [l.tool, l.seq, l.label]),
      [
        ["loop.start", "2", "Loop started"],
        ["loop.pause", "9", "Loop paused"],
        ["loop.stop", "10", "Loop stopped"],
      ]
    );
    assert.equal(lines[0].signature, "sigA");
    assert.isUndefined(lines[1].signature);
    assert.equal(new Set(lines.map((l) => l.key)).size, 3, "keys are distinct");
  });

  it("puts the stop's reason on the stop that ended the run, and nowhere else", () => {
    const ended = chainRecordLines([ref("loop.start", "1"), ref("loop.stop", "4")], { stopReason: "goal reached" });
    assert.equal(ended[1].detail, "goal reached");
    assert.isUndefined(ended[0].detail);
    // A stop a resume undid ended nothing the row's reason speaks of.
    const resumed = chainRecordLines([ref("loop.stop", "4"), ref("loop.resume", "5")], { stopReason: "budget" });
    assert.isTrue(resumed.every((l) => l.detail === undefined));
    // No reason, no detail; a blank one is no reason.
    assert.isUndefined(chainRecordLines([ref("loop.stop", "4")], { stopReason: "  " })[0].detail);
    assert.isUndefined(chainRecordLines([ref("loop.stop", "4")])[0].detail);
  });

  it("reads a row without records as an empty list", () => {
    assert.deepEqual(chainRecordLines(undefined), []);
    assert.deepEqual(chainRecordLines([]), []);
  });

  it("names what is owed, and says nothing when nothing is", () => {
    assert.isNull(owedText(undefined));
    assert.isNull(owedText([]));
    assert.equal(owedText(["loop.pause"]), "recording on Solana… loop paused");
    assert.equal(owedText(["loop.pause", "loop.stop"]), "recording on Solana… loop paused, loop stopped");
    assert.equal(owedText(["loop.later"]), "recording on Solana… loop.later");
    assert.isFalse(chainOwes(undefined));
    assert.isFalse(chainOwes({ owed: [] }));
    assert.isTrue(chainOwes({ owed: ["loop.stop"] }));
  });

  it("is read-only only on a row the server says it rebuilt", () => {
    assert.isFalse(chainRebuilt(undefined));
    assert.isFalse(chainRebuilt({}));
    assert.isFalse(chainRebuilt({ rebuilt: false }));
    assert.isTrue(chainRebuilt({ rebuilt: true }));
    assert.equal(REBUILT_LABEL, "rebuilt from chain · read-only");
    for (const verb of ["paused", "resumed", "retried", "stopped"]) assert.include(REBUILT_TITLE, verb);
  });

  it("finds the agent's first deploy record, and none on an agent from before the records", () => {
    assert.isNull(deployRecord(undefined));
    assert.isNull(deployRecord([ref("agent.archive", "3")]));
    const d = deployRecord([ref("agent.archive", "7"), ref("agent.deploy", "12"), ref("agent.deploy", "1", 0, "sig")]);
    assert.equal(d?.seq, "1");
    assert.equal(d?.signature, "sig");
  });

  it("keeps the screen's words free of the names it must not use", () => {
    const words = [...Object.values(LIFECYCLE_LABELS), REBUILT_LABEL, REBUILT_TITLE, owedText(["loop.stop"])!];
    for (const w of words) assert.notMatch(w, /\b(hire|worker|provider|jev|deterministic)\b/i);
  });
});
