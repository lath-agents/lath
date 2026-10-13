/**
 * `lath-audit binary <agent id|--name n> <seq>` — which Lath-patched ZeroClaw build did this loop
 * step commit to, and can this checkout rebuild it?
 *
 * A sandboxed step commits its `LathPosture` under the `sandbox` key of the policy document its
 * Genesis hashes into `policy_version_hash`, and the posture names the binary by `sha256`
 * and the patch series by `patchSet`. So the chain of custody a stranger walks is: the record at
 * `seq` → the step's Genesis → its payload, re-hashed to the `payload_hash` the chain holds → the
 * `policy_version_hash` inside it → a policy document that re-hashes to that → its `sandbox` key.
 * Only then are the posture's two hashes worth comparing with anything: the published builds
 * (`zeroclaw-builds.ts`), this checkout's `zeroclaw/patches/`, a binary on this disk, or one
 * `zeroclaw/build.sh` builds here from the pins.
 *
 * What it proves, and what it does not: a MATCH says the build the step _committed to_ is the one
 * the pinned sources produce. It says nothing about whether the step _ran_ in it — that is the
 * host's claim, and replay is what tests it.
 *
 * Node-only (it reads the checkout and spawns the build), so it is reached from `cli.ts` and never
 * from `browser.ts`. The pure half — the patch-set hash, the posture read, the verdict — is
 * exported for `tests/zeroclaw-binary-audit.ts`.
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { blobAt, encryptedAt, genesisPolicyVersionHash, openSessionAt, walkChain, type InferenceChain } from "./audit";
import { EventKind } from "./events";
import { hex, idFromString, sha256, toBytes32, utf8 } from "./hash";
import { IRYS_GATEWAY } from "./locator";
import { LOOP_STEP_TOOL } from "./loops";
import { canonicalJson } from "./market";
import { type EpochStore } from "./rollup";
import { type TraceStore } from "./trace-store";
import { publishedBuild, ZEROCLAW_UPSTREAM_COMMIT, type ZeroclawBuild } from "./zeroclaw-builds";

const HEX64 = /^[0-9a-f]{64}$/;

/** The three posture fields this command is about, plus the hash of the posture's own bytes. */
export interface PostureBinary {
  binarySha256: string;
  patchSet: string;
  wrapper: string;
  /** `sha256(canonicalJson(sandbox))`: the posture hash the console and the sandbox page print. */
  postureHash: string;
}

export interface BinaryAuditReport {
  agentId: string;
  seq: string;
  /** What the record at `seq` is: `loop.step`, `Genesis`, or another kind by name. */
  record?: string;
  genesisSeq?: string;
  /** Read from the Genesis's payload, which re-hashed to the chain's `payload_hash`. */
  policyVersionHash?: string;
  /** Where the policy document came from: `store` (under `policy_version_hash`) or the `--policy` source. */
  policySource?: string;
  /** `sha256` of the policy document read. */
  policyHash?: string;
  /** `match`: the document re-hashes to the Genesis's commitment. `unanchored`: that was not read. */
  anchor: "match" | "mismatch" | "unanchored";
  posture?: PostureBinary;
  /**
   * `--posture-irys`: the posture's copy on Irys, re-hashed here. `match` holds it to the
   * posture the policy document carries; `null` when no document was read, and the posture above is
   * then this copy's word alone.
   */
  postureIrys?: { source: string; postureHash: string; match: boolean | null };
  published?: ZeroclawBuild | null;
  checkout?: { root: string; upstream: string; patchSet: string } | null;
  local?: { path: string; sha256: string };
  build?: { outcome: "match" | "mismatch" | "failed" | "skipped"; built?: string; note?: string };
  /** `ok`: every check that ran agreed. `mismatch`: something contradicted the chain. `unchecked`: something could not run. */
  verdict: "ok" | "mismatch" | "unchecked";
  /** Why the verdict is not `ok`, one sentence each. */
  notes: string[];
}

/**
 * The patch set as `zeroclaw/build.sh` prints it: `sha256` of every `*.patch` concatenated in name
 * order (`cat "${PATCHES[@]}" | shasum -a 256`). Other files beside them (a PR description, `.md`)
 * are not part of the series and are left out, as the shell glob leaves them out.
 */
export function patchSetOf(patches: readonly { name: string; bytes: Uint8Array }[]): string {
  const series = patches
    .filter((p) => p.name.endsWith(".patch"))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const total = series.reduce((n, p) => n + p.bytes.length, 0);
  const all = new Uint8Array(total);
  let at = 0;
  for (const p of series) {
    all.set(p.bytes, at);
    at += p.bytes.length;
  }
  return hex(sha256(all));
}

/**
 * The policy document's bytes out of what `--policy` handed in: either the document itself, or the
 * console's `GET /api/zeroclaw/<loopId>?step=N` response, whose `sandbox.policyDocument.value` is
 * the document as a string. Nothing here is trusted: the bytes are re-hashed against the Genesis.
 */
export function policyDocumentFrom(bytes: Uint8Array): Uint8Array | null {
  let parsed: any;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const served = parsed.sandbox?.policyDocument;
  if (served && typeof served === "object" && "source" in served) {
    return typeof served.value === "string" ? utf8(served.value) : null;
  }
  // The document itself: kept as the bytes that arrived, because re-serialising would hash
  // something the Genesis never committed if the file was not canonical to begin with.
  return bytes;
}

/**
 * The posture a policy document carries, and whether the document is the one the Genesis hashed.
 * `policyVersionHash` absent means the Genesis could not be read, and the answer is `unanchored`:
 * the posture is printed, but only as what the source says.
 */
export function postureOfPolicy(
  doc: Uint8Array,
  policyVersionHash: string | undefined
): { policyHash: string; anchor: BinaryAuditReport["anchor"]; posture?: PostureBinary; problem?: string } {
  const policyHash = hex(sha256(doc));
  const anchor = !policyVersionHash ? "unanchored" : policyHash === policyVersionHash ? "match" : "mismatch";
  let parsed: any;
  try {
    parsed = JSON.parse(new TextDecoder().decode(doc));
  } catch {
    return { policyHash, anchor, problem: "the policy document is not JSON" };
  }
  const s = parsed?.sandbox;
  if (!s || typeof s !== "object") {
    return {
      policyHash,
      anchor,
      problem: "the policy document has no sandbox key: this step did not run in a sandbox",
    };
  }
  const binarySha256 = typeof s.binarySha256 === "string" ? s.binarySha256.toLowerCase() : "";
  const patchSet = typeof s.patchSet === "string" ? s.patchSet.toLowerCase() : "";
  const wrapper = typeof s.wrapper?.kind === "string" ? s.wrapper.kind : "";
  if (!HEX64.test(binarySha256) || !HEX64.test(patchSet)) {
    return { policyHash, anchor, problem: "the posture names no binarySha256 or patchSet as 64 hex characters" };
  }
  return {
    policyHash,
    anchor,
    posture: { binarySha256, patchSet, wrapper, postureHash: hex(sha256(utf8(canonicalJson(s)))) },
  };
}

/** The host's target triple, for the triples `zeroclaw/build.sh` has been run on; `null` for the rest. */
/**
 * A posture's bytes from Irys (`--posture-irys`), read as the policy's `sandbox` key is read: the
 * three fields, and the hash of the bytes themselves — which is the posture hash only when the bytes
 * are the canonical form, so a copy that parses but is not canonical is refused rather than hashed
 * to something no Genesis could commit. Against `committed`, the posture the policy document
 * carries, the answer is whether the two are the same bytes.
 */
export function postureFromIrys(
  bytes: Uint8Array,
  source: string,
  committed?: PostureBinary
): { irys?: NonNullable<BinaryAuditReport["postureIrys"]>; posture?: PostureBinary; problem?: string } {
  const postureHash = hex(sha256(bytes));
  let s: any;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    s = JSON.parse(text);
  } catch {
    return { problem: `${source} is not JSON, so it is not a posture` };
  }
  if (!s || typeof s !== "object" || canonicalJson(s) !== text) {
    return { problem: `${source} is not a posture in canonical JSON, so its hash is no posture hash` };
  }
  const irys = { source, postureHash, match: committed ? committed.postureHash === postureHash : null };
  if (committed) return { irys };
  const binarySha256 = typeof s.binarySha256 === "string" ? s.binarySha256 : "";
  const patchSet = typeof s.patchSet === "string" ? s.patchSet : "";
  const wrapper = typeof s.wrapper?.kind === "string" ? s.wrapper.kind : "";
  if (!HEX64.test(binarySha256) || !HEX64.test(patchSet)) {
    return { irys, problem: `${source} names no binarySha256 or patchSet as 64 hex characters` };
  }
  return { irys, posture: { binarySha256, patchSet, wrapper, postureHash } };
}

export function hostTriple(platform: string = process.platform, arch: string = process.arch): string | null {
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
  if (platform === "linux" && arch === "arm64") return "aarch64-unknown-linux-gnu";
  return null;
}

/** The OS a wrapper implies: `sandbox-exec` exists only on macOS, `bwrap` only on Linux. */
export function wrapperPlatform(wrapper: string): "darwin" | "linux" | null {
  return wrapper === "sandbox-exec" ? "darwin" : wrapper === "bwrap" ? "linux" : null;
}

/**
 * The verdict from what ran. Only a contradiction is `mismatch`: a document that does not re-hash
 * to the Genesis, a local binary or a build that is not the posture's. What could not be checked —
 * an encrypted Genesis, an unlisted build, a checkout whose patches moved on — is `unchecked`, and
 * says why, because each has a different remedy.
 */
export function binaryVerdict(r: Omit<BinaryAuditReport, "verdict" | "notes">, notes: string[]): BinaryAuditReport {
  const bad: string[] = [];
  const open: string[] = [...notes];
  if (r.anchor === "mismatch") {
    bad.push(`the policy document hashes to ${r.policyHash}, the Genesis committed ${r.policyVersionHash}`);
  }
  if (r.postureIrys?.match === false) {
    bad.push(
      `${r.postureIrys.source} hashes to ${r.postureIrys.postureHash}, the policy's posture to ${r.posture?.postureHash}`
    );
  }
  const p = r.posture;
  if (p && r.local && r.local.sha256 !== p.binarySha256) {
    bad.push(`${r.local.path} hashes to ${r.local.sha256}, the posture commits ${p.binarySha256}`);
  }
  if (r.build?.outcome === "mismatch")
    bad.push(`the build here gave ${r.build.built}, the posture commits ${p?.binarySha256}`);
  if (r.build?.outcome === "failed") open.push(`the build did not finish${r.build.note ? `: ${r.build.note}` : ""}`);
  if (!p) open.push("no posture was read, so there is no binary to compare");
  if (p && r.anchor === "unanchored")
    open.push("the posture was not held to the chain; what it names is the source's word");
  if (p && !r.published && r.build?.outcome !== "match") {
    open.push(`${p.binarySha256} is not a build this repo publishes (sdk/src/zeroclaw-builds.ts)`);
  }
  if (p && r.checkout && r.checkout.patchSet !== p.patchSet) {
    open.push(
      `this checkout's zeroclaw/patches hash to ${r.checkout.patchSet}, the posture's to ${p.patchSet}: ` +
        "check out the revision whose patches the posture names before building"
    );
  }
  if (p && r.checkout && r.checkout.upstream !== ZEROCLAW_UPSTREAM_COMMIT) {
    open.push(`this checkout pins upstream ${r.checkout.upstream}, the published builds ${ZEROCLAW_UPSTREAM_COMMIT}`);
  }
  if (p && r.checkout === null) open.push("no zeroclaw/ checkout was found, so the patch set was not re-hashed");
  const verdict = bad.length ? "mismatch" : open.length ? "unchecked" : "ok";
  return { ...r, verdict, notes: [...bad, ...open] };
}

export function formatBinaryAudit(r: BinaryAuditReport): string[] {
  const out = [`agent      ${r.agentId}`, `seq        ${r.seq}${r.record ? ` (${r.record})` : ""}`];
  if (r.genesisSeq) out.push(`genesis    seq ${r.genesisSeq}`);
  if (r.policyVersionHash) out.push(`policy     ${r.policyVersionHash} (the Genesis's policy_version_hash)`);
  if (r.policyHash) {
    const held =
      r.anchor === "match"
        ? "re-hashes to it"
        : r.anchor === "mismatch"
        ? "DOES NOT re-hash to it"
        : "not held to the chain";
    out.push(`document   ${r.policyHash} from ${r.policySource}, ${held}`);
  }
  const p = r.posture;
  if (r.postureIrys) {
    const held =
      r.postureIrys.match === true
        ? "the same bytes as the policy's posture"
        : r.postureIrys.match === false
        ? "NOT the policy's posture"
        : "not held to a policy document";
    out.push(`irys       ${r.postureIrys.postureHash} from ${r.postureIrys.source}, ${held}`);
  }
  if (p) {
    out.push(`posture    ${p.postureHash}`);
    out.push(`binary     ${p.binarySha256}`);
    out.push(`wrapper    ${p.wrapper || "unnamed"}`);
    out.push(
      `published  ${
        r.published ? `yes, ${r.published.triple} (${r.published.note})` : "no, not in PUBLISHED_ZEROCLAW_BUILDS"
      }`
    );
    const here = r.checkout
      ? r.checkout.patchSet === p.patchSet
        ? "this checkout's zeroclaw/patches match"
        : `this checkout's are ${r.checkout.patchSet}`
      : "no checkout to compare";
    out.push(`patchset   ${p.patchSet}, ${here}`);
    if (r.local) {
      out.push(
        `local      ${r.local.path} ${r.local.sha256 === p.binarySha256 ? "MATCH" : `MISMATCH ${r.local.sha256}`}`
      );
    }
    if (r.build) {
      const word = {
        match: "MATCH",
        mismatch: `MISMATCH, built ${r.build.built}`,
        failed: "did not finish",
        skipped: "skipped",
      };
      out.push(`build      ${word[r.build.outcome]}${r.build.note ? ` (${r.build.note})` : ""}`);
    }
  }
  for (const n of r.notes) out.push(`  ${n}`);
  const last = { ok: "VERIFIED", mismatch: "FAILED", unchecked: "NOT VERIFIED" };
  out.push("", last[r.verdict]);
  return out;
}

/** `0` verified, `1` a contradiction, `2` something could not be checked — `verify-step`'s codes. */
export function binaryAuditExitCode(r: BinaryAuditReport): number {
  return r.verdict === "ok" ? 0 : r.verdict === "mismatch" ? 1 : 2;
}

export interface StepPostureOptions {
  store?: TraceStore;
  epochs?: EpochStore;
  /** `--policy`: the document, or the console's sandbox response; used when the store has none. */
  policy?: { bytes: Uint8Array; source: string };
  /** `--posture-irys`: the posture's own bytes, from the Irys gateway. */
  postureIrys?: { bytes: Uint8Array; source: string };
}

/**
 * The chain half: find the step's Genesis, read `policy_version_hash` out of its payload, and the
 * posture out of the policy document that re-hashes to it.
 *
 * `seq` may be the step's `loop.step` checkpoint, its Genesis, or any record between: the Genesis
 * is the newest one at or before `seq`, which for a checkpoint is the step's own session — the
 * same rule `verify-step` finds a step's policy by.
 *
 * The document is read from the store under `policy_version_hash` first. Only a gated step (on the
 * roadmap) puts it there, so for every other step it comes from `--policy`: the console serves it
 * openly on `GET /api/zeroclaw/<loopId>?step=N`, and it is held to the Genesis like anything else.
 */
export async function stepPosture(
  chain: InferenceChain,
  agentId: Uint8Array,
  seq: bigint | number | string,
  opts: StepPostureOptions = {}
): Promise<{ report: Omit<BinaryAuditReport, "verdict" | "notes">; notes: string[] }> {
  const want = BigInt(seq);
  const report: Omit<BinaryAuditReport, "verdict" | "notes"> = {
    agentId: hex(agentId),
    seq: want.toString(),
    anchor: "unanchored",
  };
  const notes: string[] = [];
  let records;
  try {
    records = (await walkChain(chain, agentId, opts.epochs)).records;
  } catch (e) {
    notes.push(`the chain could not be read: ${(e as any)?.message ?? String(e)}`);
    return { report, notes };
  }
  const target = records.find((r) => r.seq === want);
  if (!target) notes.push(`no record at seq ${want} (a batched step needs --gateway or --epochs)`);
  else {
    const stepTool = hex(idFromString(LOOP_STEP_TOOL));
    report.record =
      target.kind === EventKind.Action && hex(target.reference) === stepTool
        ? LOOP_STEP_TOOL
        : EventKind[target.kind] ?? `kind ${target.kind}`;
  }
  const genesis = [...records].reverse().find((r) => r.seq <= want && r.kind === EventKind.Genesis);
  if (genesis) {
    report.genesisSeq = genesis.seq.toString();
    await openSessionAt(opts.store, genesis);
    const preimage = await blobAt(opts.store, genesis.payloadHash).catch(() => null);
    const pvh = preimage ? genesisPolicyVersionHash(preimage[0], preimage.slice(1)) : null;
    if (pvh) report.policyVersionHash = hex(pvh);
    else if (await encryptedAt(opts.store, genesis.payloadHash).catch(() => false)) {
      notes.push(`the Genesis payload at seq ${genesis.seq} is encrypted by the agent's owner; pass --trace-key`);
    } else if (!opts.store) {
      notes.push("no store was named, so the Genesis payload was not read; pass --gateway/--scheme or --store");
    } else notes.push(`the Genesis payload at seq ${genesis.seq} is not available here`);
  } else if (target) notes.push(`no Genesis at or before seq ${want} on this chain`);

  let doc: Uint8Array | null = null;
  if (report.policyVersionHash) {
    doc = await blobAt(opts.store, toBytes32(report.policyVersionHash)).catch(() => null);
    if (doc) report.policySource = "the store";
  }
  if (!doc && opts.policy) {
    doc = policyDocumentFrom(opts.policy.bytes);
    if (doc) report.policySource = opts.policy.source;
    else notes.push(`${opts.policy.source} holds no policy document`);
  }
  if (!doc) {
    // No document to hold it to: a posture from Irys still names the binary, as its own word.
    if (opts.postureIrys) {
      const got = postureFromIrys(opts.postureIrys.bytes, opts.postureIrys.source);
      if (got.irys) report.postureIrys = got.irys;
      if (got.posture) {
        report.posture = got.posture;
        report.published = publishedBuild(got.posture.binarySha256) ?? null;
      }
      if (got.problem) notes.push(got.problem);
    }
    if (!opts.policy) {
      notes.push(
        "the policy document is not in the store (only a gated step puts it there); pass " +
          "--policy <console url|file>, e.g. the console's /api/zeroclaw/<loopId>?step=N"
      );
    }
    return { report, notes };
  }
  const read = postureOfPolicy(doc, report.policyVersionHash);
  report.policyHash = read.policyHash;
  report.anchor = read.anchor;
  if (read.posture) {
    report.posture = read.posture;
    report.published = publishedBuild(read.posture.binarySha256) ?? null;
  }
  if (read.problem) notes.push(read.problem);
  if (opts.postureIrys) {
    const got = postureFromIrys(opts.postureIrys.bytes, opts.postureIrys.source, read.posture);
    if (got.irys) report.postureIrys = got.irys;
    if (got.problem) notes.push(got.problem);
    else if (!read.posture) {
      notes.push(`${opts.postureIrys.source} was read, but the policy document holds no posture to compare it with`);
    }
  }
  return { report, notes };
}

// ─── The node half: the checkout, the disk, the build ───────────────────────

/** The nearest directory at or above `from` that holds `zeroclaw/UPSTREAM` and `zeroclaw/patches`. */
export function findCheckout(from: string): string | null {
  let dir = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, "zeroclaw", "UPSTREAM")) && fs.existsSync(path.join(dir, "zeroclaw", "patches"))) {
      return dir;
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function readCheckout(root: string): { root: string; upstream: string; patchSet: string } {
  const zc = path.join(root, "zeroclaw");
  const upstream = (fs.readFileSync(path.join(zc, "UPSTREAM"), "utf8").split("\n")[1] ?? "").trim();
  const dir = path.join(zc, "patches");
  const patches = fs.readdirSync(dir).map((name) => ({ name, bytes: fs.readFileSync(path.join(dir, name)) }));
  return { root, upstream, patchSet: patchSetOf(patches) };
}

function sha256File(file: string): string {
  return hex(sha256(fs.readFileSync(file)));
}

/**
 * `zeroclaw/build.sh --expect <sha>`, its output streamed to stderr so `--json` stays parseable.
 * The script exits 1 both on a hash mismatch and on a patch that does not apply, so the outcome is
 * read from the `.build/zeroclaw.sha256` line it writes after a build — and only if it was written
 * during this run, so a stale line left by another run is never reported as this one.
 */
async function runBuild(root: string, expect: string): Promise<NonNullable<BinaryAuditReport["build"]>> {
  const started = Date.now();
  const script = path.join(root, "zeroclaw", "build.sh");
  const code = await new Promise<number>((resolve) => {
    const child = spawn("bash", [script, "--expect", expect], { cwd: root, stdio: ["ignore", 2, 2] });
    child.on("error", () => resolve(-1));
    child.on("close", (c) => resolve(c ?? -1));
  });
  const line = path.join(root, "zeroclaw", ".build", "zeroclaw.sha256");
  const fresh = fs.existsSync(line) && fs.statSync(line).mtimeMs >= started - 1000;
  const built = fresh ? fs.readFileSync(line, "utf8").split(/\s+/)[0] : undefined;
  if (code === 0 && built === expect) return { outcome: "match", built };
  if (built && built !== expect) return { outcome: "mismatch", built };
  return { outcome: "failed", note: `build.sh exited ${code}` };
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
}

async function readPolicySource(spec: string): Promise<{ bytes: Uint8Array; source: string }> {
  if (/^https?:\/\//.test(spec)) {
    const res = await fetch(spec);
    if (!res.ok) throw new Error(`--policy ${spec} answered ${res.status}`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), source: spec };
  }
  return { bytes: fs.readFileSync(path.resolve(spec)), source: spec };
}

/**
 * The command. `reads` is `cli.ts`'s reader plan for an agent — the chain client and the
 * `--store`/`--gateway`/`--epochs`/`--trace-key` stores every audit command shares — passed in so
 * this file needs nothing private from there. Exit `3` on bad arguments, as the others.
 */
export async function binaryCommand(
  argv: string[],
  reads: (agentId: Uint8Array) => { client: InferenceChain; opts: { store?: TraceStore; epochs?: EpochStore } } | number
): Promise<number> {
  const name = arg(argv, "name");
  const positionals = argv.filter((v, i) => !v.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
  const seqArg = name ? positionals[0] : positionals[1];
  const idArg = name ? undefined : positionals[0];
  if ((!idArg && !name) || seqArg === undefined || !/^[0-9]+$/.test(seqArg)) {
    console.error(
      "usage: lath-audit binary <agent id|--name n> <seq> [--policy <console url|file>] [--posture-irys <id>] " +
        "[--irys-gateway <url>] [--local <path>] [--build]"
    );
    return 3;
  }
  const agentId = name ? idFromString(name) : toBytes32(idArg!);
  const r = reads(agentId);
  if (typeof r === "number") return r;

  const policyArg = arg(argv, "policy");
  let policy: StepPostureOptions["policy"];
  if (policyArg) {
    try {
      policy = await readPolicySource(policyArg);
    } catch (e) {
      console.error(`--policy: ${(e as Error).message}`);
      return 3;
    }
  }
  const postureIrysId = arg(argv, "posture-irys");
  let postureIrys: StepPostureOptions["postureIrys"];
  if (postureIrysId) {
    // The gateway named, else the public one; the id is only where to look, and the bytes are held
    // to the policy's posture by hash either way.
    const url = `${(arg(argv, "irys-gateway") ?? IRYS_GATEWAY).replace(/\/+$/, "")}/${postureIrysId}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`answered ${res.status}`);
      postureIrys = { bytes: new Uint8Array(await res.arrayBuffer()), source: url };
    } catch (e) {
      console.error(`--posture-irys ${url}: ${(e as Error).message}`);
      return 3;
    }
  }
  const { report, notes } = await stepPosture(r.client, agentId, seqArg, { ...r.opts, policy, postureIrys });

  const repo = arg(argv, "repo");
  const root = repo ? path.resolve(repo) : findCheckout(process.cwd());
  report.checkout = root ? readCheckout(root) : null;

  const p = report.posture;
  const localPath = arg(argv, "local");
  if (localPath && p) {
    const file = path.resolve(localPath);
    if (fs.existsSync(file)) report.local = { path: file, sha256: sha256File(file) };
    else notes.push(`--local ${file} does not exist`);
  }
  if (argv.includes("--build") && p) {
    const host = hostTriple();
    const wants = report.published?.triple;
    const os = wrapperPlatform(p.wrapper);
    if (!root) report.build = { outcome: "skipped", note: "no zeroclaw/ checkout to build from; pass --repo" };
    else if (wants && wants !== host) {
      report.build = {
        outcome: "skipped",
        note: `the posture names a ${wants} build and this host is ${host ?? process.platform}`,
      };
    } else if (!wants && os && os !== process.platform) {
      report.build = {
        outcome: "skipped",
        note: `the posture's ${p.wrapper} wrapper runs on ${os}, this host is ${process.platform}`,
      };
    } else {
      console.error(
        `building ${p.binarySha256} with ${path.join(root, "zeroclaw", "build.sh")} (a cargo build: minutes)`
      );
      report.build = await runBuild(root, p.binarySha256);
    }
    if (report.build.outcome === "skipped") notes.push(`--build skipped: ${report.build.note}`);
  }

  const final = binaryVerdict(report, notes);
  if (argv.includes("--json")) console.log(JSON.stringify(final, null, 2));
  else for (const line of formatBinaryAudit(final)) console.log(line);
  return binaryAuditExitCode(final);
}
