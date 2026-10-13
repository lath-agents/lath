import { assert } from "chai";
import { createHash } from "crypto";
import {
  fileToolArgs,
  llmToolNames,
  paymentOf,
  readMatchesPinned,
  readTarget,
  rebuildNumberedRead,
  stepCounts,
  sumPayments,
  voucherDelta,
  workspaceRelative,
} from "../frontend/src/lib/zeroclaw-proof";

/**
 * The ZeroClaw page's proof screen (`frontend/src/lib/zeroclaw-proof.ts`): which file a `zc.file_read`
 * read and whether it is a pinned source on Irys, whether the text the model was shown re-builds to the
 * pinned file, what the step's model calls paid on Tempo, and the counts a locked page shows. DOM-free,
 * so the page and this suite run the same functions. Node-only: no validator, no RPC, no gateway.
 */

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));

/** `tools/file_read.rs` for a whole read: `str::lines`, numbered from 1, and the `[N lines total]` trailer. */
function fileReadAnswer(contents: string): string {
  const lines = contents.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const plain = lines.map((l) => l.replace(/\r$/, ""));
  if (plain.length === 0) return "";
  return `${plain.map((l, i) => `${i + 1}: ${l}`).join("\n")}\n[${plain.length} lines total]`;
}

const FILE = '{\n  "upgradeAuthority": "pAtqwgcvW6LeQcF3RfqVarpjLTTeoMxZdPGiP43tw3P"\n}\n';
const MANIFEST = {
  sources: [
    {
      dir: "2-solana-devnet-EXkX",
      files: [
        { path: "2-solana-devnet-EXkX/account.json", size: FILE.length, sha256: sha(FILE) },
        { path: "2-solana-devnet-EXkX/decoded.json", size: 10, sha256: sha("decoded\n") },
      ],
    },
    { dir: "1-github-squads", files: [{ path: "1-github-squads/programs/lib.rs", size: 4, sha256: sha("fn\n") }] },
  ],
};
const IRYS = { gateway: "https://gateway.irys.xyz", files: { [sha(FILE)]: "IrysId111" } };

describe("zeroclaw proof: a file read's args", () => {
  it("reads the path, and whether only part of the file was asked for", () => {
    assert.deepEqual(fileToolArgs(enc({ path: "sources/a.json" })), { path: "sources/a.json", partial: false });
    assert.deepEqual(fileToolArgs(enc({ path: "a.md", offset: 3, limit: 10 })), { path: "a.md", partial: true });
    assert.deepEqual(fileToolArgs(enc({ path: "a.pdf", encoding: "base64" })), { path: "a.pdf", partial: true });
  });

  it("gives no path for args that carry none, rather than inventing one", () => {
    assert.isNull(fileToolArgs(enc({ _raw: "not json" })));
    assert.isNull(fileToolArgs(enc({ path: "" })));
    assert.isNull(fileToolArgs(enc("nonsense")));
    assert.isNull(fileToolArgs(undefined));
  });
});

describe("zeroclaw proof: where a read's path points", () => {
  it("normalizes to the workspace, and refuses a path that leaves it", () => {
    assert.equal(workspaceRelative("./sources//x/y.json"), "sources/x/y.json");
    assert.equal(workspaceRelative("/lath/work/sources/x.json", "/lath/work"), "sources/x.json");
    assert.isNull(workspaceRelative("sources/../../etc/passwd"));
    assert.isNull(workspaceRelative("/etc/passwd", "/lath/work"));
  });

  it("links a pinned source to its own object on Irys, by the hash the manifest commits", () => {
    const t = readTarget("sources/2-solana-devnet-EXkX/account.json", MANIFEST, IRYS);
    assert.equal(t.kind, "source");
    if (t.kind !== "source") return;
    assert.equal(t.url, "https://gateway.irys.xyz/IrysId111");
    assert.equal(t.file.sha256, sha(FILE));
  });

  it("names a pinned file with no Irys object as pinned, with no link", () => {
    const t = readTarget("sources/2-solana-devnet-EXkX/decoded.json", MANIFEST, IRYS);
    assert.equal(t.kind, "source");
    if (t.kind === "source") assert.isNull(t.url);
    const locked = readTarget("sources/2-solana-devnet-EXkX/account.json", MANIFEST, null);
    if (locked.kind === "source") assert.isNull(locked.url);
  });

  it("says workspace for the step's own files, and unlisted for a sources/ path the manifest lacks", () => {
    assert.deepEqual(readTarget("report/authority.md", MANIFEST, IRYS), {
      kind: "workspace",
      path: "report/authority.md",
    });
    assert.equal(readTarget("sources/2-solana-devnet-EXkX", MANIFEST, IRYS).kind, "unlisted");
    assert.equal(readTarget("sources/nope.json", MANIFEST, IRYS).kind, "unlisted");
    // No manifest (none sent, none on Irys): a sources/ path is not claimed as pinned.
    assert.equal(readTarget("sources/2-solana-devnet-EXkX/account.json", null, IRYS).kind, "unlisted");
  });
});

describe("zeroclaw proof: the read's text against the pinned file", () => {
  it("re-builds a whole numbered read to the pinned bytes", () => {
    const r = readMatchesPinned(fileReadAnswer(FILE), 200, sha(FILE), sha);
    assert.equal(r.verdict, "match");
  });

  it("matches a file without a final newline, a CRLF file and an empty one", () => {
    const bare = FILE.trimEnd();
    assert.equal(readMatchesPinned(fileReadAnswer(bare), 200, sha(bare), sha).verdict, "match");
    const crlf = FILE.replace(/\n/g, "\r\n");
    assert.equal(readMatchesPinned(fileReadAnswer(crlf), 200, sha(crlf), sha).verdict, "match");
    assert.equal(readMatchesPinned("", 200, sha(""), sha).verdict, "match");
  });

  it("fails a whole read whose lines are not the pinned file's", () => {
    const other = FILE.replace("pAtq", "C6bY");
    const r = readMatchesPinned(fileReadAnswer(other), 200, sha(FILE), sha);
    assert.equal(r.verdict, "mismatch");
  });

  it("does not judge what cannot be re-built: a partial, truncated, failed or sealed read", () => {
    const partial = '2:   "upgradeAuthority": "pAtq"\n[Lines 2-2 of 3]';
    assert.equal(readMatchesPinned(partial, 200, sha(FILE), sha).verdict, "unavailable");
    const truncated = "1: {\n...[truncated 40 chars]...\n3: }\n[3 lines total]";
    assert.equal(readMatchesPinned(truncated, 200, sha(FILE), sha).verdict, "unavailable");
    assert.equal(readMatchesPinned("Error: file not found", 500, sha(FILE), sha).verdict, "unavailable");
    assert.equal(readMatchesPinned(null, 200, sha(FILE), sha).verdict, "unavailable");
    assert.isNull(rebuildNumberedRead("1: a\n3: c\n[2 lines total]"));
  });
});

describe("zeroclaw proof: model calls on Tempo", () => {
  const payment = (before: string, after: string, channelId = "0xAB") => ({
    payment: {
      rail: "tempo",
      chainId: 4217,
      payer: "0x18",
      channelId,
      cumulativeBefore: before,
      cumulativeAfter: after,
    },
    choices: [],
  });

  it("reads a call's voucher delta from its result blob", () => {
    const p = paymentOf(enc(payment("1000", "3500")));
    assert.isNotNull(p);
    assert.equal(voucherDelta(p!), BigInt(2500));
    assert.isNull(paymentOf(enc({ choices: [] })));
    assert.isNull(paymentOf(enc({ payment: { rail: "vault", channelId: "0xAB" } })));
  });

  it("sums the step's calls and names the channels they rode, case-insensitively", () => {
    const got = sumPayments([
      paymentOf(enc(payment("0", "1500"))),
      null,
      paymentOf(enc(payment("1500", "4000", "0xab"))),
    ]);
    assert.equal(got.paid, 2);
    assert.equal(got.total, BigInt(4000));
    assert.deepEqual(got.channels, ["0xab"]);
  });

  it("never counts a voucher that went backwards as a refund", () => {
    assert.equal(voucherDelta({ channelId: "0x1", cumulativeBefore: "9", cumulativeAfter: "3" }), BigInt(0));
  });
});

describe("zeroclaw proof: counts from tool ids alone", () => {
  it("names a model call by the model the policy document commits", () => {
    assert.deepEqual(llmToolNames('{"model":"deepseek/deepseek-v4.1-flash","payment":"tempo"}'), [
      "llm.deepseek/deepseek-v4.1-flash",
    ]);
    assert.deepEqual(llmToolNames(null), []);
    assert.deepEqual(llmToolNames("not json"), []);
  });

  it("counts reads, writes and model calls, and leaves the checkpoint out", () => {
    const llm = sha("llm.deepseek/deepseek-v4.1-flash");
    const rows = [
      { tool: null, toolHash: llm },
      { tool: "zc.file_read", toolHash: sha("zc.file_read") },
      { tool: "zc.file_read", toolHash: sha("zc.file_read") },
      { tool: "solana.balance", toolHash: sha("solana.balance") },
      { tool: null, toolHash: llm },
      { tool: "zc.file_write", toolHash: sha("zc.file_write") },
      { tool: null, toolHash: sha("llm.some/dated-model-2026") },
      { tool: "loop.step", toolHash: sha("loop.step") },
    ];
    assert.deepEqual(stepCounts(rows, new Set([llm])), { reads: 2, writes: 1, modelCalls: 2, other: 2 });
  });
});
