import { traceDir } from "./fixtures/trace-dir";
import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { hex, MemoryTraceStore, sha256, utf8, type Locator } from "@lath/sdk";
import type { SourcesUploader } from "../frontend/src/app/api/_lib/sources-irys";
import { wrapperKind } from "../runtime/src/zeroclaw/posture";
import type { ZeroClawBinary } from "../runtime/src/zeroclaw/runtime";
import { publicLoop, type LoopRecord, type SourcesCell } from "../frontend/src/app/api/_lib/loops";
import {
  answerLoopStart,
  streamLoopStart,
  wantsStartStream,
  type LoopStartAnswer,
  type LoopStartOptions,
} from "../frontend/src/app/api/_lib/loop-start";
import { recordAgent } from "../frontend/src/app/api/_lib/runner";
import type { SourcesDeps } from "../frontend/src/app/api/_lib/sources";
import type { TransportResponse } from "../frontend/src/app/api/_lib/safe-fetch";
import {
  loopStartStageLabel,
  readLoopStart,
  readSseEvents,
  type LoopStartStage,
} from "../frontend/src/lib/loop-start-stream";

/**
 * A loop start told as it goes: `POST /api/loops` with
 * `Accept: text/event-stream` streams each stage — the check, the source fetch, the Irys pin or its
 * reuse, the start — and ends on the answer the plain request gets.
 *
 * What is pinned:
 *
 * - **the stages arrive in order**, with the counts the button names;
 * - **the last event is the plain answer**, status and body, for the same stubbed start — the
 *   stream is a view of the start, never a second implementation of it;
 * - **a refusal streams as a refusal**, its status in the last event, and the client's reader
 *   throws the server's reason exactly as the plain path does;
 * - a restart of the same sources is told as a **reuse** of the pin, since it uploads nothing.
 *
 * Node-only: a stubbed network and Irys, a throwaway `LATH_TRACE_DIR` and home, a clock held still
 * so two starts mint the same loop id, and a `start` that records nothing — no clock is armed and
 * no sandbox is spawned.
 */

const OWNER = "So11111111111111111111111111111111111111112";
const AGENT = "ef".repeat(32);
const SPEC = { kind: "url" as const, url: "https://docs.example.org/spec.md" };
const NOW = 1_790_000_000_000;

const body = {
  agentId: AGENT,
  prompt: "read the sources and report what changed",
  intervalMs: 15_000,
  maxSteps: 3,
  budgetMicroUsdcPerStep: "50000",
  model: "deepseek/deepseek-v4.1-flash",
  sandbox: { sources: [SPEC] },
};

const PLATFORM = process.platform === "darwin" ? "darwin" : "linux";
const binary: ZeroClawBinary = {
  path: "/nonexistent/zeroclaw",
  sha256: "11".repeat(32),
  patchSet: "stub-patchset",
  version: "zeroclaw 0.0.0-stub (lath) patchset=stub-patchset",
  platform: PLATFORM,
  wrapper: wrapperKind(PLATFORM),
  wrapperPath: PLATFORM === "darwin" ? "/usr/bin/sandbox-exec" : "/usr/bin/bwrap",
  libs: [],
};

function clearStore(): void {
  for (const f of ["loops.json", "templates.json", "agents.json", "market.json"]) {
    fs.rmSync(path.join(traceDir, f), { force: true });
  }
}

function deploy(): void {
  recordAgent(AGENT, {
    name: "stage-watcher",
    authority: "AuThOrItY1111111111111111111111111111111111",
    owner: OWNER,
    createdAt: NOW,
    policy: { model: "deepseek/deepseek-v4.1-flash", tools: [], budgetCapUsdc: "1.00", expirationDays: 14 },
  });
}

/** One public markdown file and one private name; nothing opens a socket. */
function stubNet(): SourcesDeps {
  const names: Record<string, string[]> = {
    "docs.example.org": ["93.184.216.34"],
    "intranet.example.org": ["10.0.0.5"],
  };
  return {
    lookup: async (host) => {
      const a = names[host];
      if (!a) throw new Error("ENOTFOUND");
      return a.map((address) => ({ address, family: 4 }));
    },
    fetch: async (req): Promise<TransportResponse> => {
      const ok = req.url.toString() === SPEC.url;
      return {
        status: ok ? 200 : 404,
        headers: ok ? { "content-type": "text/markdown" } : {},
        body: (async function* () {
          if (ok) yield new TextEncoder().encode("# spec\nthe program owns one vault\n");
        })(),
        cancel: () => undefined,
      };
    },
    rpc: { devnet: "https://devnet.rpc.test/", mainnet: "" },
    now: () => 1_000_000,
  };
}

/** Irys and the locator cell as one in-memory map, as `console-sandbox.ts` stubs them. */
function stubIrys() {
  const cells = new Map<string, Locator>();
  let n = 0;
  const uploader: SourcesUploader = {
    async upload(bytes) {
      n++;
      return sha256(bytes, utf8(`#${n}`));
    },
  };
  const cell = (_deployed: unknown, agentId: string): SourcesCell => ({
    async read(key) {
      return cells.get(`${agentId}:${hex(key)}`) ?? null;
    },
    async write(key, locator) {
      cells.set(`${agentId}:${hex(key)}`, locator);
    },
  });
  return { uploader, cell, gateway: "https://gateway.irys.test", network: "devnet" as const };
}

describe("console loop start stream: a start told as it goes", () => {
  let home = "";
  let realNow: () => number;
  beforeEach(() => {
    clearStore();
    deploy();
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zc-stream-")));
    // Held still, so two starts of the same terms mint the same loop id and the same record.
    realNow = Date.now;
    Date.now = () => NOW;
  });
  afterEach(() => {
    Date.now = realNow;
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** The route's options, with every outside dependency stubbed and a `start` that arms nothing. */
  function options(caller: string, irys = stubIrys(), deps = stubNet()): LoopStartOptions {
    return {
      caller,
      view: (l: LoopRecord) => publicLoop(l),
      hooks: {
        sourcesDeps: deps,
        zeroclawHome: home,
        readiness: () => ({ ok: true as const, binary, home }),
        sourcesStore: new MemoryTraceStore(),
        irys,
      },
      start: () => undefined,
    };
  }

  /** The streamed answer, read back as the browser reads it: every event, in order. */
  async function streamed(run: Parameters<typeof streamLoopStart>[0]) {
    const res = streamLoopStart(run);
    assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
    const text = await res.text();
    const events: { event: string; data: unknown }[] = [];
    await readSseEvents(new Response(text).body!, (event, data) => events.push({ event, data }));
    return { text, events, res };
  }

  const sse = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } });

  it("streams the stages in order and ends on exactly the plain answer", async () => {
    const plain = await answerLoopStart(body, OWNER, options("plain"));
    assert.equal(plain.status, 200, JSON.stringify(plain.body));

    // The same start again, from a clean slate: same store, same home, same clock.
    clearStore();
    deploy();
    fs.rmSync(path.join(home, "loops"), { recursive: true, force: true });
    const opts = options("streamed");
    const { text, events } = await streamed((onStage) => answerLoopStart(body, OWNER, { ...opts, onStage }));

    assert.deepEqual(
      events.filter((e) => e.event === "stage").map((e) => e.data),
      [
        { stage: "checking" },
        { stage: "fetching sources", sources: 1, restoring: false },
        { stage: "pinning on Irys", files: 1 },
        { stage: "starting" },
      ] satisfies LoopStartStage[]
    );
    assert.equal(events.length, 5, "four stages and one result");
    assert.equal(events[4].event, "result", "the result is the last event");
    assert.deepEqual(events[4].data, plain, "the last event is the plain answer, status and body");

    // And the client's reader hands back the plain body, telling each stage on the way.
    const told: string[] = [];
    const read = await readLoopStart(sse(text), (s) => told.push(loopStartStageLabel(s)));
    assert.deepEqual(read, plain.body);
    assert.deepEqual(told, ["Checking…", "Fetching the source…", "Pinning 1 file on Irys…", "Starting…"]);
  });

  it("tells a restart of the same sources as a reuse of the pin", async () => {
    const irys = stubIrys();
    const first = await answerLoopStart(body, OWNER, options("first", irys));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    clearStore();
    deploy();
    fs.rmSync(path.join(home, "loops"), { recursive: true, force: true });
    const opts = options("again", irys);
    const { events } = await streamed((onStage) => answerLoopStart(body, OWNER, { ...opts, onStage }));
    assert.deepEqual(
      events.filter((e) => e.event === "stage").map((e) => (e.data as LoopStartStage).stage),
      ["checking", "fetching sources", "reusing Irys pin", "starting"]
    );
    assert.equal((events.at(-1)!.data as LoopStartAnswer).status, 200);
  });

  it("streams a refused start as the refusal, and the reader throws its reason", async () => {
    const refusing = {
      ...body,
      sandbox: { sources: [SPEC, { kind: "url", url: "https://intranet.example.org/a.md" }] },
    };
    const plain = await answerLoopStart(refusing, OWNER, options("refused-plain"));
    assert.equal(plain.status, 400);
    assert.match((plain.body as { error: string }).error, /^source 2: .*10\.0\.0\.5, a private address/);

    const opts = options("refused-stream");
    const { text, events, res } = await streamed((onStage) => answerLoopStart(refusing, OWNER, { ...opts, onStage }));
    assert.equal(res.status, 200, "the headers go before the refusal is known; its status is in the last event");
    assert.deepEqual(
      events.map((e) => e.event),
      ["stage", "stage", "result"]
    );
    assert.deepEqual(
      events.slice(0, 2).map((e) => (e.data as LoopStartStage).stage),
      ["checking", "fetching sources"],
      "no pin and no start after a source refuses"
    );
    assert.deepEqual(events[2].data, plain);

    let thrown: unknown;
    await readLoopStart(sse(text)).catch((e) => (thrown = e));
    assert.instanceOf(thrown, Error);
    assert.equal((thrown as Error).message, (plain.body as { error: string }).error);
  });

  it("streams a refusal at the check with no stage after it, and one for another wallet's agent", async () => {
    const opts = options("stranger");
    const stranger = "Stranger111111111111111111111111111111111111";
    const { events } = await streamed((onStage) => answerLoopStart(body, stranger, { ...opts, onStage }));
    assert.deepEqual(
      events.map((e) => e.event),
      ["stage", "result"]
    );
    assert.deepEqual(events[1].data, {
      status: 403,
      body: { error: "this agent belongs to another wallet" },
    });
  });

  it("ends a start that throws on a 500 carrying the reason, so the button is never left waiting", async () => {
    const { events } = await streamed(async (onStage) => {
      onStage({ stage: "checking" });
      throw new Error("the disk is full");
    });
    assert.deepEqual(events.at(-1), {
      event: "result",
      data: { status: 500, body: { error: "the disk is full" } },
    });
  });

  it("reads a plain JSON answer as it always did, and a cut stream as a start that may have gone through", async () => {
    const plain = new Response(JSON.stringify({ error: "a wallet signature is required to run a loop: x" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    let thrown: unknown;
    await readLoopStart(plain, () => assert.fail("no stage on a plain answer")).catch((e) => (thrown = e));
    assert.equal((thrown as Error).message, "a wallet signature is required to run a loop: x");

    thrown = undefined;
    await readLoopStart(sse(`event: stage\ndata: {"stage":"checking"}\n\n`)).catch((e) => (thrown = e));
    assert.match((thrown as Error).message, /closed before the start answered; it may still have started/);
  });

  it("asks for the stream only on the Accept header, and names each stage on the button", () => {
    const req = (accept: string | null) => ({ headers: { get: (n: string) => (n === "accept" ? accept : null) } });
    assert.isTrue(wantsStartStream(req("text/event-stream")));
    assert.isTrue(wantsStartStream(req("application/json, text/event-stream;q=0.9")));
    assert.isFalse(wantsStartStream(req(null)));
    assert.isFalse(wantsStartStream(req("*/*")));
    assert.equal(
      loopStartStageLabel({ stage: "fetching sources", sources: 3, restoring: false }),
      "Fetching 3 sources…"
    );
    assert.equal(
      loopStartStageLabel({ stage: "fetching sources", sources: 1, restoring: true }),
      "Restoring the sources from Irys…"
    );
    assert.equal(loopStartStageLabel({ stage: "pinning on Irys", files: 55 }), "Pinning 55 files on Irys…");
    assert.equal(loopStartStageLabel({ stage: "reusing Irys pin" }), "Reusing the Irys pin…");
  });
});
