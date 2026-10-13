import { traceDir } from "./fixtures/trace-dir";
import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import {
  hex,
  idFromString,
  decodeIrysId,
  irysIdString,
  LocatorScheme,
  MemoryTraceStore,
  sha256,
  utf8,
  type Locator,
} from "@lath/sdk";
import { decodeSourcesIrysIndex, sourcesIrysKey } from "../runtime/src/zeroclaw/sources";
import type { LocateSourcesIndex, SourcesGateway, SourcesUploader } from "../frontend/src/app/api/_lib/sources-irys";
import { sourcesHash, sourcesManifestBytes, type SourcesManifest } from "../runtime/src";
import { type ZeroClawBinary } from "../runtime/src/zeroclaw/runtime";
import { WORKSPACE_MAX_BYTES, WORKSPACE_MAX_FILES } from "../runtime/src/zeroclaw/workspace";
import { wrapperKind } from "../runtime/src/zeroclaw/posture";
import {
  LoopRecord,
  LoopRefused,
  SOURCE_CHECKS_PER_HOUR,
  checkLoopStart,
  checkLoopSources,
  checkSourcesAction,
  type SourcesCell,
  checkedIndexProblem,
  sandboxWorkspace,
  fetchedSourcesDir,
  loopSources,
  planLoopStart,
  planPreparedStart,
  prepareLoopStart,
  publicLoop,
  readLoop,
  sandboxNarrowed,
  zeroclawStepRecord,
} from "../frontend/src/app/api/_lib/loops";
import { LoopTemplateConfig, lookupTemplate, templateHash } from "../frontend/src/app/api/_lib/templates";
import { checkLoopConfig } from "../frontend/src/app/api/templates/validate";
import { recordAgent } from "../frontend/src/app/api/_lib/runner";
import { CHAIN_TOOL_NAMES } from "../frontend/src/app/api/_lib/tools";
import { SourcesRefused, type SourcesDeps } from "../frontend/src/app/api/_lib/sources";
import type { TransportResponse } from "../frontend/src/app/api/_lib/safe-fetch";
import type { LoopStepSummary } from "../frontend/src/types/loop";

/**
 * The server half of a loop's sandbox (docs/ARCHITECTURE.md §5): the start's `sandbox`
 * key, the fetch at start, the record, the step's reading of it back, and _Check sources_.
 *
 * What is pinned, each a thing a later change could break silently:
 *
 * - **no sandbox is today's start**, byte for byte: the record, the template hash and every policy
 *   hash a start without `sandbox` produced before sandboxes had a config — and a `sandbox` that spells out
 *   only the host's defaults is the same start;
 * - **a refused source refuses the start with nothing registered** and no directory left behind;
 * - **every sandbox of the loop gets the same sources**: the member's policy is hashed with the manifest
 *   its sandbox is given, the runtime refuses the pair when they disagree, and session A and the
 *   synthesis share one runtime and so one manifest;
 * - **the switches narrow, never widen**: the store switch is refused on an agent deployed without
 *   the store, and a workspace cap above the host's is refused;
 * - **a lowered workspace cap is applied, not only shown**: the record keeps it, every sandbox's
 *   posture commits it (members' included, through the policy the orchestrator names), and a cap
 *   equal to the host's is dropped so it hashes as no sandbox;
 * - **the sandbox is on the public view and survives a template round trip**, so _Run again_ and a
 *   `PUT` of the version carry it;
 * - **a restart re-fetches nothing**: a loop whose fetched directory is gone refuses its step;
 * - **`check-sources` is rate-limited** per caller, and answers a refusal as `ok: false`.
 *
 * Node-only: a stubbed network, a throwaway `LATH_TRACE_DIR` and `LATH_ZEROCLAW_HOME`, a fake
 * chain, and a binary record that is never spawned.
 */

const OWNER = "So11111111111111111111111111111111111111112";
const AGENT = "ab".repeat(32);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const body = {
  agentId: AGENT,
  prompt: "read the sources and report what changed",
  intervalMs: 15_000,
  maxSteps: 3,
  budgetMicroUsdcPerStep: "50000",
  model: "deepseek/deepseek-v4.1-flash",
};
const terms = { model: "deepseek/deepseek-v4.1-flash", budgetMicroUsdcPerTask: "20000" };

function clearStore(): void {
  for (const f of ["loops.json", "templates.json", "agents.json", "market.json"]) {
    fs.rmSync(path.join(traceDir, f), { force: true });
  }
}

function deploy(id: string, name: string, tools: string[] = []): string {
  recordAgent(id, {
    name,
    authority: "AuThOrItY1111111111111111111111111111111111",
    owner: OWNER,
    createdAt: Date.now(),
    policy: { model: "deepseek/deepseek-v4.1-flash", tools, budgetCapUsdc: "1.00", expirationDays: 14 },
  });
  return id;
}

function planned(p: ReturnType<typeof planLoopStart>): LoopRecord {
  if ("error" in p) throw new Error(`refused: ${p.error}`);
  return p.loop;
}

/** A network that serves one markdown file and resolves one private name; nothing opens a socket. */
function stubNet(): { deps: SourcesDeps; hits: string[] } {
  const hits: string[] = [];
  const names: Record<string, string[]> = {
    "docs.example.org": ["93.184.216.34"],
    "intranet.example.org": ["10.0.0.5"],
  };
  const deps: SourcesDeps = {
    lookup: async (host) => {
      const a = names[host];
      if (!a) throw new Error("ENOTFOUND");
      return a.map((address) => ({ address, family: 4 }));
    },
    fetch: async (req): Promise<TransportResponse> => {
      hits.push(req.url.toString());
      const ok = req.url.toString() === "https://docs.example.org/spec.md";
      const chunks = ok ? [new TextEncoder().encode("# spec\nthe program owns one vault\n")] : [];
      return {
        status: ok ? 200 : 404,
        headers: ok ? { "content-type": "text/markdown" } : {},
        body: (async function* () {
          for (const c of chunks) yield c;
        })(),
        cancel: () => undefined,
      };
    },
    rpc: { devnet: "https://devnet.rpc.test/", mainnet: "" },
    now: () => 1_000_000,
  };
  return { deps, hits };
}

const SPEC = { kind: "url" as const, url: "https://docs.example.org/spec.md" };

/** The binary record a sandbox is built from; never spawned here, so its path need not exist. */
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

/** A manifest as `fetchSources` would write it for `SPEC`, and its files laid out under `dir`. */
function manifestAt(dir: string): SourcesManifest {
  const bytes = utf8("# spec\n");
  // A URL's file sits in a directory of its own name (`sourceDir`), so two URLs of a host never share one.
  fs.mkdirSync(path.join(dir, "url", "docs.example.org", "spec.md"), { recursive: true });
  fs.writeFileSync(path.join(dir, "url", "docs.example.org", "spec.md", "spec.md"), bytes);
  return {
    v: 1,
    sources: [
      {
        source: { kind: "url", input: SPEC.url, finalUrl: SPEC.url, contentType: "text/markdown" },
        dir: "url/docs.example.org/spec.md",
        files: [{ path: "url/docs.example.org/spec.md/spec.md", size: bytes.length, sha256: hex(sha256(bytes)) }],
      },
    ],
  };
}

// ─── A repo too large for a step's message (the index budget) ────────────────

function tarHeader(name: string, type: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

/** A codeload tarball of `count` small text files, each well under every per-file and per-source cap. */
function manyFiles(count: number): Uint8Array {
  const top = `r-${COMMIT}`;
  const parts: Buffer[] = [tarHeader(`${top}/`, "5", 0)];
  for (let i = 0; i < count; i++) {
    const body = Buffer.from(`note ${i}\n`);
    parts.push(tarHeader(`${top}/notes/n${String(i).padStart(4, "0")}.md`, "0", body.length));
    parts.push(Buffer.concat([body, Buffer.alloc(512 - body.length)]));
  }
  parts.push(Buffer.alloc(1024));
  return new Uint8Array(zlib.gzipSync(Buffer.concat(parts)));
}

/** `github.com/o/r` at `COMMIT`, served as smart HTTP refs and a codeload tarball; nothing opens a socket. */
function stubRepo(gz: Uint8Array): { deps: SourcesDeps; hits: string[] } {
  const pkt = (line: string) => (line.length + 4).toString(16).padStart(4, "0") + line;
  const refs = Buffer.from(
    `${pkt("# service=git-upload-pack\n")}0000` +
      pkt(`${COMMIT} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`) +
      pkt(`${COMMIT} refs/heads/main\n`) +
      "0000",
    "latin1"
  );
  const routes: Record<string, { type: string; bytes: Uint8Array }> = {
    "https://github.com/o/r.git/info/refs": { type: "application/x-git-upload-pack-advertisement", bytes: refs },
    [`https://codeload.github.com/o/r/tar.gz/${COMMIT}`]: { type: "application/x-gzip", bytes: gz },
  };
  const hits: string[] = [];
  const deps: SourcesDeps = {
    lookup: async () => [{ address: "140.82.112.3", family: 4 }],
    fetch: async (req): Promise<TransportResponse> => {
      const url = req.url.toString();
      hits.push(url);
      const r = routes[url] ?? routes[`${req.url.origin}${req.url.pathname}`];
      return {
        status: r ? 200 : 404,
        headers: r ? { "content-type": r.type } : {},
        body: (async function* () {
          if (r) yield r.bytes;
        })(),
        cancel: () => undefined,
      };
    },
    rpc: { devnet: "https://devnet.rpc.test/", mainnet: "" },
    now: () => 1_000_000,
  };
  return { deps, hits };
}

describe("console sandbox: the loop's sandbox config and sources, server side", () => {
  let home = "";
  beforeEach(() => {
    clearStore();
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zc-sandbox-")));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });
  /** A console that could run a step: the start's fetch asks before it writes into the home. */
  const ready = () => ({ ok: true as const, binary, home });

  describe("no sandbox is today's start", () => {
    it("writes no sandbox key and reuses the template a start without sandbox minted", () => {
      deploy(AGENT, "watcher");
      const before = planned(planLoopStart(body, OWNER));
      assert.notProperty(before, "sandbox");
      // Every spelling of the host's defaults normalises to absent, before anything is hashed.
      for (const sandbox of [
        {},
        { tools: {} },
        { tools: { chain: true } },
        { sources: [] },
        { maxBytes: WORKSPACE_MAX_BYTES, maxFiles: WORKSPACE_MAX_FILES },
      ]) {
        const after = planned(planLoopStart({ ...body, sandbox }, OWNER));
        assert.notProperty(after, "sandbox", JSON.stringify(sandbox));
        assert.deepEqual(after.template, before.template, `${JSON.stringify(sandbox)} links the same template`);
        const config = lookupTemplate(after.template!.id, after.template!.version)!.config as LoopTemplateConfig;
        assert.notProperty(config, "sandbox");
      }
    });
  });

  describe("the start's fetch", () => {
    it("fetches before the plan, stores the files and the manifest, and records the hash", async () => {
      deploy(AGENT, "watcher");
      const { deps } = stubNet();
      const store = new MemoryTraceStore();
      const prepared = await prepareLoopStart({ ...body, sandbox: { sources: [SPEC] } }, OWNER, {
        sourcesDeps: deps,
        zeroclawHome: home,
        readiness: ready,
        sourcesStore: store,
      });
      if ("error" in prepared) throw new Error(prepared.error);
      const fetched = prepared.resolvedSandbox!;
      assert.match(fetched.loopId, /^loop-[0-9a-f]{16}$/);

      const dir = fetchedSourcesDir(fetched.loopId, home);
      const file = path.join(dir, "url", "docs.example.org", "spec.md", "spec.md");
      assert.equal(fs.readFileSync(file, "utf8"), "# spec\nthe program owns one vault\n");
      // The manifest is in the store under its own hash, which is what a step reads it back by.
      const read = await loopSources(
        { id: fetched.loopId, sandbox: { config: {}, sourcesHash: fetched.sourcesHash } },
        home,
        store
      );
      assert.equal(sourcesHash(read!.manifest), fetched.sourcesHash);
      assert.equal(read!.dir, dir);
      // And every file, by the hash the manifest names, for replay to seed step 0 from.
      const f = read!.manifest.sources[0].files[0];
      assert.isNotNull(await store.get(Uint8Array.from(Buffer.from(f.sha256, "hex"))));

      const loop = planned(planLoopStart(prepared, OWNER));
      assert.equal(loop.id, fetched.loopId, "the record is named as the fetched directory is");
      assert.deepEqual(loop.sandbox, { config: { sources: [SPEC] }, sourcesHash: fetched.sourcesHash });
      const config = lookupTemplate(loop.template!.id, loop.template!.version)!.config as LoopTemplateConfig;
      assert.deepEqual(config.sandbox, { sources: [SPEC] }, "the template keeps the inputs, not what they resolved to");
    });

    it("refuses a start whose source refuses, with nothing left in the home", async () => {
      deploy(AGENT, "watcher");
      const { deps } = stubNet();
      const start = {
        ...body,
        sandbox: { sources: [SPEC, { kind: "url", url: "https://intranet.example.org/a.md" }] },
      };
      const refused = await prepareLoopStart(start, OWNER, {
        sourcesDeps: deps,
        zeroclawHome: home,
        readiness: ready,
        sourcesStore: new MemoryTraceStore(),
      });
      assert.deepInclude(refused, { status: 400 });
      assert.match((refused as { error: string }).error, /^source 2: .*10\.0\.0\.5, a private address/);
      // `loops/` is every loop's and stays; nothing of this start is left in it.
      assert.deepEqual(fs.readdirSync(path.join(home, "loops")), [], "no fetched directory is left behind");
    });

    it("drops a fetch a caller wrote into the body, and refuses a plan with sources and no fetch", async () => {
      deploy(AGENT, "watcher");
      const forged = { ...body, resolvedSandbox: { loopId: "loop-0000000000000000", sourcesHash: "00".repeat(32) } };
      const prepared = await prepareLoopStart(forged, OWNER, { zeroclawHome: home });
      assert.notProperty(prepared, "resolvedSandbox");
      assert.deepInclude(planLoopStart({ ...body, sandbox: { sources: [SPEC] } }, OWNER), { status: 409 });
    });

    it("refuses a malformed sandbox before anything is fetched", async () => {
      deploy(AGENT, "watcher");
      const { deps, hits } = stubNet();
      for (const [sandbox, why] of [
        ["no", /sandbox must be an object/],
        [{ network: true }, /sandbox has no network/],
        [{ tools: { files: false } }, /switches chain and store only, not files/],
        [{ tools: { chain: "off" } }, /sandbox.tools.chain is on or off/],
        [{ maxBytes: WORKSPACE_MAX_BYTES + 1 }, /never raise it/],
        [{ maxFiles: WORKSPACE_MAX_FILES + 1 }, /never raise it/],
        [{ maxFiles: 0 }, /sandbox.maxFiles must be a positive whole number/],
        [{ sources: Array.from({ length: 9 }, () => SPEC) }, /at most 8 sources/],
        [{ sources: [{ kind: "ftp", url: "x" }] }, /source 1: is not a GitHub repo/],
      ] as const) {
        const refused = await prepareLoopStart({ ...body, sandbox }, OWNER, { sourcesDeps: deps, zeroclawHome: home });
        assert.deepInclude(refused, { status: 400 }, JSON.stringify(sandbox));
        assert.match((refused as { error: string }).error, why);
      }
      assert.deepEqual(hits, [], "a sandbox refused on its shape fetches nothing");
    });
  });

  describe("the switches narrow and never widen", () => {
    it("refuses the store switch on an agent deployed without the store", () => {
      deploy(AGENT, "watcher");
      const refused = checkLoopStart({ ...body, sandbox: { tools: { store: true } } }, OWNER);
      assert.deepInclude(refused, { status: 400 });
      assert.match((refused as { error: string }).error, /watcher was deployed without the store tools/);
    });

    it("keeps the store on an agent deployed with it, and takes it or the chain reads away when switched off", () => {
      deploy(AGENT, "keeper", ["solana.slot", "store.get", "store.set"]);
      assert.notProperty(checkLoopStart({ ...body, sandbox: { tools: { store: true } } }, OWNER), "error");
      const all = ["solana.slot", "store.get", "store.set"];
      assert.deepEqual(sandboxNarrowed(all, { store: false }), ["solana.slot"]);
      assert.deepEqual(sandboxNarrowed(all, { chain: false }), ["store.get", "store.set"]);
      assert.deepEqual(sandboxNarrowed(all, { store: true }), all, "on is not a widening: nothing is added");
    });
  });

  describe("every sandbox of the loop gets the same sources", () => {
    it("reads a lowered cap off the sandbox config, and the host's cap restated is no cap", () => {
      // A team member's policy is hashed with the loop's sources and cap and held to its sandbox's
      // posture; this build runs no member, and the loop's own agent is held to the same posture by
      // `runnerBaseFor`.
      const cap = sandboxWorkspace({ maxBytes: 1024 * 1024, maxFiles: 100 })!;
      assert.deepEqual(cap, { maxBytes: 1024 * 1024, maxFiles: 100 });
      assert.isUndefined(sandboxWorkspace({ maxBytes: WORKSPACE_MAX_BYTES, maxFiles: WORKSPACE_MAX_FILES }));
      assert.isUndefined(sandboxWorkspace({ sources: [SPEC] }));
      assert.isUndefined(sandboxWorkspace(undefined));
      assert.deepEqual(sandboxWorkspace({ maxBytes: WORKSPACE_MAX_BYTES, maxFiles: 10 }), { maxFiles: 10 });
      assert.deepEqual(sandboxNarrowed(CHAIN_TOOL_NAMES, undefined), CHAIN_TOOL_NAMES);
    });

    it("carries the sources on every step record, session A's and a member's", () => {
      const dir = path.join(home, "sources.fetched");
      const manifest = manifestAt(dir);
      const report = {
        wrapper: "sandbox-exec",
        platform: "darwin",
        binarySha256: binary.sha256,
        postureHash: "22".repeat(32),
        postureJson: "{}",
        policyDocument: "{}",
        actions: [],
        sources: { hash: sourcesHash(manifest), manifest },
      } as unknown as Parameters<typeof zeroclawStepRecord>[0];
      assert.deepEqual(zeroclawStepRecord(report).sources, { hash: sourcesHash(manifest), manifest });
      const { sources: _s, ...none } = report;
      assert.notProperty(zeroclawStepRecord(none as typeof report), "sources");
    });

    it("keeps every sandbox's four texts off the open list, members' included", () => {
      deploy(AGENT, "watcher");
      const loop = planned(planLoopStart(body, OWNER));
      const sandbox = {
        wrapper: "sandbox-exec",
        platform: "macos",
        binarySha256: binary.sha256,
        postureHash: "22".repeat(32),
        postureJson: "{posture}",
        postureToml: "toml",
        wrapperProfile: "(version 1)",
        policyDocument: "{policy}",
        actions: [],
      };
      const row = {
        step: 1,
        zeroclaw: sandbox,
        members: [{ name: "reader", agentId: "cd".repeat(32), zeroclaw: sandbox }],
      } as unknown as LoopStepSummary;
      const out = publicLoop({ ...loop, history: [row] }).history[0];
      for (const r of [out.zeroclaw!, out.members![0].zeroclaw!]) {
        for (const k of ["postureJson", "postureToml", "wrapperProfile", "policyDocument"]) assert.notProperty(r, k);
        assert.equal(r.postureHash, sandbox.postureHash, "the hashes stay");
      }
    });
  });

  describe("a lowered workspace cap", () => {
    it("starts, records the cap, and links a template that keeps it", () => {
      deploy(AGENT, "watcher");
      const before = planned(planLoopStart(body, OWNER));
      const loop = planned(planLoopStart({ ...body, sandbox: { maxBytes: 2 * 1024 * 1024, maxFiles: 250 } }, OWNER));
      assert.deepEqual(loop.sandbox, { config: { maxBytes: 2 * 1024 * 1024, maxFiles: 250 } }, "no sources, no hash");
      assert.deepEqual(sandboxWorkspace(loop.sandbox!.config), { maxBytes: 2 * 1024 * 1024, maxFiles: 250 });
      assert.notDeepEqual(loop.template, before.template, "another sandbox is another template");
      const config = lookupTemplate(loop.template!.id, loop.template!.version)!.config as LoopTemplateConfig;
      assert.deepEqual(config.sandbox, { maxBytes: 2 * 1024 * 1024, maxFiles: 250 });
      // Only the bound lowered is kept; the other, restated at the host's, drops.
      const one = planned(planLoopStart({ ...body, sandbox: { maxBytes: WORKSPACE_MAX_BYTES, maxFiles: 10 } }, OWNER));
      assert.deepEqual(one.sandbox, { config: { maxFiles: 10 } });
    });
  });

  describe("the sandbox on the public view and through a template", () => {
    it("shows the sandbox a run was started with, and nothing on a run without one", async () => {
      deploy(AGENT, "watcher");
      const plain = planned(planLoopStart(body, OWNER));
      assert.notProperty(publicLoop(plain), "sandbox");
      const sandbox = {
        config: { tools: { chain: false }, maxFiles: 100, sources: [SPEC] },
        sourcesHash: "5e".repeat(32),
      };
      assert.deepEqual(publicLoop({ ...plain, sandbox }).sandbox, sandbox);
    });

    it("round-trips a run's sandbox through a template version: the PUT keeps it and the hash", async () => {
      deploy(AGENT, "watcher");
      const { deps } = stubNet();
      const start = { ...body, sandbox: { tools: { chain: false }, maxFiles: 100, sources: [SPEC] } };
      const prepared = await prepareLoopStart(start, OWNER, {
        sourcesDeps: deps,
        zeroclawHome: home,
        readiness: ready,
        sourcesStore: new MemoryTraceStore(),
      });
      if ("error" in prepared) throw new Error(prepared.error);
      const loop = planned(planLoopStart(prepared, OWNER));
      const version = lookupTemplate(loop.template!.id, loop.template!.version)!;
      assert.deepEqual((version.config as LoopTemplateConfig).sandbox, start.sandbox);
      // What `PUT /api/templates` runs on the stored config: the same bytes back, so the same hash.
      const put = checkLoopConfig(version.config);
      if ("error" in put) throw new Error(put.error);
      assert.deepEqual(put.config.sandbox, start.sandbox);
      assert.equal(templateHash(put.config), version.hash);
      // And the view carries what _Run again_ needs to start the same sandbox, sources as typed
      // included: it is the same for every reader, with the manifest's hash beside it.
      const view = publicLoop(loop).sandbox!;
      assert.deepEqual(view.config, start.sandbox);
      assert.equal(view.sourcesHash, loop.sandbox!.sourcesHash);
    });
  });

  describe("the `room` key, read as `sandbox`", () => {
    const config = { tools: { chain: false }, maxFiles: 100 };

    it("starts a body that says `room` as one that says `sandbox`: same config, same template", () => {
      deploy(AGENT, "watcher");
      const now = planned(planLoopStart({ ...body, sandbox: config }, OWNER));
      const old = planned(planLoopStart({ ...body, room: config }, OWNER));
      assert.deepEqual(old.sandbox, now.sandbox);
      assert.deepEqual(old.template, now.template, "a client that says `room` links the same version");
      assert.notProperty(old, "room");
      const put = checkLoopConfig({
        ...(lookupTemplate(now.template!.id)!.config as object),
        sandbox: undefined,
        room: config,
      });
      if ("error" in put) throw new Error(put.error);
      assert.deepEqual(put.config.sandbox, config);
      assert.notProperty(put.config, "room");
    });

    it("reads a stored loop row and template version under the old key, and keeps the version's hash", () => {
      deploy(AGENT, "watcher");
      const loop = planned(planLoopStart({ ...body, sandbox: config }, OWNER));
      const { sandbox, ...row } = loop;
      fs.writeFileSync(path.join(traceDir, "loops.json"), JSON.stringify({ [loop.id]: { ...row, room: sandbox } }));
      assert.deepEqual(readLoop(loop.id)!.sandbox, sandbox);
      assert.notProperty(readLoop(loop.id)!, "room");

      const file = path.join(traceDir, "templates.json");
      const stored = JSON.parse(fs.readFileSync(file, "utf8"));
      const version = stored[loop.template!.id].find((t: { version: number }) => t.version === loop.template!.version);
      const { sandbox: kept, ...rest } = version.config;
      version.config = { ...rest, room: kept };
      fs.writeFileSync(file, JSON.stringify(stored));
      const read = lookupTemplate(loop.template!.id, loop.template!.version)!;
      assert.deepEqual((read.config as LoopTemplateConfig).sandbox, config);
      assert.notProperty(read.config, "room");
      assert.equal(read.hash, loop.template!.hash, "the hash is the one the version was written with");
    });
  });

  describe("a restart re-fetches nothing", () => {
    it("refuses the step of a loop whose fetched directory is gone, and one whose manifest cannot be read", async () => {
      const dir = fetchedSourcesDir("loop-restart", home);
      const manifest = manifestAt(dir);
      const store = new MemoryTraceStore();
      await store.put(sourcesManifestBytes(manifest));
      const loop = { id: "loop-restart", sandbox: { config: {}, sourcesHash: sourcesHash(manifest) } };
      assert.equal((await loopSources(loop, home, store))!.dir, dir);
      assert.isUndefined(await loopSources({ id: "loop-none", sandbox: { config: {} } }, home, store));

      let refused: unknown;
      try {
        await loopSources(loop, home, new MemoryTraceStore());
      } catch (e) {
        refused = e;
      }
      assert.instanceOf(refused, LoopRefused);
      assert.match((refused as Error).message, /cannot be read back from its trace store/);

      fs.rmSync(dir, { recursive: true });
      refused = undefined;
      try {
        await loopSources(loop, home, store);
      } catch (e) {
        refused = e;
      }
      assert.instanceOf(refused, LoopRefused);
      assert.match((refused as Error).message, /that directory is gone; a step is not run on sources fetched again/);
    });
  });

  describe("check-sources", () => {
    it("answers resolved inputs, a refusal as ok: false with its input, and a caller over the limit with 429", async () => {
      const resolved = [
        {
          source: {
            kind: "github" as const,
            input: "https://github.com/o/r",
            owner: "o",
            repo: "r",
            ref: null,
            path: null,
            commit: COMMIT,
          },
          files: 3,
          bytes: 120,
        },
      ];
      const good = await checkSourcesAction([], "caller-good", async () => resolved);
      assert.deepEqual(good, { status: 200, body: { ok: true, resolved } });

      const bad = await checkSourcesAction([], "caller-bad", async () => {
        throw new SourcesRefused("is not public", 2);
      });
      assert.deepEqual(bad, { status: 400, body: { ok: false, error: "source 2: is not public", input: 2 } });

      let last: Awaited<ReturnType<typeof checkSourcesAction>> | undefined;
      for (let i = 0; i <= SOURCE_CHECKS_PER_HOUR; i++) {
        last = await checkSourcesAction([], "caller-busy", async () => resolved);
      }
      assert.equal(last!.status, 429);
      assert.deepInclude(last!.body, { ok: false });
      assert.match((last!.body as { error: string }).error, /rate limit: \d+ source checks per hour/);
      // Another caller has its own bucket.
      assert.equal((await checkSourcesAction([], "caller-other", async () => resolved)).status, 200);
    });
  });
  describe("the start's fetch, held to the console and to its own directory", () => {
    it("refuses a start with sources on a console that could run no step, before a byte is fetched", async () => {
      deploy(AGENT, "watcher");
      const { deps, hits } = stubNet();
      const refused = await prepareLoopStart({ ...body, sandbox: { sources: [SPEC] } }, OWNER, {
        sourcesDeps: deps,
        zeroclawHome: home,
        sourcesStore: new MemoryTraceStore(),
        readiness: () => ({ ok: false, reason: "no Lath-patched zeroclaw on this console" }),
      });
      assert.deepEqual(refused, { error: "no Lath-patched zeroclaw on this console", status: 503 });
      assert.deepEqual(hits, [], "nothing is fetched for a loop whose first step would be refused");
      assert.isFalse(fs.existsSync(path.join(home, "loops")), "nothing is written into the home");
    });

    it("discards the fetch when the plan after it is refused", async () => {
      deploy(AGENT, "watcher");
      const { deps } = stubNet();
      const prepared = await prepareLoopStart({ ...body, sandbox: { sources: [SPEC] } }, OWNER, {
        sourcesDeps: deps,
        zeroclawHome: home,
        sourcesStore: new MemoryTraceStore(),
        readiness: ready,
      });
      if ("error" in prepared) throw new Error(prepared.error);
      assert.isTrue(fs.existsSync(fetchedSourcesDir(prepared.resolvedSandbox!.loopId, home)));
      // The agent gone between the fetch and the plan: a refusal only the plan can make.
      clearStore();
      const refused = planPreparedStart(prepared, OWNER, home);
      assert.property(refused, "error");
      assert.deepEqual(fs.readdirSync(path.join(home, "loops")), [], "the refused plan's fetch is removed");
    });

    it("refuses a second start that mints the same loop id, and leaves the first one's files alone", async () => {
      deploy(AGENT, "watcher");
      const { deps, hits } = stubNet();
      const now = 1_726_000_000_000;
      const loopId = `loop-${hex(idFromString(`${AGENT}:${now}`)).slice(0, 16)}`;
      const theirs = path.join(fetchedSourcesDir(loopId, home), "url", "theirs.md");
      fs.mkdirSync(path.dirname(theirs), { recursive: true });
      fs.writeFileSync(theirs, "the first start's file\n");
      const clock = Date.now;
      Date.now = () => now;
      let refused;
      try {
        refused = await prepareLoopStart({ ...body, sandbox: { sources: [SPEC] } }, OWNER, {
          sourcesDeps: deps,
          zeroclawHome: home,
          sourcesStore: new MemoryTraceStore(),
          readiness: ready,
        });
      } finally {
        Date.now = clock;
      }
      assert.deepInclude(refused, { status: 409 });
      assert.match((refused as { error: string }).error, /another start of this agent is fetching its sources/);
      assert.deepEqual(hits, [], "the second start fetches nothing");
      assert.equal(fs.readFileSync(theirs, "utf8"), "the first start's file\n", "and removes nothing of the first's");
    });

    it("refuses a repo whose index is over a step message's budget, with nothing stored", async () => {
      deploy(AGENT, "watcher");
      const { deps } = stubRepo(manyFiles(1500));
      const store = new MemoryTraceStore();
      const puts: number[] = [];
      const put = store.put.bind(store);
      store.put = async (bytes: Uint8Array) => {
        puts.push(bytes.length);
        return put(bytes);
      };
      const refused = await prepareLoopStart(
        {
          ...body,
          sandbox: { sources: [{ kind: "github", url: "https://github.com/o/r" }] },
        },
        OWNER,
        {
          sourcesDeps: deps,
          zeroclawHome: home,
          sourcesStore: store,
          readiness: ready,
        }
      );
      assert.deepInclude(refused, { status: 400 });
      assert.match((refused as { error: string }).error, /index is .*over the 98304 a step's message can give it/);
      assert.deepEqual(puts, [], "no file and no manifest is stored");
      assert.deepEqual(fs.readdirSync(path.join(home, "loops")), [], "and no directory is left behind");
    });

    it("fetches at most two sets at once, a start's and a check's together, and a start waits rather than failing", async () => {
      // Were only checks bounded, any number of signed starts could each be reading a repo's
      // tarball at once. Three starts here, on three agents, with a network that holds every
      // answer until it is let go.
      const agents = [AGENT, "cd".repeat(32), "ef".repeat(32)];
      agents.forEach((id, i) => deploy(id, `watcher-${i}`));
      const { deps: served } = stubNet();
      let open = 0;
      let most = 0;
      let hits = 0;
      let letGo!: () => void;
      const gate = new Promise<void>((r) => (letGo = r));
      const deps: SourcesDeps = {
        ...served,
        fetch: async (req) => {
          hits++;
          most = Math.max(most, ++open);
          await gate;
          open--;
          return served.fetch(req);
        },
      };
      const store = new MemoryTraceStore();
      const starts = agents.map((agentId) =>
        prepareLoopStart({ ...body, agentId, sandbox: { sources: [SPEC] } }, OWNER, {
          sourcesDeps: deps,
          zeroclawHome: home,
          sourcesStore: store,
          readiness: ready,
        })
      );
      for (let i = 0; i < 200 && hits < 2; i++) await new Promise((r) => setImmediate(r));
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      assert.equal(hits, 2, "the third start waits for one of the first two");
      const busy = await checkSourcesAction([SPEC], "caller-while-starting", async () => []);
      assert.equal(busy.status, 429);
      assert.match((busy.body as { error: string }).error, /already fetching sources/);
      letGo();
      const prepared = await Promise.all(starts);
      for (const p of prepared) if ("error" in p) throw new Error(p.error);
      assert.equal(hits, 3, "and fetches once there is room");
      assert.equal(most, 2);
      // The places are all handed back: a check is let through again.
      assert.equal((await checkSourcesAction([SPEC], "caller-after", async () => [])).status, 200);
    });

    it("refuses a check whose counts alone put the index over its budget", async () => {
      const source = {
        kind: "github" as const,
        input: "https://github.com/o/r",
        owner: "o",
        repo: "r",
        ref: null,
        path: null,
        commit: COMMIT,
      };
      const big = [{ source, files: 1500, bytes: 15_000 }];
      assert.isNull(checkedIndexProblem([{ source, files: 3, bytes: 120 }]));
      const answer = await checkSourcesAction([], "caller-index", async () => big);
      assert.equal(answer.status, 400);
      assert.deepInclude(answer.body, { ok: false });
      assert.match(
        (answer.body as { error: string }).error,
        /^the sources' index would be at least \d+ bytes for 1500 files, over the 98304/
      );
      // A bound, never an overcount: a count whose shortest index fits is let through to the start.
      assert.isNull(checkedIndexProblem([{ source, files: 1000, bytes: 1 }]));
    });
  });

  describe("a store switch that says what the agent was deployed with is no switch", () => {
    it("drops it, so it links the template a start without it linked", () => {
      deploy(AGENT, "keeper", ["solana.slot", "store.get", "store.set"]);
      const plain = planned(planLoopStart(body, OWNER));
      for (const tools of [{ store: true }, { store: true, chain: true }]) {
        const on = checkLoopStart({ ...body, sandbox: { tools } }, OWNER);
        if ("error" in on) throw new Error(on.error);
        assert.notProperty(on.checked, "sandbox", JSON.stringify(tools));
        const loop = planned(planLoopStart({ ...body, sandbox: { tools } }, OWNER));
        assert.notProperty(loop, "sandbox");
        assert.deepEqual(loop.template, plain.template, "no second lineage for the same posture");
      }
      // Off on an agent deployed with the store narrows it, so it stays.
      const off = checkLoopStart({ ...body, sandbox: { tools: { store: false } } }, OWNER);
      if ("error" in off) throw new Error(off.error);
      assert.deepEqual(off.checked.sandbox, { tools: { store: false } });
    });

    it("drops off on an agent deployed without the store, and keeps the rest of the sandbox", () => {
      deploy(AGENT, "watcher");
      const off = checkLoopStart({ ...body, sandbox: { tools: { store: false, chain: false }, maxFiles: 10 } }, OWNER);
      if ("error" in off) throw new Error(off.error);
      assert.deepEqual(off.checked.sandbox, { tools: { chain: false }, maxFiles: 10 });
    });
  });

  describe("sources on Irys: published at start, restored by a second loop", () => {
    /**
     * Irys and the chain, stubbed as one: an uploader that keeps each object under an id derived from
     * its bytes and a counter, a gateway that serves them back, and a locator map keyed by agent and
     * key that both the start's cell and a restore's chain read go through — so what the first start
     * anchors is exactly what the second start finds.
     */
    function stubIrys(opts: { failAt?: number } = {}) {
      const objects = new Map<string, Uint8Array>();
      const tags: { name: string; value: string }[][] = [];
      const cells = new Map<string, Locator>();
      const writes: { agentId: string; key: string; locator: Locator }[] = [];
      let n = 0;
      const uploader: SourcesUploader = {
        async upload(bytes, t) {
          n++;
          if (opts.failAt === n) throw new Error("402 Payment Required: not enough balance at Irys");
          const id = sha256(bytes, utf8(`#${n}`));
          objects.set(hex(id), Uint8Array.from(bytes));
          tags.push(t);
          return id;
        },
      };
      const reader: SourcesGateway = {
        async download(id, max) {
          const b = objects.get(hex(id));
          return b && b.length <= max ? b : null;
        },
      };
      const locate: LocateSourcesIndex = async (agent, key) => cells.get(`${hex(agent)}:${hex(key)}`) ?? null;
      const cell = (_deployed: unknown, agentId: string): SourcesCell => ({
        async read(key) {
          return cells.get(`${agentId}:${hex(key)}`) ?? null;
        },
        async write(key, locator) {
          writes.push({ agentId, key: hex(key), locator });
          cells.set(`${agentId}:${hex(key)}`, locator);
        },
      });
      return {
        objects,
        tags,
        writes,
        uploads: () => n,
        hooks: { uploader, reader, locate, cell, gateway: "https://gateway.irys.test", network: "devnet" as const },
      };
    }

    it("publishes after the fetch, writes one cell under the loop agent, and keeps the index id on the row", async () => {
      deploy(AGENT, "watcher");
      // The same start with no publishing first, in its own home: the hash both must commit.
      const plainHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zc-plain-")));
      let plainHash: string;
      try {
        const plain = await prepareLoopStart({ ...body, sandbox: { sources: [SPEC] } }, OWNER, {
          sourcesDeps: stubNet().deps,
          zeroclawHome: plainHome,
          readiness: ready,
          sourcesStore: new MemoryTraceStore(),
          irys: { uploader: null },
        });
        if ("error" in plain) throw new Error(plain.error);
        assert.notProperty(plain.resolvedSandbox!, "irys", "a console that publishes nothing records nothing");
        plainHash = plain.resolvedSandbox!.sourcesHash;
      } finally {
        fs.rmSync(plainHome, { recursive: true, force: true });
      }

      const irys = stubIrys();
      const prepared = await prepareLoopStart({ ...body, sandbox: { sources: [SPEC] } }, OWNER, {
        sourcesDeps: stubNet().deps,
        zeroclawHome: home,
        readiness: ready,
        sourcesStore: new MemoryTraceStore(),
        irys: irys.hooks,
      });
      if ("error" in prepared) throw new Error(prepared.error);
      const fetched = prepared.resolvedSandbox!;
      // The manifest's bytes do not move: publishing adds an index beside them, never a key in them.
      assert.equal(fetched.sourcesHash, plainHash);

      // One file, the manifest, the index — in that order, the file tagged as the text it is.
      assert.equal(irys.uploads(), 3);
      assert.deepInclude(irys.tags[0], { name: "Content-Type", value: "text/markdown" });
      assert.deepInclude(irys.tags[2], { name: "Lath-Kind", value: "sources.index" });
      const index = fetched.irys!.index;
      const indexBytes = irys.objects.get(hex(decodeIrysId(index)))!;
      assert.deepEqual(decodeSourcesIrysIndex(indexBytes)!.sourcesHash, plainHash);

      // One cell, under the loop agent, at the domain-separated key, naming the index.
      assert.lengthOf(irys.writes, 1);
      assert.equal(irys.writes[0].agentId, AGENT);
      assert.equal(irys.writes[0].key, hex(sourcesIrysKey(plainHash)));
      assert.equal(irys.writes[0].locator.scheme, LocatorScheme.Irys);
      assert.equal(irysIdString(irys.writes[0].locator.id), index);

      const loop = planned(planLoopStart(prepared, OWNER));
      assert.deepEqual(loop.sandbox, {
        config: { sources: [SPEC] },
        sourcesHash: plainHash,
        irys: {
          index,
          manifest: fetched.irys!.manifest,
          uploads: 3,
          bytes: fetched.irys!.bytes,
          network: "devnet",
          gateway: "https://gateway.irys.test",
          cell: { key: hex(sourcesIrysKey(plainHash)), written: true },
        },
      });
      assert.isAbove(loop.sandbox!.irys!.bytes, 0);
      // The template keeps the inputs only; where they were published is the run's, not the terms'.
      const config = lookupTemplate(loop.template!.id, loop.template!.version)!.config as LoopTemplateConfig;
      assert.deepEqual(config.sandbox, { sources: [SPEC] });
    });

    it("refuses the start when an upload fails, before any step, and discards the fetch", async () => {
      deploy(AGENT, "watcher");
      const irys = stubIrys({ failAt: 2 });
      const refused = await prepareLoopStart(
        {
          ...body,
          sandbox: { sources: [SPEC] },
        },
        OWNER,
        {
          sourcesDeps: stubNet().deps,
          zeroclawHome: home,
          readiness: ready,
          sourcesStore: new MemoryTraceStore(),
          irys: irys.hooks,
        }
      );
      assert.deepInclude(refused, { status: 502 });
      assert.match(
        (refused as { error: string }).error,
        /^the loop's sources could not be published to Irys: sources\.manifest did not upload to Irys: 402 Payment Required/
      );
      assert.lengthOf(irys.writes, 0, "no cell names an index that was never uploaded");
      assert.deepEqual(fs.readdirSync(path.join(home, "loops")), [], "the fetch is discarded");
    });

    it("restores a second loop from the first's sources through its agent's cell, and commits the same hash", async () => {
      deploy(AGENT, "watcher");
      const irys = stubIrys();
      const first = await prepareLoopStart({ ...body, sandbox: { sources: [SPEC] } }, OWNER, {
        sourcesDeps: stubNet().deps,
        zeroclawHome: home,
        readiness: ready,
        sourcesStore: new MemoryTraceStore(),
        irys: irys.hooks,
      });
      if ("error" in first) throw new Error(first.error);
      const hash = first.resolvedSandbox!.sourcesHash;
      const firstDir = fetchedSourcesDir(first.resolvedSandbox!.loopId, home);

      // Another agent, another start: its one source is the first loop's set, by agent and hash.
      const OTHER = "cd".repeat(32);
      deploy(OTHER, "second-watcher");
      const restore = { kind: "irys" as const, agent: AGENT, sourcesHash: hash };
      const { deps, hits } = stubNet();
      const store = new MemoryTraceStore();
      const uploadsBefore = irys.uploads();
      const second = await prepareLoopStart({ ...body, agentId: OTHER, sandbox: { sources: [restore] } }, OWNER, {
        sourcesDeps: deps,
        zeroclawHome: home,
        readiness: ready,
        sourcesStore: store,
        irys: irys.hooks,
      });
      if ("error" in second) throw new Error(second.error);
      const restored = second.resolvedSandbox!;
      assert.equal(restored.sourcesHash, hash, "the posture commits the first loop's sources hash");
      assert.deepEqual(hits, [], "nothing is fetched: every byte came from Irys");
      assert.equal(irys.uploads(), uploadsBefore, "a restore uploads nothing");

      // Laid out where a fetch would be, byte for byte the first loop's files, and the manifest a
      // step reads back is the one that hashes to `hash`.
      const rel = path.join("url", "docs.example.org", "spec.md", "spec.md");
      const dir = fetchedSourcesDir(restored.loopId, home);
      assert.equal(fs.readFileSync(path.join(dir, rel), "utf8"), fs.readFileSync(path.join(firstDir, rel), "utf8"));
      const read = await loopSources({ id: restored.loopId, sandbox: { config: {}, sourcesHash: hash } }, home, store);
      assert.equal(sourcesHash(read!.manifest), hash);

      // The same index, now also named from the second agent.
      assert.lengthOf(irys.writes, 2);
      assert.equal(irys.writes[1].agentId, OTHER);
      assert.equal(irysIdString(irys.writes[1].locator.id), first.resolvedSandbox!.irys!.index);
      const loop = planned(planLoopStart(second, OWNER));
      assert.deepEqual(loop.sandbox!.config, { sources: [restore] });
      assert.deepInclude(loop.sandbox!.irys!, {
        index: first.resolvedSandbox!.irys!.index,
        uploads: 0,
        bytes: 0,
        restored: { agent: AGENT },
      });

      // _Check sources_ does the same reads and keeps nothing: the first loop's pins, and where.
      const checked = await checkLoopSources([restore], deps, { irys: irys.hooks });
      assert.deepEqual(checked, {
        resolved: [
          {
            source: { kind: "url", input: SPEC.url, finalUrl: SPEC.url, contentType: "text/markdown" },
            files: 1,
            bytes: "# spec\nthe program owns one vault\n".length,
          },
        ],
        restored: { index: first.resolvedSandbox!.irys!.index, sourcesHash: hash, agent: AGENT },
      });
    });

    it("refuses a restore that names the wrong hash, a flipped byte, or a list with anything beside it", async () => {
      deploy(AGENT, "watcher");
      const irys = stubIrys();
      const first = await prepareLoopStart({ ...body, sandbox: { sources: [SPEC] } }, OWNER, {
        sourcesDeps: stubNet().deps,
        zeroclawHome: home,
        readiness: ready,
        sourcesStore: new MemoryTraceStore(),
        irys: irys.hooks,
      });
      if ("error" in first) throw new Error(first.error);
      const hash = first.resolvedSandbox!.sourcesHash;
      const OTHER = "cd".repeat(32);
      deploy(OTHER, "second-watcher");
      const start = (sources: unknown[]) =>
        prepareLoopStart({ ...body, agentId: OTHER, sandbox: { sources } }, OWNER, {
          sourcesDeps: stubNet().deps,
          zeroclawHome: home,
          readiness: ready,
          sourcesStore: new MemoryTraceStore(),
          irys: irys.hooks,
        });

      const wrong = await start([{ kind: "irys", agent: AGENT, sourcesHash: "00".repeat(32) }]);
      assert.deepInclude(wrong, { status: 400 });
      assert.match((wrong as { error: string }).error, /has anchored no Irys index for these sources/);

      const beside = await start([{ kind: "irys", agent: AGENT, sourcesHash: hash }, SPEC]);
      assert.deepInclude(beside, { status: 400 });
      assert.match((beside as { error: string }).error, /the loop's only source/);

      // One byte of the file flipped on Irys: refused with the file named, nothing left in the home.
      const index = decodeSourcesIrysIndex(irys.objects.get(hex(decodeIrysId(first.resolvedSandbox!.irys!.index)))!)!;
      const fileId = hex(decodeIrysId(Object.values(index.files)[0]));
      const bytes = irys.objects.get(fileId)!;
      bytes[0] ^= 1;
      const before = fs.readdirSync(path.join(home, "loops")).length;
      const flipped = await start([{ kind: "irys", agent: AGENT, sourcesHash: hash }]);
      assert.deepInclude(flipped, { status: 400 });
      assert.match(
        (flipped as { error: string }).error,
        /sources\/url\/docs\.example\.org\/spec\.md\/spec\.md .* does not re-hash/
      );
      assert.lengthOf(fs.readdirSync(path.join(home, "loops")), before, "the refused restore leaves nothing");
    });
  });
});
