import {
  lathPosture,
  lddLibs,
  sandboxPaths,
  socketPathOk,
  spawnSpec,
  stepEnv,
  type HostSandbox,
  type LathPosture,
} from "@lath/runtime/zeroclaw/posture";
import { assert } from "chai";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

/**
 * The air gap's acceptance test under the **generated** wrapper (docs/ARCHITECTURE.md §5).
 * `zeroclaw/probe/airgap.sh` proves hand-written profiles; this runs the same
 * std-only probe (`zeroclaw/probe/airgap-probe.rs`) under exactly what `spawnSpec` gives the host
 * for a step — the `sandbox-exec` profile on macOS, the `bwrap` arguments on Linux, the step's
 * environment — and holds it to the same expectations: every forbidden reach denied, the workspace,
 * the data directory and the two sockets reached, the environment exactly the step's. An unwrapped
 * control run must reach what the wrapped run is denied, so a pass is never vacuous. It runs both
 * shapes of the sandbox the product runs: a posture without sources, whose wrapper has no
 * sources rule, and one with sources, whose `sources/` must read and refuse a write — as
 * `airgap.sh` does with `SOURCES=0` and `SOURCES=1`.
 *
 * It needs `rustc` and the platform's wrapper, and skips, saying which is missing, without them.
 * With `LATH_AIRGAP_REQUIRED=1` (CI's air-gap jobs) a missing piece is a failure instead: a job
 * whose purpose is this proof must not go green by skipping it.
 */

const REPO = path.join(__dirname, "..");
const PROBE_SRC = path.join(REPO, "zeroclaw", "probe", "airgap-probe.rs");
const NOW = "2026-09-24T10:00:00Z";

type Outcome = { outcome: "reached" | "denied"; detail: string };

/** The probe's lines, `<name>:<target>\t<reached|denied>\t<detail>`, keyed by `<name>:<target>`. */
function parseProbe(out: string): Map<string, Outcome> {
  const m = new Map<string, Outcome>();
  for (const line of out.split("\n")) {
    const [key, outcome, detail = ""] = line.split("\t");
    if (outcome === "reached" || outcome === "denied") m.set(key, { outcome, detail });
  }
  return m;
}

function run(file: string, args: string[], opts: { env: Record<string, string>; cwd: string }) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    // Async, not spawnSync: the listeners the probe connects to live in this process, and a
    // blocked event loop would leave the allowed sockets connected but unanswered.
    const child = spawn(file, args, { env: opts.env, cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

function onPath(cmd: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = path.join(dir, cmd);
    if (dir && fs.existsSync(p)) return p;
  }
  return undefined;
}

/** A listener that answers any first message with `pong\n`, as airgap.sh's helper does. */
function listen(target: string | { host: string; port: number }): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((c) => {
      c.on("error", () => {});
      c.once("data", () => c.end("pong\n"));
    });
    server.once("error", reject);
    if (typeof target === "string") server.listen(target, () => resolve(server));
    else server.listen(target.port, target.host, () => resolve(server));
  });
}

function firstFile(dir: string): string | undefined {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile()) return p;
    if (e.isDirectory()) {
      const f = firstFile(p);
      if (f) return f;
    }
  }
  return undefined;
}

describe("zeroclaw air gap: the probe under the generated wrapper", function () {
  this.timeout(240_000);

  let root = "";
  const servers: net.Server[] = [];
  let posture: LathPosture;
  let host: HostSandbox;
  let inside: HostSandbox;
  let probe = "";
  let port = 0;
  let keypair = "";
  let traceFile = "";
  let control = new Map<string, Outcome>();
  let wrapped = new Map<string, Outcome>();
  let wrappedRaw = "";
  let expectedEnv = "";
  let noSourcesRule = false;
  // The same sandbox under a posture with sources: the wrapper gains one rule.
  let sourced = new Map<string, Outcome>();
  let sourcedInside: HostSandbox;

  before(async function () {
    const platform = process.platform;
    const why = (() => {
      if (platform !== "darwin" && platform !== "linux") return `no wrapper on ${platform}`;
      if (spawnSync("rustc", ["--version"]).status !== 0) return "no rustc to build the probe";
      if (platform === "darwin" && !fs.existsSync("/usr/bin/sandbox-exec")) return "no /usr/bin/sandbox-exec";
      if (platform === "linux") {
        const bwrap = onPath("bwrap");
        if (!bwrap) return "no bwrap on PATH";
        // A host that restricts unprivileged user namespaces (Ubuntu 24.04's AppArmor default)
        // cannot run the wrapper at all; the product refuses a loop there, and so does this.
        const t = spawnSync(bwrap, ["--unshare-all", "--ro-bind", "/", "/", "true"]);
        const err = String(t.stderr).trim();
        if (t.status !== 0)
          return `bwrap cannot make namespaces (${err}); see kernel.apparmor_restrict_unprivileged_userns`;
      }
      return undefined;
    })();
    if (why) {
      if (process.env.LATH_AIRGAP_REQUIRED === "1") throw new Error(`the air gap was required and cannot run: ${why}`);
      console.log(`      skipped: ${why}`);
      this.skip();
    }

    // Short on purpose, and resolved: a socket path is at most 103 bytes to the Rust client on macOS
    // (`socketPathOk`), and Seatbelt matches the resolved path (`/tmp` is `/private/tmp`).
    root = fs.realpathSync(fs.mkdtempSync("/tmp/lzc."));
    const step = path.join(root, "step");
    for (const d of ["bin", "work", "outside", path.join("step", "cfg", "data")]) {
      fs.mkdirSync(path.join(root, d), { recursive: true });
    }
    fs.writeFileSync(path.join(root, "outside", "secret.txt"), "outside the sandbox\n");
    fs.writeFileSync(path.join(root, "work", "note.txt"), "inside the sandbox\n");
    // Writable on disk on purpose: what must refuse the write below is the wrapper's rule, not a mode.
    fs.mkdirSync(path.join(root, "work", "sources"));
    fs.writeFileSync(path.join(root, "work", "sources", "src.txt"), "a source\n");

    probe = path.join(root, "bin", "airgap-probe");
    // The build is the host's, outside any sandbox, so it gets the host's environment: rustup finds
    // its toolchain through `RUSTUP_HOME` / `CARGO_HOME` where those are set (the rust images).
    const rustc = await run("rustc", ["-O", "--edition", "2021", "-o", probe, PROBE_SRC], {
      env: process.env as Record<string, string>,
      cwd: root,
    });
    assert.equal(rustc.code, 0, `rustc failed: ${rustc.stderr}`);

    // The sandbox as the host lays it out for a step: the loop's workspace, the step's fresh
    // config directory with its data dir, and the two sockets in the step's directory.
    host = {
      binary: probe,
      workspace: path.join(root, "work"),
      configDir: path.join(step, "cfg"),
      modelSocket: path.join(step, "m.sock"),
      toolsSocket: path.join(step, "t.sock"),
    };
    for (const s of [host.modelSocket, host.toolsSocket]) assert.isTrue(socketPathOk(s, platform), s);
    const otherSock = path.join(root, "other.sock");
    for (const s of [host.modelSocket, host.toolsSocket, otherSock]) servers.push(await listen(s));
    // A loopback TCP listener stands in for every host port: the Next server, a local RPC, the
    // proxy's old TCP port.
    const tcp = await listen({ host: "127.0.0.1", port: 0 });
    servers.push(tcp);
    port = (tcp.address() as net.AddressInfo).port;

    // The operator's keypair and the trace directory, or stand-ins when this machine has neither.
    keypair = path.join(os.homedir(), ".config", "solana", "id.json");
    if (!fs.existsSync(keypair)) {
      keypair = path.join(root, "home", ".config", "solana", "id.json");
      fs.mkdirSync(path.dirname(keypair), { recursive: true });
      fs.writeFileSync(keypair, "[]");
    }
    const traces = path.join(REPO, "frontend", ".traces-devnet");
    traceFile = (fs.existsSync(traces) && firstFile(traces)) || "";
    if (!traceFile) {
      traceFile = path.join(root, "traces", "blob");
      fs.mkdirSync(path.dirname(traceFile), { recursive: true });
      fs.writeFileSync(traceFile, "x\n");
    }

    // The one posture, generated for this platform, with the probe standing in for the binary.
    posture = lathPosture({
      toolAllowList: ["store.get", "solana.slot"],
      binarySha256: "00".repeat(32),
      patchSet: "airgap-probe",
      platform,
    });
    inside = sandboxPaths(posture, host);
    const probeArgs = (r: HostSandbox) => [
      "tcp=1.1.1.1:443",
      `loopback=127.0.0.1:${port}`,
      "udp=1.1.1.1:53",
      "dns=example.com:443",
      `read=${keypair}`,
      `read=${traceFile}`,
      `read=${path.join(root, "outside", "secret.txt")}`,
      "read=/etc/hosts",
      `write=${path.join(root, "outside", "planted.txt")}`,
      `unix=${otherSock}`,
      "exec=/bin/sh",
      `read=${r.workspace}/note.txt`,
      `write=${r.workspace}/made.txt`,
      `write=${r.configDir}/data/trace.jsonl`,
      `allow=${r.modelSocket}`,
      `allow=${r.toolsSocket}`,
      "env=1",
    ];

    const sourceArgs = (r: HostSandbox) => [
      `read=${r.workspace}/sources/src.txt`,
      `write=${r.workspace}/sources/planted.txt`,
    ];

    // The control: the same probe, unwrapped, with the sandbox's real paths.
    const c = await run(probe, [...probeArgs(host), ...sourceArgs(host)], {
      env: { PATH: process.env.PATH ?? "" },
      cwd: host.workspace,
    });
    control = parseProbe(c.stdout);
    // The control planted a file outside and one in sources/; remove both, so each wrapped run is
    // judged on its own writes.
    fs.rmSync(path.join(root, "outside", "planted.txt"), { force: true });
    fs.rmSync(path.join(root, "work", "sources", "planted.txt"), { force: true });

    const libs = platform === "linux" ? lddLibs(spawnSync("ldd", [probe], { encoding: "utf8" }).stdout) : [];
    // The first shape: the sandbox of every loop without sources. Its wrapper must carry no sources
    // rule at all (the posture's bytes are those of before sources existed), so the air gap below is
    // proved on the profile those loops actually run under, not on one with an extra line.
    const spec = spawnSpec(posture, { ...host, now: NOW, libs, wrapperPath: onPath("bwrap") }, probeArgs(inside));
    noSourcesRule = !spec.args.some((a) => a.includes("sources"));
    const w = await run(spec.file, spec.args, { env: spec.env, cwd: spec.cwd });
    wrappedRaw = `${w.stdout}${w.stderr}`;
    wrapped = parseProbe(w.stdout);

    const withSources = lathPosture({
      toolAllowList: ["store.get", "solana.slot"],
      binarySha256: "00".repeat(32),
      patchSet: "airgap-probe",
      platform,
      sources: { hash: "5e".repeat(32), maxBytes: 16 * 1024 * 1024, maxFiles: 2000 },
    });
    sourcedInside = sandboxPaths(withSources, host);
    const s = spawnSpec(withSources, { ...host, now: NOW, libs, wrapperPath: onPath("bwrap") }, [
      ...probeArgs(sourcedInside),
      ...sourceArgs(sourcedInside),
    ]);
    const sw = await run(s.file, s.args, { env: s.env, cwd: s.cwd });
    wrappedRaw += `\n-- with sources --\n${sw.stdout}${sw.stderr}`;
    sourced = parseProbe(sw.stdout);

    const names = Object.keys(stepEnv(posture, { now: NOW, home: inside.configDir }));
    // `bwrap --chdir` sets PWD in the child; it names the workspace, which the system prompt carries anyway.
    if (platform === "linux") names.push("PWD");
    expectedEnv = names.sort().join(",");
  });

  after(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** The first line whose key starts with `prefix`, as airgap.sh's `grep -F | head -1`. */
  function outcome(lines: Map<string, Outcome>, prefix: string): Outcome {
    for (const [k, v] of lines) if (k.startsWith(prefix)) return v;
    throw new Error(`no probe line for ${prefix}; output:\n${wrappedRaw}`);
  }
  const expectOutcome = (lines: Map<string, Outcome>, prefix: string, want: Outcome["outcome"], label: string) => {
    const got = outcome(lines, prefix);
    assert.equal(got.outcome, want, `${label}: ${got.detail}`);
  };

  it("the unwrapped control reaches what the wrapper must deny, so the pass is not vacuous", () => {
    expectOutcome(control, "loopback:", "reached", "host loopback TCP");
    expectOutcome(control, `read:${keypair}`, "reached", "operator keypair");
    expectOutcome(control, `read:${root}/outside`, "reached", "file outside the sandbox");
    expectOutcome(control, `unix:${root}/other.sock`, "reached", "a third Unix socket");
  });

  it("denies every forbidden reach under the generated wrapper", () => {
    assert.isTrue(noSourcesRule, "the wrapper of a sandbox without sources names no sources/ rule");
    expectOutcome(wrapped, "tcp:", "denied", "outbound TCP 1.1.1.1:443");
    expectOutcome(wrapped, "loopback:", "denied", "host loopback TCP");
    expectOutcome(wrapped, "udp:", "denied", "outbound UDP 1.1.1.1:53");
    expectOutcome(wrapped, "dns:", "denied", "DNS example.com");
    expectOutcome(wrapped, `read:${keypair}`, "denied", "~/.config/solana/id.json");
    expectOutcome(wrapped, `read:${traceFile}`, "denied", "the trace dir");
    expectOutcome(wrapped, `read:${root}/outside`, "denied", "file outside the sandbox");
    expectOutcome(wrapped, "read:/etc/hosts", "denied", "/etc/hosts");
    expectOutcome(wrapped, `write:${root}/outside`, "denied", "write outside the sandbox");
    expectOutcome(wrapped, `unix:${root}/other.sock`, "denied", "a third Unix socket");
    expectOutcome(wrapped, "exec:", "denied", "exec /bin/sh");
    assert.isFalse(fs.existsSync(path.join(root, "outside", "planted.txt")), "nothing was planted outside");
  });

  it("reaches the workspace, the step's data directory and the two sockets", () => {
    expectOutcome(wrapped, `read:${inside.workspace}/note.txt`, "reached", "read in the workspace");
    expectOutcome(wrapped, `write:${inside.workspace}/made.txt`, "reached", "write in the workspace");
    expectOutcome(wrapped, `write:${inside.configDir}/data/trace.jsonl`, "reached", "write in the step's data dir");
    expectOutcome(wrapped, `allow:${inside.modelSocket}`, "reached", "the metering proxy's socket");
    expectOutcome(wrapped, `allow:${inside.toolsSocket}`, "reached", "the host-tool socket");
    assert.include(outcome(wrapped, `allow:${inside.modelSocket}`).detail, "pong");
    // The writes landed in the host's sandbox, where the host reads them when the step exits.
    assert.isTrue(fs.existsSync(path.join(host.workspace, "made.txt")));
    assert.isTrue(fs.existsSync(path.join(host.configDir, "data", "trace.jsonl")));
  });

  it("sees exactly the step's environment", () => {
    assert.equal(outcome(wrapped, "env:").detail, expectedEnv);
  });

  it("with sources: reads sources/ and is denied a write into it, and the air gap is unchanged", () => {
    expectOutcome(control, `write:${host.workspace}/sources/`, "reached", "control: write into sources/ on disk");
    expectOutcome(sourced, `read:${sourcedInside.workspace}/sources/src.txt`, "reached", "read in sources/");
    expectOutcome(sourced, `write:${sourcedInside.workspace}/sources/`, "denied", "write into sources/");
    assert.isFalse(fs.existsSync(path.join(root, "work", "sources", "planted.txt")), "nothing was planted in sources/");
    // The rest of the workspace stays writable, and nothing else the sandbox was denied opens up.
    expectOutcome(sourced, `write:${sourcedInside.workspace}/made.txt`, "reached", "write in the workspace");
    for (const [prefix, label] of [
      ["tcp:", "outbound TCP"],
      ["loopback:", "host loopback TCP"],
      [`read:${keypair}`, "operator keypair"],
      [`write:${root}/outside`, "write outside the sandbox"],
      [`unix:${root}/other.sock`, "a third Unix socket"],
      ["exec:", "exec /bin/sh"],
    ]) {
      expectOutcome(sourced, prefix, "denied", label);
    }
    expectOutcome(sourced, `allow:${sourcedInside.modelSocket}`, "reached", "the metering proxy's socket");
    assert.equal(outcome(sourced, "env:").detail, expectedEnv);
  });

  it("the Rust client refuses a socket path of sun_path's full length, so socketPathOk stops a byte short", async () => {
    const limit = process.platform === "darwin" ? 104 : 108;
    const at = (n: number) => path.join(root, "s".repeat(n - root.length - 1));
    const fits = at(limit - 1);
    assert.isTrue(socketPathOk(fits, process.platform));
    assert.isFalse(socketPathOk(at(limit), process.platform));
    servers.push(await listen(fits));
    const r = parseProbe((await run(probe, [`allow=${fits}`, `allow=${at(limit)}`], { env: {}, cwd: root })).stdout);
    assert.equal(outcome(r, `allow:${fits}`).outcome, "reached", "one byte short of sun_path is reachable");
    const full = outcome(r, `allow:${at(limit)}`);
    assert.equal(full.outcome, "denied");
    assert.include(full.detail, "SUN_LEN", "refused by the client for its length, before any connect");
  });
});
