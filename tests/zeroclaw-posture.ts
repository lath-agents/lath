import { hex } from "@lath/sdk";
import { canonicalJson, policyDocument, policyVersionHash, toRuntimePolicy } from "@lath/runtime/policy";
import {
  BWRAP_SANDBOX,
  bwrapArgs,
  lathPosture,
  lddLibs,
  PostureRefused,
  postureHash,
  renderConfigToml,
  sandboxPaths,
  seatbeltProfile,
  socketPathOk,
  spawnSpec,
  stepEnv,
  zeroclawArgv,
  zeroclawNow,
  type HostSandbox,
  type LathPosture,
} from "@lath/runtime/zeroclaw/posture";
import { assert } from "chai";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * The one host-generated posture, the TOML and environment it renders to,
 * and the policy hash that commits it. Node-only. The air gap itself — the generated wrapper
 * against the probe — is `tests/zeroclaw-airgap.ts`.
 */

const CONTRACT = fs.readFileSync(path.join(__dirname, "..", "zeroclaw", "CONTRACT.md"), "utf8");
const BIN_SHA = "ab".repeat(32);
const PATCH_SET = "cd".repeat(32);
const BASE = { model: "anthropic/claude-sonnet-5", temperature: 0.2, toolAllowList: ["a", "b"], maxCost: 5_000 };

const posture = (platform: string, toolAllowList: string[] = ["store.get", "solana.slot"], maxSteps?: number) =>
  lathPosture({ toolAllowList, maxSteps, binarySha256: BIN_SHA, patchSet: PATCH_SET, platform });

/** Two steps of one loop: different sandboxes, tokens and instants, the same policy. */
const STEPS = [
  {
    sandbox: {
      binary: "/opt/lath/zeroclaw",
      workspace: "/private/tmp/lzc.aaaaaa/agents/lath/workspace/loops/L1",
      configDir: "/private/tmp/lzc.aaaaaa/steps/L1-0/cfg",
      modelSocket: "/private/tmp/lzc.aaaaaa/steps/L1-0/m.sock",
      toolsSocket: "/private/tmp/lzc.aaaaaa/steps/L1-0/t.sock",
    },
    token: "zc-step-token-0-f00d",
    toolsToken: "zc-tools-token-0-beef",
    now: "2026-09-24T10:00:00Z",
  },
  {
    sandbox: {
      binary: "/opt/lath/zeroclaw",
      workspace: "/private/tmp/lzc.aaaaaa/agents/lath/workspace/loops/L1",
      configDir: "/private/tmp/lzc.aaaaaa/steps/L1-1/cfg",
      modelSocket: "/private/tmp/lzc.aaaaaa/steps/L1-1/m.sock",
      toolsSocket: "/private/tmp/lzc.aaaaaa/steps/L1-1/t.sock",
    },
    token: "zc-step-token-1-cafe",
    toolsToken: "zc-tools-token-1-d00d",
    now: "2026-09-24T11:30:00Z",
  },
];

/** Renders everything a step writes or spawns, so a test can check none of it leaked back. */
function renderStep(p: LathPosture, step: (typeof STEPS)[number]) {
  const inside = sandboxPaths(p, step.sandbox);
  const toml = renderConfigToml(p, {
    model: BASE.model,
    temperature: BASE.temperature,
    modelSocket: inside.modelSocket,
    toolsSocket: inside.toolsSocket,
    token: step.token,
    toolsToken: step.toolsToken,
    workspacePath: inside.workspace,
  });
  const spec = spawnSpec(
    p,
    { ...step.sandbox, now: step.now, libs: ["/lib/x86_64-linux-gnu/libc.so.6"] },
    zeroclawArgv(p, { configDir: inside.configDir, message: "the goal" })
  );
  return { toml, spec };
}

/** Section headers and keys, in order, of a TOML text: the shape `zeroclaw/CONTRACT.md` §1 fixes. */
function tomlShape(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header) out.push(`[${header[1]}]`);
    else if (/^[a-z_]+\s*=/.test(line)) out.push(line.split("=")[0].trim());
  }
  return out;
}

const contractToml = /```toml\n([\s\S]*?)```/.exec(CONTRACT)![1];

/** Parses TOML with Python's `tomllib`, an independent reader, or `undefined` when there is none. */
function pythonToml(text: string): unknown {
  const r = spawnSync(
    "python3",
    ["-c", "import json,sys,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))"],
    {
      input: text,
      encoding: "utf8",
    }
  );
  if (r.error || r.status !== 0) return undefined;
  return JSON.parse(r.stdout);
}

describe("zeroclaw posture: the policy hash", () => {
  it("leaves every existing policy-hash vector where it was", () => {
    // The same pinned digests `tests/runtime.ts` and `tests/tempo-inference.ts` assert: `sandbox`
    // is a new optional key, and a policy without it must hash exactly as before it existed, or
    // every genesis already on devnet changed policy.
    assert.equal(hex(policyVersionHash(BASE)), "86d2d33dc8e74fdcf19a52eebb162c94d219241594f33a95ba81c418856912d0");
    assert.equal(
      hex(
        policyVersionHash({ ...BASE, promptHash: "6182417bbd101bec13338e572f204411f74df1b363590ffb0bd25be3541b4858" })
      ),
      "9c2bb44f03366b7bb2194e860a7275f99177bdc35ed029d3db9de88c1c548c06"
    );
    assert.equal(hex(policyVersionHash({ ...BASE, sandbox: undefined })), hex(policyVersionHash(BASE)));
    assert.equal(policyDocument({ ...BASE, sandbox: undefined }), policyDocument(BASE));
    assert.notProperty(toRuntimePolicy(BASE), "sandbox", "an unsandboxed policy object gains no key");
    assert.notProperty(toRuntimePolicy({ ...BASE, sandbox: undefined }), "sandbox");
  });

  it("pins the vector of a policy with the sandbox set, on each platform", () => {
    // Pinned bytes: a change to the posture's shape, a template line or a default moves these, and
    // that is the point — it is a change of jail, and it must be a deliberate one.
    const tools = ["store.get", "solana.slot"];
    const darwin = { ...BASE, toolAllowList: tools, sandbox: posture("darwin") };
    const linux = { ...BASE, toolAllowList: tools, sandbox: posture("linux") };
    assert.equal(hex(policyVersionHash(darwin)), "dd43818d847fdee2207f85ee44aabbe9201454c688b25ee3f44cef553a3d00d5");
    assert.equal(hex(policyVersionHash(linux)), "f66e58f3c6dd344c25ea948a32e0d22a04eb51559497d7cbd7425f7ab1346539");
    assert.equal(postureHash(posture("darwin")), "6cbfda554a1dc4d2bde80983e28dbdc60fda0c481317b2e992fbb060b2515f5e");
    assert.equal(postureHash(posture("linux")), "099af1587d81bcd8edb28ae1401d45af17e6024dd97de3da331b770e62c36bae");
    assert.include(policyDocument(darwin), '"sandbox":{"argv":');
    assert.deepEqual(toRuntimePolicy(darwin).sandbox, darwin.sandbox, "carried through, last");
    assert.equal(Object.keys(toRuntimePolicy(darwin)).pop(), "sandbox");
  });

  it("moves the hash when any part of the jail moves", () => {
    const at = (sandbox: LathPosture) => hex(policyVersionHash({ ...BASE, sandbox }));
    const ref = at(posture("linux"));
    assert.notEqual(at(posture("darwin")), ref, "another wrapper");
    assert.notEqual(at(posture("linux", ["store.get"])), ref, "another tool list");
    assert.notEqual(at(posture("linux", undefined, 8)), ref, "another max_tool_iterations");
    assert.notEqual(at({ ...posture("linux"), binarySha256: "ef".repeat(32) }), ref, "another binary");
    assert.notEqual(at({ ...posture("linux"), patchSet: "other" }), ref, "another patch set");
    const loosened = posture("linux");
    loosened.wrapper.template = loosened.wrapper.template.filter((a) => a !== "--unshare-all");
    assert.notEqual(at(loosened), ref, "a loosened wrapper");
    assert.equal(at(posture("linux", ["solana.slot", "store.get"])), ref, "the tool list is a set");
    assert.equal(at(posture("linux", ["store.get", "solana.slot", "zc.file_read"])), ref, "file tools are always in");
    assert.equal(at(posture("linux", undefined, 16)), ref, "16 is the default");
  });

  it("commits the same posture for every step of a loop, with no token, path or instant in it", () => {
    for (const platform of ["darwin", "linux"]) {
      const hashes = STEPS.map((step) => {
        const p = posture(platform);
        const before = canonicalJson(p);
        const { toml, spec } = renderStep(p, step);
        const committed = canonicalJson(p);
        assert.equal(committed, before, "rendering a step does not write back into the posture");
        for (const secret of [step.token, step.toolsToken, step.now, ...Object.values(step.sandbox)]) {
          assert.notInclude(committed, secret, `${platform}: the posture carries no ${secret}`);
        }
        // And the per-step values did reach what the step is given, or the check above is vacuous.
        assert.include(toml, step.token);
        assert.include(toml, step.toolsToken);
        assert.include(spec.env.ZEROCLAW_NOW, step.now);
        return hex(policyVersionHash({ ...BASE, sandbox: p }));
      });
      assert.equal(hashes[0], hashes[1], `${platform}: two steps, one policy hash`);
    }
    // Every placeholder the templates carry is one the renderers fill.
    const holes = new Set(canonicalJson(posture("darwin")).match(/@[A-Z]+@/g));
    for (const h of canonicalJson(posture("linux")).match(/@[A-Z]+@/g)!) holes.add(h);
    assert.deepEqual([...holes].sort(), [
      "@ANCESTORS@",
      "@BIN@",
      "@CFG@",
      "@ENV@",
      "@HOME@",
      "@LIBS@",
      "@MESSAGE@",
      "@MSOCK@",
      "@NOW@",
      "@TSOCK@",
      "@WORK@",
    ]);
  });

  it("allows file_read, file_write and the host tools the policy names, and refuses the rest by name", () => {
    assert.deepEqual(posture("linux", []).config.risk_profile.allowed_tools, ["file_read", "file_write"]);
    assert.deepEqual(
      posture("linux", ["store.set", "store.get", "solana.fees", "solana.balance", "solana.slot", "lath.verify_chain"])
        .config.risk_profile.allowed_tools,
      [
        "file_read",
        "file_write",
        "lath_verify_chain",
        "solana_balance",
        "solana_fees",
        "solana_slot",
        "store_get",
        "store_set",
      ]
    );
    for (const tool of ["web.fetch", "web.search", "lattice.verify_chain", "shell", "http_request"]) {
      let caught: unknown;
      try {
        posture("linux", ["store.get", tool]);
      } catch (e) {
        caught = e;
      }
      assert.isTrue(PostureRefused.is(caught), tool);
      assert.equal((caught as PostureRefused).tool, tool);
      assert.include((caught as Error).message, tool, "the refusal names the tool");
    }
    assert.throws(() => posture("win32"), /no ZeroClaw wrapper on win32/);
    assert.throws(() => posture("linux", [], 0), /maxSteps/);
    assert.throws(() => lathPosture({ toolAllowList: [], binarySha256: "AB", patchSet: "x", platform: "linux" }));
    assert.throws(() => lathPosture({ toolAllowList: [], binarySha256: BIN_SHA, patchSet: "", platform: "linux" }));
  });
});

describe("zeroclaw posture: the config the host writes (CONTRACT §1)", () => {
  const GOLDEN = `schema_version = 3
locale = "en"

[providers.models.custom.lath]
model = "anthropic/claude-sonnet-5"
uri = "http://localhost/v1"
unix_socket = "/lath/m.sock"
api_key = "tok-model"
native_tools = true
temperature = 0.2

[agents.lath]
enabled = true
model_provider = "custom.lath"
risk_profile = "lath"
runtime_profile = "lath"

[agents.lath.workspace]
path = "/lath/work"

[agents.lath.memory]
backend = "none"

[risk_profiles.lath]
level = "full"
workspace_only = true
allowed_tools = ["file_read", "file_write", "solana_slot", "store_get"]
always_ask = []
sandbox_enabled = false

[runtime_profiles.lath]
max_tool_iterations = 16

[memory]
backend = "none"

[cost]
enabled = false

[reliability]
provider_retries = 0

[lath]
tools_socket = "/lath/t.sock"
tools_token = "tok-tools"
`;
  const render = (over: Partial<Parameters<typeof renderConfigToml>[1]> = {}) =>
    renderConfigToml(posture("linux"), {
      model: BASE.model,
      temperature: BASE.temperature,
      modelSocket: BWRAP_SANDBOX.modelSocket,
      toolsSocket: BWRAP_SANDBOX.toolsSocket,
      token: "tok-model",
      toolsToken: "tok-tools",
      workspacePath: BWRAP_SANDBOX.workspace,
      ...over,
    });

  it("renders the golden bytes, and the same bytes twice", () => {
    assert.equal(render(), GOLDEN);
    assert.equal(render(), render());
  });

  it("has every CONTRACT §1 section and key, in the contract's order, and nothing else", () => {
    // Read from the contract itself, so a change to either side without the other fails here.
    const shape = tomlShape(contractToml);
    assert.isAtLeast(shape.length, 30, "the contract's TOML block was found");
    assert.deepEqual(tomlShape(render()), shape);
  });

  it("round-trips through an independent TOML reader", function () {
    const parsed = pythonToml(render()) as any;
    if (parsed === undefined) {
      // Python 3.11+ has `tomllib`; a machine without it runs every other case here.
      console.log("      skipped: no python3 with tomllib to read the TOML back");
      this.skip();
    }
    assert.deepEqual(parsed, {
      schema_version: 3,
      locale: "en",
      providers: {
        models: {
          custom: {
            lath: {
              model: BASE.model,
              uri: "http://localhost/v1",
              unix_socket: "/lath/m.sock",
              api_key: "tok-model",
              native_tools: true,
              temperature: 0.2,
            },
          },
        },
      },
      agents: {
        lath: {
          enabled: true,
          model_provider: "custom.lath",
          risk_profile: "lath",
          runtime_profile: "lath",
          workspace: { path: "/lath/work" },
          memory: { backend: "none" },
        },
      },
      risk_profiles: {
        lath: {
          level: "full",
          workspace_only: true,
          allowed_tools: ["file_read", "file_write", "solana_slot", "store_get"],
          always_ask: [],
          sandbox_enabled: false,
        },
      },
      runtime_profiles: { lath: { max_tool_iterations: 16 } },
      memory: { backend: "none" },
      cost: { enabled: false },
      reliability: { provider_retries: 0 },
      lath: { tools_socket: "/lath/t.sock", tools_token: "tok-tools" },
    });
    // A value that could break out of its line is escaped, not trusted: the model slug and the
    // tokens come from outside the posture.
    const hostile = 'x"\n[cost]\nenabled = true\\';
    const back = pythonToml(render({ model: hostile, token: hostile })) as any;
    assert.equal(back.providers.models.custom.lath.model, hostile);
    assert.equal(back.providers.models.custom.lath.api_key, hostile);
    assert.equal(back.cost.enabled, false);
    // An integral temperature is a TOML float, not an integer.
    assert.include(render({ temperature: 1 }), "\ntemperature = 1.0\n");
    assert.strictEqual((pythonToml(render({ temperature: 1 })) as any).providers.models.custom.lath.temperature, 1);
  });

  it("writes context_window after temperature only when the step has one, and the golden bytes without", () => {
    // The window is per step, like the model: absent (or undefined) is today's config exactly.
    assert.equal(render({ contextWindow: undefined }), GOLDEN);
    const withWindow = render({ contextWindow: 163_840 });
    assert.equal(withWindow, GOLDEN.replace("temperature = 0.2\n", "temperature = 0.2\ncontext_window = 163840\n"));
    assert.deepEqual(
      tomlShape(withWindow).filter((k) => k !== "context_window"),
      tomlShape(contractToml),
      "the only key it adds is context_window"
    );
    const parsed = pythonToml(withWindow) as any;
    // An integer to an independent reader too: patch 0005 refuses a float or a string.
    if (parsed !== undefined) assert.strictEqual(parsed.providers.models.custom.lath.context_window, 163_840);
    // It is not a posture key, so no posture or policy hash can move with it.
    assert.notInclude(canonicalJson(posture("linux")), "context");
  });

  it("refuses a context window the binary would refuse, rather than writing it", () => {
    for (const bad of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 2]) {
      assert.throws(() => render({ contextWindow: bad }), /positive integer/, String(bad));
    }
  });

  it("refuses a relative or unnormalised path rather than writing it", () => {
    assert.throws(() => render({ workspacePath: "work" }), /absolute/);
    assert.throws(() => render({ modelSocket: "/lath/../m.sock" }), /normalised/);
    assert.throws(() => render({ toolsSocket: '/lath/t".sock' }), /cannot hold/);
    assert.throws(() => render({ temperature: NaN }), /finite/);
  });
});

describe("zeroclaw posture: the process (CONTRACT §4)", () => {
  // The contract's environment bullet, read from the file (it wraps): `HOME=…`, `TZ=UTC`, …
  const envAt = CONTRACT.indexOf("Environment, and nothing else");
  const contractEnvLine = CONTRACT.slice(envAt, CONTRACT.indexOf("\n- ", envAt));
  const contractEnvNames = [...contractEnvLine.matchAll(/`([A-Z_]+)=/g)].map((m) => m[1]).sort();

  it("sets exactly the contract's environment, with nothing inherited", () => {
    assert.deepEqual(contractEnvNames, ["HOME", "LANG", "TZ", "ZEROCLAW_NOW", "ZEROCLAW_OMIT_HOST"]);
    const prior = process.env.LATH_TEMPO_TREASURY;
    process.env.LATH_TEMPO_TREASURY = "a treasury secret the sandbox must never see";
    try {
      for (const platform of ["darwin", "linux"]) {
        const p = posture(platform);
        const { spec } = renderStep(p, STEPS[0]);
        const home = sandboxPaths(p, STEPS[0].sandbox).configDir;
        assert.deepEqual(spec.env, {
          HOME: home,
          LANG: "C",
          TZ: "UTC",
          ZEROCLAW_NOW: "2026-09-24T10:00:00Z",
          ZEROCLAW_OMIT_HOST: "1",
        });
        assert.deepEqual(Object.keys(spec.env).sort(), contractEnvNames);
        assert.deepEqual(spec.env, stepEnv(p, { now: STEPS[0].now, home }));
        assert.notInclude(JSON.stringify(spec), "treasury secret");
      }
    } finally {
      if (prior === undefined) delete process.env.LATH_TEMPO_TREASURY;
      else process.env.LATH_TEMPO_TREASURY = prior;
    }
    assert.equal(stepEnv(posture("linux"), { now: STEPS[0].now, home: BWRAP_SANDBOX.configDir }).HOME, "/lath/cfg");
  });

  it("writes the step's instant to the second, as RFC 3339", () => {
    assert.equal(zeroclawNow(new Date("2026-09-24T10:00:00.987Z")), "2026-09-24T10:00:00Z");
    assert.equal(zeroclawNow("2026-09-24T10:00:00+02:00"), "2026-09-24T10:00:00+02:00");
    assert.throws(() => zeroclawNow("yesterday"), /RFC 3339/);
    assert.throws(() => zeroclawNow(new Date("nope")), /invalid/);
  });

  it("invokes `--config-dir <cfg> agent -a lath -m <message>`, the message one argument", () => {
    const msg = 'two words; and "quotes"\nand a line';
    assert.deepEqual(zeroclawArgv(posture("linux"), { configDir: "/lath/cfg", message: msg }), [
      "--config-dir",
      "/lath/cfg",
      "agent",
      "-a",
      "lath",
      "-m",
      msg,
    ]);
    // A message that looks like a placeholder is data, not a template.
    assert.equal(zeroclawArgv(posture("linux"), { configDir: "/lath/cfg", message: "@CFG@" })[6], "@CFG@");
  });

  it("wraps with bwrap --unshare-all at the fixed sandbox paths on Linux", () => {
    const p = posture("linux");
    const sandbox = { ...STEPS[0].sandbox, libs: ["/lib/b.so", "/lib/a.so", "/lib/a.so"], now: STEPS[0].now };
    const args = bwrapArgs(p, sandbox);
    assert.deepEqual(args.slice(0, 4), ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv"]);
    assert.equal(args[args.length - 1], "/lath/bin/zeroclaw");
    // Every --setenv comes after --clearenv, and together they are exactly the step's environment.
    const setenv: Record<string, string> = {};
    args.forEach((a, i) => a === "--setenv" && (setenv[args[i + 1]] = args[i + 2]));
    assert.deepEqual(setenv, stepEnv(p, { now: STEPS[0].now, home: "/lath/cfg" }));
    assert.isAbove(args.indexOf("--setenv"), args.indexOf("--clearenv"));
    const binds = (flag: string) =>
      args.flatMap((a, i) => (a === flag ? [`${args[i + 1]} -> ${args[i + 2]}`] : [])).sort();
    assert.deepEqual(binds("--ro-bind"), [
      "/lib/a.so -> /lib/a.so",
      "/lib/b.so -> /lib/b.so",
      `${sandbox.binary} -> /lath/bin/zeroclaw`,
    ]);
    assert.deepEqual(
      binds("--bind"),
      [
        `${sandbox.configDir} -> /lath/cfg`,
        `${sandbox.modelSocket} -> /lath/m.sock`,
        `${sandbox.toolsSocket} -> /lath/t.sock`,
        `${sandbox.workspace} -> /lath/work`,
      ].sort()
    );
    assert.deepEqual(sandboxPaths(p, sandbox), { ...BWRAP_SANDBOX });
    assert.throws(() => seatbeltProfile(p, sandbox), /bwrap, not sandbox-exec/);
    const spec = spawnSpec(p, sandbox, ["x"]);
    assert.equal(spec.file, "/usr/bin/bwrap");
    assert.deepEqual(spec.args, [...args, "x"]);
  });

  it("wraps with a deny-default Seatbelt profile that names two sockets and no shell on macOS", () => {
    const p = posture("darwin");
    const sandbox: HostSandbox = STEPS[0].sandbox;
    const profile = seatbeltProfile(p, sandbox);
    const lines = profile.trimEnd().split("\n");
    assert.equal(lines.length, p.wrapper.template.length, "one line per committed template line");
    assert.deepEqual(lines.slice(0, 2), ["(version 1)", "(deny default)"]);
    assert.deepEqual(
      lines.filter((l) => l.includes("network")),
      [
        `(allow network-outbound (remote unix-socket (path-literal "${sandbox.modelSocket}")))`,
        `(allow network-outbound (remote unix-socket (path-literal "${sandbox.toolsSocket}")))`,
      ]
    );
    assert.include(profile, `(allow process-exec (literal "${sandbox.binary}"))`);
    assert.notInclude(profile, "/bin/sh");
    assert.include(
      profile,
      '(allow file-read-metadata (literal "/") (literal "/private") (literal "/private/tmp") (literal "/private/tmp/lzc.aaaaaa") ' +
        '(literal "/private/tmp/lzc.aaaaaa/agents") (literal "/private/tmp/lzc.aaaaaa/agents/lath") ' +
        '(literal "/private/tmp/lzc.aaaaaa/agents/lath/workspace") (literal "/private/tmp/lzc.aaaaaa/agents/lath/workspace/loops") ' +
        '(literal "/private/tmp/lzc.aaaaaa/steps") (literal "/private/tmp/lzc.aaaaaa/steps/L1-0"))'
    );
    assert.include(
      profile,
      `(allow file-read* file-write* (subpath "${sandbox.workspace}") (subpath "${sandbox.configDir}"))`
    );
    assert.throws(() => seatbeltProfile(p, { ...sandbox, workspace: '/tmp/a")(allow default)(x "' }), /cannot hold/);
    assert.throws(() => bwrapArgs(p, { ...sandbox, libs: [], now: STEPS[0].now }), /sandbox-exec, not bwrap/);
    const spec = spawnSpec(p, { ...sandbox, now: STEPS[0].now }, ["x"]);
    assert.equal(spec.file, "/usr/bin/sandbox-exec");
    assert.deepEqual(spec.args, ["-p", profile, sandbox.binary, "x"]);
    assert.equal(spec.cwd, sandbox.workspace);
  });

  it("reads the loader's libraries from ldd's output", () => {
    const ldd = [
      "\tlinux-vdso.so.1 (0x0000ffff9a5f1000)",
      "\tlibgcc_s.so.1 => /lib/aarch64-linux-gnu/libgcc_s.so.1 (0x0000ffff9a560000)",
      "\tlibc.so.6 => /lib/aarch64-linux-gnu/libc.so.6 (0x0000ffff9a3b0000)",
      "\t/lib/ld-linux-aarch64.so.1 (0x0000ffff9a5b4000)",
    ].join("\n");
    assert.deepEqual(lddLibs(ldd), [
      "/lib/aarch64-linux-gnu/libc.so.6",
      "/lib/aarch64-linux-gnu/libgcc_s.so.1",
      "/lib/ld-linux-aarch64.so.1",
    ]);
  });

  it("accepts a socket path only if the Rust client can reach it: 103 bytes on macOS, 107 on Linux", () => {
    const at = (n: number) => `/${"s".repeat(n - 1)}`;
    assert.isTrue(socketPathOk(at(103), "darwin"));
    assert.isFalse(socketPathOk(at(104), "darwin"));
    assert.isTrue(socketPathOk(at(107), "linux"));
    assert.isFalse(socketPathOk(at(108), "linux"));
    assert.isFalse(socketPathOk("rel/m.sock", "linux"));
    assert.isFalse(socketPathOk("/m.sock", "win32"));
    // Bytes, not characters: a multi-byte name is measured as the kernel measures it.
    assert.isFalse(socketPathOk(`/${"é".repeat(52)}`, "darwin"));
  });
});

describe("zeroclaw posture: a sandbox with sources", () => {
  const SOURCES = { hash: "5e".repeat(32), maxBytes: 16 * 1024 * 1024, maxFiles: 2000 };
  const withSources = (platform: string, sources = SOURCES) =>
    lathPosture({
      toolAllowList: ["store.get", "solana.slot"],
      binarySha256: BIN_SHA,
      patchSet: PATCH_SET,
      platform,
      sources,
    });

  it("hashes a posture without sources exactly as before, and one with them differently", () => {
    // The pinned digests of the vector test above, restated against a posture built with the key
    // absent: the key is additive, and a loop that has no sources commits today's bytes.
    assert.equal(postureHash(posture("darwin")), "6cbfda554a1dc4d2bde80983e28dbdc60fda0c481317b2e992fbb060b2515f5e");
    assert.equal(postureHash(posture("linux")), "099af1587d81bcd8edb28ae1401d45af17e6024dd97de3da331b770e62c36bae");
    assert.notProperty(posture("darwin"), "sources", "absent, not undefined");
    for (const platform of ["darwin", "linux"]) {
      const p = withSources(platform);
      assert.deepEqual(p.sources, SOURCES);
      assert.notEqual(postureHash(p), postureHash(posture(platform)), `${platform}: sources move the hash`);
      assert.notEqual(
        hex(policyVersionHash({ ...BASE, sandbox: p })),
        hex(policyVersionHash({ ...BASE, sandbox: posture(platform) }))
      );
      // Another manifest is another posture: the hash commits which files the sandbox was given.
      assert.notEqual(postureHash(withSources(platform, { ...SOURCES, hash: "5f".repeat(32) })), postureHash(p));
      assert.include(canonicalJson(p), `"sources":{"hash":"${SOURCES.hash}"`);
    }
    // Pinned, as the posture vectors are: a change to the sources rule is a change of jail.
    assert.equal(
      postureHash(withSources("darwin")),
      "2342edb0044eadb1f1144322a1cd09494305c84a7103b89f3e7b7b02b81ade63"
    );
    assert.equal(postureHash(withSources("linux")), "018ffb8979ae9035b4bfe99eedcf7c7c71936c8b82e5f66d3b8a928d207ac881");
  });

  it("refuses a sources key that is not a hash and two caps", () => {
    assert.throws(() => withSources("linux", { ...SOURCES, hash: "AB" }), /sources.hash/);
    assert.throws(() => withSources("linux", { ...SOURCES, maxBytes: 0 }), /sources.maxBytes/);
    assert.throws(() => withSources("linux", { ...SOURCES, maxFiles: 1.5 }), /sources.maxFiles/);
  });

  it("denies every write under <workspace>/sources in the Seatbelt profile, after the workspace's allow", () => {
    const p = withSources("darwin");
    const sandbox: HostSandbox = STEPS[0].sandbox;
    const lines = seatbeltProfile(p, sandbox).trimEnd().split("\n");
    const allow = lines.indexOf(
      `(allow file-read* file-write* (subpath "${sandbox.workspace}") (subpath "${sandbox.configDir}"))`
    );
    assert.isAbove(allow, 0);
    // After, not before: Seatbelt lets the last matching rule decide (as probed).
    assert.equal(lines[allow + 1], `(deny file-write* (subpath "${sandbox.workspace}/sources"))`);
    assert.lengthOf(lines, posture("darwin").wrapper.template.length + 1, "one line more, and only that");
    assert.notInclude(seatbeltProfile(posture("darwin"), sandbox), "deny file-write*", "none without sources");
  });

  it("binds <workspace>/sources read-only over /lath/work/sources under bwrap, after the workspace's bind", () => {
    const p = withSources("linux");
    const sandbox = { ...STEPS[0].sandbox, libs: [], now: STEPS[0].now };
    const args = bwrapArgs(p, sandbox);
    const work = args.indexOf("--bind");
    assert.deepEqual(args.slice(work, work + 3), ["--bind", sandbox.workspace, "/lath/work"]);
    const at = args.findIndex((a, i) => a === "--ro-bind" && args[i + 2] === "/lath/work/sources");
    assert.isAbove(at, work, "a later mount covers the earlier one");
    assert.equal(args[at + 1], `${sandbox.workspace}/sources`);
    assert.notInclude(bwrapArgs(posture("linux"), sandbox), "/lath/work/sources", "none without sources");
    assert.deepEqual(sandboxPaths(p, sandbox), { ...BWRAP_SANDBOX });
  });

  it("names @SRC@ only in a posture with sources, and fills it at spawn", () => {
    const holes = (p: LathPosture) => canonicalJson(p).match(/@[A-Z]+@/g)!;
    assert.notInclude(holes(posture("darwin")), "@SRC@");
    assert.notInclude(holes(posture("linux")), "@SRC@");
    for (const platform of ["darwin", "linux"]) {
      const p = withSources(platform);
      assert.include(holes(p), "@SRC@");
      const { spec } = renderStep(p, STEPS[0]);
      assert.notInclude(spec.args.join("\n"), "@SRC@", `${platform}: filled`);
    }
  });
});

describe("zeroclaw posture: a lowered workspace cap", () => {
  const lowered = (platform: string, workspace: { maxBytes?: number; maxFiles?: number }) =>
    lathPosture({
      toolAllowList: ["store.get", "solana.slot"],
      binarySha256: BIN_SHA,
      patchSet: PATCH_SET,
      platform,
      workspace,
    });

  it("hashes a posture at the host's cap exactly as before, however it is spelled", () => {
    // The same pinned digests as the vectors above: the cap lives under the `workspace` key every
    // posture already has, so leaving it out, passing `{}`, or restating the host's default caps
    // changes no byte.
    for (const [platform, pinned] of [
      ["darwin", "6cbfda554a1dc4d2bde80983e28dbdc60fda0c481317b2e992fbb060b2515f5e"],
      ["linux", "099af1587d81bcd8edb28ae1401d45af17e6024dd97de3da331b770e62c36bae"],
    ]) {
      assert.equal(postureHash(posture(platform)), pinned);
      assert.equal(postureHash(lowered(platform, {})), pinned, `${platform}: an empty cap is the host's`);
      assert.equal(
        postureHash(lowered(platform, { maxBytes: 8 * 1024 * 1024, maxFiles: 1000 })),
        pinned,
        `${platform}: the host's default restated is the host's default`
      );
      assert.deepEqual(lowered(platform, {}), posture(platform), "key for key, not only in bytes");
    }
  });

  it("commits a lowered cap in the posture's workspace key, pinned", () => {
    const p = lowered("darwin", { maxBytes: 2 * 1024 * 1024, maxFiles: 250 });
    assert.deepEqual(p.workspace, { maxBytes: 2 * 1024 * 1024, maxFiles: 250 });
    assert.deepEqual(Object.keys(p).sort(), Object.keys(posture("darwin")).sort(), "no key added");
    assert.include(canonicalJson(p), '"workspace":{"maxBytes":2097152,"maxFiles":250}');
    // Pinned, as every posture vector is: a sandbox held to less is another jail, and says so.
    assert.equal(postureHash(p), "197992c4a521d918ed01de09fbabd00cf7661ac37a7a032b8b61dd037ce0bca1");
    assert.equal(
      postureHash(lowered("linux", { maxBytes: 2 * 1024 * 1024, maxFiles: 250 })),
      "083e11529c9937aa642d1a983f3655d7ee9ee391eda92e746d9f2bb17fb0ac2a"
    );
    // One bound lowered leaves the other at the host's.
    assert.deepEqual(lowered("linux", { maxFiles: 100 }).workspace, { maxBytes: 8 * 1024 * 1024, maxFiles: 100 });
    assert.notEqual(postureHash(lowered("linux", { maxFiles: 100 })), postureHash(posture("linux")));
  });

  it("refuses a cap above the host's default or one that is not a positive whole number", () => {
    assert.throws(() => lowered("linux", { maxBytes: 8 * 1024 * 1024 + 1 }), /workspace.maxBytes .* above the host's/);
    assert.throws(() => lowered("linux", { maxFiles: 1001 }), /workspace.maxFiles .* above the host's/);
    assert.throws(() => lowered("linux", { maxFiles: 0 }), /workspace.maxFiles must be a positive integer/);
    assert.throws(() => lowered("linux", { maxBytes: 1.5 }), /workspace.maxBytes must be a positive integer/);
  });
});
