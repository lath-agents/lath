/**
 * The evidence page (`scripts/evidence`), built from a fixture loop row and receipt with no RPC, no
 * console and no network: every explorer link on the right host and cluster, no RPC key, none of the
 * words kept off screen, every mainnet named as Tempo's or Solana's, and the one
 * line a loop without a receipt gets.
 *
 *   npx ts-mocha --paths -p ./tsconfig.json -t 120000 tests/evidence-page.ts
 */
import { assert } from "chai";
import { buildEvidence, type EvidenceInput } from "../scripts/evidence/build";
import { maskSecrets, wordProblems } from "../scripts/evidence/model";
import { renderEvidencePage } from "../scripts/evidence/render";

const AGENT = "5f3ef07bdd6c52b37ca8344e98ffc08b9d4dd65047d033d9e35af2ae1d1cc6b2";
const OWNER = "5d5DsTFFtRCE5YYwBRG9H4mbMQ2WxBTUHjX1WUAegPtv";
const AUTHORITY = "7iptsEwAG1e2JUaXoRELyVm5MDwauXxHCcLEgNwspoNk";
const TREASURY = "0x18fBE5E0A83DCA440072059F91D1a23BaBE6e0B0";
const KEY = "0x1366f16847ad3c934f13Bf39EEeBe56Df168F42d";
const USDC_E = "0x20c000000000000000000000b9537d11c60e8b50";
const CHANNEL = "0x05e37e20a5c3d2f5467e3a3afcf04ba17c21f25fb52f01524bee3d4f7ba85aee";
const RPC_CHANNEL = "0xd014f3bd1dd69eaa7efe3660aea5a250148ea5efffadf3367d1a6046c15414f7";
const tx = (n: number) => `${"5".repeat(20)}${String(n).padStart(4, "0")}${"A".repeat(64)}`.slice(0, 88);
const ttx = (n: number) => `0x${String(n).padStart(4, "0")}${"ab".repeat(30)}`;
const CREATED = 1_791_162_328_431;
const sec = (msAfter: number) => Math.floor((CREATED + msAfter) / 1000);

const RECEIPT = {
  status: "published" as const,
  credential: "B6EmpbCPk3Ln9oSaxzGpG8yQ2F7wfr8uqCaxhv6AU6Ag",
  schema: "Cq4cKbD6p3oGzT9ekhCXXWZr2uK9oS7rWK2YN6ECaH3n",
  signer: "35ZEEEb2Rqn2iRM1xZtmXk1yGqTj6oUTcqX5LhZ1d2Pq",
  address: "9vQ6bAj7hdYxkCDS9x1kq3GwzJ6M1L8d5P2Wc7sSxV4F",
  signature: tx(900),
  values: {
    agent: AGENT,
    loop: "loop-f75a10aff85bc67d",
    seq: "98",
    head: "410b3479fb6d856fe37d874979c70311d159910371cdfd1532dab8766eecb04d",
    steps: 2,
    goal: "6b6244447fd87392f7068dccc9d591be0640984e61b71e497e51e8a35d5230aa",
    usdcCharged: "13209",
    tempoSpent: "12000",
    tempoPayer: KEY.toLowerCase(),
  },
};

/** A trimmed loop row as `GET /api/loops?id=` serves it: two steps, keyed, the goal reached at step 2. */
function loopRow(receipt: any): any {
  return {
    id: "loop-f75a10aff85bc67d",
    agentId: AGENT,
    agentName: "upgrade-watch-film",
    owner: OWNER,
    intervalMs: 10_000,
    maxSteps: 6,
    budgetMicroUsdc: "1000000",
    spentMicroUsdc: "13209",
    jevBudgetBase: "150000",
    jevSpentBase: "84",
    createdAt: CREATED,
    status: "stopped",
    stopReason: "goal-reached",
    steps: 2,
    lastSeq: "98",
    lastHead: RECEIPT.values.head,
    lastStepAt: CREATED + 400_000,
    goalHash: RECEIPT.values.goal,
    tempo: {
      payer: TREASURY,
      channelId: CHANNEL,
      closed: true,
      txHash: ttx(3),
      spent: "12000",
      services: {
        v: 1,
        closeBlock: "42650429",
        rpc: { channelId: RPC_CHANNEL, closed: true, txHash: ttx(4), spent: "7000" },
      },
    },
    tempoKey: {
      address: KEY,
      token: USDC_E,
      limitBase: "1150000",
      expiry: 1_793_754_326,
      authorizeTx: ttx(1),
      remaining: "0",
      isRevoked: true,
    },
    history: [
      {
        step: 1,
        status: "success",
        steps: 2,
        batchedSteps: 6,
        costMicroUsdc: "5430",
        tempoSpent: "4984",
        seq: "62",
        head: "aa",
        leafOk: true,
        signature: tx(62),
        epochs: [],
        startedAt: CREATED + 6_000,
        endedAt: CREATED + 150_000,
        goalCheck: { outcome: "continue", claimed: false, choice: "continue", confidence: 0.96, bar: 0.5 },
        tempoSnapshot: { ofStep: 1, takenAt: 0, block: "42649715", channel: { id: CHANNEL }, rpc: {} },
      },
      {
        step: 2,
        status: "success",
        steps: 3,
        batchedSteps: 8,
        costMicroUsdc: "7779",
        tempoSpent: "7016",
        seq: "98",
        head: RECEIPT.values.head,
        leafOk: true,
        signature: tx(98),
        epochs: [],
        startedAt: CREATED + 200_000,
        endedAt: CREATED + 400_000,
        goalCheck: { outcome: "achieved", claimed: true, choice: "achieved", confidence: 0.93, bar: 0.5 },
        tempoStorage: {
          key: "k",
          path: "report/authority.md",
          bytes: 2419,
          statusCode: 200,
          amount: "200",
          reference: ttx(5),
          seq: "100",
        },
        tempoSnapshot: { ofStep: 2, takenAt: 0, block: "42650412", channel: { id: CHANNEL }, rpc: {} },
      },
    ],
    sandbox: { irys: { index: "3NHdYwxPfthXyx6KzzwWQGZ2xo5aRVwRp4wtDXYwyLvb", gateway: "https://gateway.irys.xyz" } },
    receipt,
  };
}

function input(receipt: any): EvidenceInput {
  const times: Record<string, { slot: number; blockTime: number }> = {};
  const at = (sig: string, ms: number) => {
    times[sig] = { slot: 507_557_000 + Object.keys(times).length, blockTime: sec(ms) };
    return sig;
  };
  return {
    generatedAt: "2026-10-08T12:00:00.000Z",
    loop: loopRow(receipt),
    treasury: { address: TREASURY, token: USDC_E },
    chain: {
      authority: AUTHORITY,
      registration: { signature: tx(1), slot: 505_652_423, blockTime: sec(-3_600_000) },
      balanceAccount: "65da54eQyqgvvoEmRDXZYSTDsqdsEUb4aAgWjKiYPYCS",
      times,
      records: [
        { seq: "53", kind: 0, status: 0, signature: at(tx(53), 7_000) },
        { seq: "61", kind: 3, status: 0, signature: at(tx(61), 140_000) },
        {
          seq: "62",
          kind: 1,
          status: 200,
          reference: "17a3da0813266b1e9df7a1d1a3b9e2b8f1f8a1c5e5b0f1f6c0f6a5e7d8c9b0a1",
          signature: at(tx(62), 145_000),
        },
        { seq: "81", kind: 0, status: 0, signature: at(tx(81), 201_000) },
        { seq: "97", kind: 3, status: 0, signature: at(tx(97), 390_000) },
        { seq: "98", kind: 1, status: 201, signature: at(tx(98), 395_000) },
        { seq: "100", kind: 1, status: 200, signature: at(tx(100), 405_000) },
      ],
      epochs: [
        { startSeq: "54", endSeq: "60", signature: at(tx(54), 130_000) },
        { startSeq: "82", endSeq: "96", signature: at(tx(82), 380_000) },
      ],
      cells: [{ opSeq: "99", signature: at(tx(99), 398_000) }],
      charges: [
        { signature: tx(201), blockTime: sec(40_000), amountMicroUsdc: "2713" },
        { signature: tx(202), blockTime: sec(120_000), amountMicroUsdc: "2717" },
        { signature: tx(203), blockTime: sec(250_000), amountMicroUsdc: "2593" },
        { signature: tx(204), blockTime: sec(300_000), amountMicroUsdc: "2593" },
        { signature: tx(205), blockTime: sec(350_000), amountMicroUsdc: "2373" },
        { signature: tx(100), blockTime: sec(405_000), amountMicroUsdc: "220", seq: "100" },
      ].map((c) => ({ ...c, amountMicroUsdc: c.amountMicroUsdc })),
    },
    tempo: {
      key: { authorizeBlock: "42649433", revoked: true, revokeTx: ttx(6) },
      channels: [
        {
          id: CHANNEL,
          role: "model",
          openTx: ttx(2),
          openBlock: "42649462",
          depositBase: "2466",
          signer: KEY,
          payer: TREASURY,
          closeTx: ttx(3),
          paidBase: "12000",
          refundBase: "1138000",
          payee: "0xca4e835F803cB0b7C428222B3A3B98518d4779Fe",
        },
        { id: RPC_CHANNEL, role: "rpc", closeTx: ttx(4), paidBase: "7000" },
      ],
    },
    receiptAccount: receipt
      ? {
          owner: "22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG",
          credential: RECEIPT.credential,
          schema: RECEIPT.schema,
          signer: RECEIPT.signer,
          values: RECEIPT.values,
          signature: RECEIPT.signature,
        }
      : null,
    sources: {
      index: "3NHdYwxPfthXyx6KzzwWQGZ2xo5aRVwRp4wtDXYwyLvb",
      manifest: "mn6en5iU873jkZoVfcRnDAiH7DFNbpt6ZWedN6Quvro",
      files: {
        ["a".repeat(64)]: "74E71Ws7FzM9WJhNTWfhPgNj9gep5FZyZYnXAb5rxMB9",
        ["b".repeat(64)]: "QLQBvk7BhxQpmhZtCDE3utXcqM2abmSEHoMU4b6mMCx",
      },
      entries: [
        {
          source: {
            kind: "solana",
            cluster: "mainnet",
            address: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
            slot: "453425768",
          },
          dir: "solana/mainnet/SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
          files: [
            {
              path: "solana/mainnet/SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf/account.json",
              size: 219,
              sha256: "a".repeat(64),
            },
          ],
        },
        {
          source: {
            kind: "github",
            owner: "Squads-Protocol",
            repo: "v4",
            ref: null,
            path: null,
            commit: "1".repeat(40),
          },
          dir: "github/Squads-Protocol/v4",
          files: [{ path: "github/Squads-Protocol/v4/README.md", size: 1200, sha256: "b".repeat(64) }],
        },
      ],
    },
    // A read error as `gather.ts` writes one: masked before it reaches the page.
    unread: [
      "The owner's charges page 2 was not read: https://devnet.helius-rpc.com/?api-key=0123-secret answered 429",
    ],
  };
}

/** Every href on the page. */
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
/** The page's visible text, as `wordProblems` reads it. */
const text = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ");

describe("evidence page", () => {
  const withReceipt = renderEvidencePage(buildEvidence(input(RECEIPT)));
  const without = renderEvidencePage(buildEvidence(input(null)));
  const links = hrefs(withReceipt);

  it("links every Solana fact to explorer.solana.com on devnet", () => {
    const sol = links.filter((h) => h.startsWith("https://explorer.solana.com/"));
    const want = [
      `/tx/${tx(1)}`, // the registration
      `/address/${AUTHORITY}`, // the agent's key
      `/tx/${tx(62)}`, // step 1's loop.step
      `/tx/${tx(98)}`, // step 2's loop.step
      `/tx/${tx(54)}`, // step 1's epoch: its calls' record
      `/tx/${tx(201)}`, // a paid call's charge
      `/tx/${tx(205)}`,
      `/tx/${tx(100)}`, // the report's storage.put record and its charge
      `/address/${RECEIPT.address}`, // the attestation
      `/tx/${RECEIPT.signature}`, // its transaction
      `/address/${RECEIPT.credential}`,
      `/address/${RECEIPT.schema}`,
      `/address/65da54eQyqgvvoEmRDXZYSTDsqdsEUb4aAgWjKiYPYCS`, // the owner's balance, behind the USDC figure
    ];
    for (const w of want) {
      assert.include(sol, `https://explorer.solana.com${w}?cluster=devnet`, `no devnet link for ${w}`);
    }
    // Every Solana link names devnet but one: the mainnet source account, which names no cluster.
    const noCluster = sol.filter((h) => !h.endsWith("?cluster=devnet"));
    assert.deepEqual(noCluster, ["https://explorer.solana.com/address/SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"]);
  });

  it("links every Tempo fact to explore.tempo.xyz", () => {
    for (const w of [
      `/address/${TREASURY}`,
      `/address/${KEY}`,
      `/tx/${ttx(1)}`, // the key's authorization
      `/tx/${ttx(2)}`, // the channel's open
      `/tx/${ttx(3)}`, // its settlement
      `/tx/${ttx(4)}`, // Lath's RPC session
      `/tx/${ttx(5)}`, // the storage PUT
      `/tx/${ttx(6)}`, // the key's revoke
      `/block/42649433`,
    ]) {
      assert.include(links, `https://explore.tempo.xyz${w}`, `no Tempo link for ${w}`);
    }
    // The receipt's payer is the loop key, linked on Tempo.
    assert.include(links, `https://explore.tempo.xyz/address/${KEY.toLowerCase()}`);
  });

  it("links each pinned file and the index on the Irys gateway, and each pin where it opens", () => {
    for (const id of [
      "3NHdYwxPfthXyx6KzzwWQGZ2xo5aRVwRp4wtDXYwyLvb",
      "mn6en5iU873jkZoVfcRnDAiH7DFNbpt6ZWedN6Quvro",
      "74E71Ws7FzM9WJhNTWfhPgNj9gep5FZyZYnXAb5rxMB9",
      "QLQBvk7BhxQpmhZtCDE3utXcqM2abmSEHoMU4b6mMCx",
    ]) {
      assert.include(links, `https://gateway.irys.xyz/${id}`);
    }
    assert.include(links, `https://github.com/Squads-Protocol/v4/tree/${"1".repeat(40)}`);
  });

  it("opens nothing but the explorers, the gateway, GitHub, the fonts and the site", () => {
    const hosts = new Set(links.map((h) => (h.startsWith("data:") ? "data:" : new URL(h).host)));
    for (const h of hosts) {
      assert.include(
        [
          "explorer.solana.com",
          "explore.tempo.xyz",
          "gateway.irys.xyz",
          "github.com",
          "fonts.googleapis.com",
          "fonts.gstatic.com",
          "getlath.xyz",
          "data:",
        ],
        h
      );
    }
    assert.notMatch(withReceipt, /<script/i, "the page runs no script");
  });

  it("carries no RPC key, even from a read error", () => {
    for (const html of [withReceipt, without]) {
      assert.notMatch(html, /api-key/i);
      assert.notInclude(html, "0123-secret");
    }
    assert.notInclude(maskSecrets("https://x/?api-key=abc&x=1"), "abc");
  });

  it("carries no key a URL source's own address holds, on the page or in the json", () => {
    // The page's html escapes `&` to `&amp;`, which a mask over the rendered text would not match.
    const base = input(null);
    const url = {
      source: {
        kind: "url",
        input: "https://docs.example.org/a?x=1&token=tok-SECRET",
        finalUrl: "https://docs.example.org/a?x=1&token=tok-SECRET&key=key-SECRET",
      },
      dir: "url/docs.example.org/a",
      files: [{ path: "url/docs.example.org/a/a", size: 10, sha256: "c".repeat(64) }],
    };
    const sources = { ...base.sources!, entries: [...base.sources!.entries, url] } as typeof base.sources;
    const evidence = buildEvidence({ ...base, sources });
    const html = renderEvidencePage(evidence);
    for (const out of [html, JSON.stringify(evidence)]) {
      assert.notInclude(out, "tok-SECRET");
      assert.notInclude(out, "key-SECRET");
    }
    assert.include(text(html), "docs.example.org", "the source is still named");
  });

  it("says none of the words the film keeps off screen", () => {
    for (const html of [withReceipt, without]) {
      const t = text(html);
      for (const w of ["deterministic", "hire", "worker", "provider", "proves"]) {
        assert.notMatch(t, new RegExp(`\\b${w}\\b`, "i"), `the page says "${w}"`);
      }
      assert.deepEqual(wordProblems(html), []);
    }
  });

  it("never says mainnet without naming whose", () => {
    for (const html of [withReceipt, without]) {
      const t = text(html);
      const all = t.match(/\bmainnet\b/gi) ?? [];
      assert.isAbove(all.length, 0);
      const bare = t.match(/(?<!Tempo |Solana )\bmainnet\b/gi);
      assert.isNull(bare, `a bare "mainnet": ${bare?.join(", ")}`);
    }
    assert.include(text(withReceipt), "Solana mainnet account SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
  });

  it("names the decision model, and Jev once", () => {
    const t = text(withReceipt);
    assert.include(t, "the decision model, Jev, judged it achieved (0.93)");
    assert.lengthOf(t.match(/\bJev\b/g) ?? [], 1);
  });

  it("says what happened in three lines, with both currencies kept apart", () => {
    const t = text(withReceipt).replace(/\s+/g, " ");
    assert.include(t, "Goal reached at step 2");
    assert.include(t, "0.013209 USDC charged on Solana (devnet)");
    // The channel's settlement plus the report's PUT.
    assert.include(t, "0.012200 USDC.e paid on Tempo mainnet");
    assert.include(t, "the goal's SHA-256");
  });

  it("gives each step its record, its paid calls with their charges, the decision and the report's PUT", () => {
    const e = buildEvidence(input(RECEIPT));
    assert.lengthOf(e.steps, 2);
    assert.deepEqual(
      e.steps.map((s) => s.calls.map((c) => c.amountMicroUsdc)),
      [
        ["2713", "2717"],
        ["2593", "2593", "2373"],
      ]
    );
    assert.equal(e.steps[1].storage?.chargeMicroUsdc, "220");
    assert.equal(e.steps[1].decision?.outcome, "achieved");
    assert.equal(e.steps[0].epochs[0]?.endSeq, "59");
    assert.equal(e.cost.chargedMicroUsdc, "13209");
    assert.deepEqual(e.otherCharges, []);
  });

  it("shows the receipt's decoded fields and says it points at the records", () => {
    const t = text(withReceipt).replace(/\s+/g, " ");
    for (const field of ["agent", "loop", "seq", "head", "steps", "goal", "usdcCharged", "tempoSpent", "tempoPayer"]) {
      assert.match(withReceipt, new RegExp(`<dt>${field}</dt>`), `no ${field}`);
    }
    assert.include(t, "This receipt points at the loop's records; lath-audit verify-receipt checks it against them.");
    assert.include(t, "decoded from the account on Solana devnet");
  });

  it("gives a loop without a receipt its one line", () => {
    assert.include(text(without), "This loop has no receipt on SAS: it ran without SAS · receipt.");
    assert.notInclude(without, "<dt>usdcCharged</dt>");
    assert.notInclude(text(without), "verify-receipt");
  });

  it("prints the audit commands with the agent's name, and says the traces are encrypted once", () => {
    const t = text(withReceipt);
    for (const c of [
      "npm run -s audit -- verify-channel --name upgrade-watch-film",
      "--key",
      "npm run -s audit -- verify-step --name upgrade-watch-film 98",
      "npm run -s audit -- verify-receipt --name upgrade-watch-film --loop loop-f75a10aff85bc67d",
      "npm run -s audit -- --name upgrade-watch-film",
      "--gateway https://gateway.irys.xyz --scheme 4 --encoding base64url",
    ]) {
      assert.include(t, c);
    }
    assert.lengthOf(t.match(/encrypted to the owner: anyone can check them/g) ?? [], 1);
  });

  it("says a run written in the clear is public, and asks for no key", () => {
    // Every run this console starts: encryption is on the roadmap.
    const base = input(RECEIPT);
    const plain = text(renderEvidencePage(buildEvidence({ ...base, loop: { ...base.loop, plainTraces: true } })));
    assert.lengthOf(plain.match(/The traces are public: anyone can read them/g) ?? [], 1);
    assert.include(plain, "--require-preimages opens and re-hashes each one with no key");
    assert.notMatch(plain, /encrypted to the owner|inside the encrypted trace|--trace-key/);
  });

  it("is titled in a few words and works at phone width", () => {
    assert.match(withReceipt, /<title>Lath run evidence<\/title>/);
    assert.match(withReceipt, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(withReceipt, /:root\{[^}]*--spine-volt/);
    assert.match(withReceipt, /@media \(max-width:640px\)/);
    assert.notMatch(withReceipt, /purple|violet|#a855f7|#8b5cf6/i);
  });
});
