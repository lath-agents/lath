import { decodeSourcesManifest, sourcesHash, sourcesManifestBytes } from "@lath/runtime";
import { Keypair, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as v8 from "v8";
import * as vm from "vm";
import * as zlib from "zlib";
import {
  SourcesRefused,
  checkSources,
  decodeWithIdl,
  fetchSources,
  parseGithubUrl,
  readTar,
  readTarGz,
  sourcesRefusal,
  type SourcesDeps,
  type TarStreamEntry,
} from "../frontend/src/app/api/_lib/sources";
import {
  addressProblem,
  type PinnedAddress,
  type TransportRequest,
  type TransportResponse,
} from "../frontend/src/app/api/_lib/safe-fetch";
import { LOOP_PRESETS } from "../frontend/src/lib/loop-presets";

/**
 * The sandbox-sources fetcher, on a stubbed network: every
 * request goes to `routes` below and every name to `names`, so no refusal here depends on the
 * internet and none of them opens a socket. Node-only.
 */

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "89abcdef0123456789abcdef0123456789abcdef";
const PUBLIC = "140.82.112.3";

// ─── A stubbed network ───────────────────────────────────────────────────────

type Handler = (req: TransportRequest) => {
  status: number;
  headers?: Record<string, string>;
  chunks?: Uint8Array[];
};

interface Net {
  deps: SourcesDeps;
  routes: Map<string, Handler>;
  names: Map<string, string[]>;
  seen: { url: string; pin?: PinnedAddress }[];
}

function net(rpc: Partial<SourcesDeps["rpc"]> = {}): Net {
  const routes = new Map<string, Handler>();
  const names = new Map<string, string[]>([
    ["github.com", [PUBLIC]],
    ["codeload.github.com", [PUBLIC]],
    ["docs.example.org", ["93.184.216.34"]],
  ]);
  const seen: Net["seen"] = [];
  const deps: SourcesDeps = {
    lookup: async (host) => {
      const a = names.get(host);
      if (!a) throw new Error("ENOTFOUND");
      return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    fetch: async (req): Promise<TransportResponse> => {
      const url = req.url.toString();
      seen.push({ url, pin: req.pin });
      const h = routes.get(url) ?? routes.get(`${req.url.origin}${req.url.pathname}`);
      const r = h ? h(req) : { status: 404 };
      const chunks = r.chunks ?? [];
      return {
        status: r.status,
        headers: r.headers ?? {},
        body: (async function* () {
          for (const c of chunks) yield c;
        })(),
        cancel: () => undefined,
      };
    },
    rpc: { devnet: rpc.devnet ?? "https://devnet.rpc.test/", mainnet: rpc.mainnet ?? "" },
    now: () => 1_000_000,
  };
  return { deps, routes, names, seen };
}

const text = (s: string) => new TextEncoder().encode(s);

function pkt(s: string): string {
  return (s.length + 4).toString(16).padStart(4, "0") + s;
}

function advertisement(refs: Record<string, string>): Uint8Array {
  const lines = Object.entries(refs).map(([name, sha], i) =>
    pkt(`${sha} ${name}${i === 0 ? "\0multi_ack symref=HEAD:refs/heads/main" : ""}\n`)
  );
  return new Uint8Array(Buffer.from(`${pkt("# service=git-upload-pack\n")}0000${lines.join("")}0000`, "latin1"));
}

// ─── A tarball, as codeload builds one ───────────────────────────────────────

interface TarIn {
  name: string;
  type?: string;
  body?: Uint8Array | string;
  link?: string;
}

function header(name: string, type: string, size: number, link = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write(link, 157, 100, "utf8");
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

function block(data: Buffer): Buffer {
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([data, Buffer.alloc(pad)]);
}

function tarball(entries: TarIn[], top = `v4-${COMMIT}`): Uint8Array {
  const parts: Buffer[] = [];
  // codeload opens with a pax global header carrying the commit.
  const g = Buffer.from(`52 comment=${COMMIT}\n`);
  parts.push(header("pax_global_header", "g", g.length), block(g));
  parts.push(header(`${top}/`, "5", 0));
  for (const e of entries) {
    const body = Buffer.from(typeof e.body === "string" ? e.body : e.body ?? new Uint8Array());
    const full = e.name.startsWith("/") || e.name.startsWith("..") ? e.name : `${top}/${e.name}`;
    if (Buffer.byteLength(full) > 99) {
      const rec = ` path=${full}\n`;
      let len = rec.length + 2;
      while (`${len}${rec}`.length !== len) len++;
      const pax = Buffer.from(`${len}${rec}`);
      parts.push(header("PaxHeader", "x", pax.length), block(pax));
      parts.push(header("long", e.type ?? "0", body.length, e.link));
    } else {
      parts.push(header(full, e.type ?? "0", body.length, e.link));
    }
    if (body.length) parts.push(block(body));
  }
  parts.push(Buffer.alloc(1024));
  return new Uint8Array(zlib.gzipSync(Buffer.concat(parts)));
}

function github(n: Net, entries: TarIn[], refs: Record<string, string> = { HEAD: COMMIT, "refs/heads/main": COMMIT }) {
  n.routes.set("https://github.com/Squads-Protocol/v4.git/info/refs", () => ({
    status: 200,
    headers: { "content-type": "application/x-git-upload-pack-advertisement" },
    chunks: [advertisement(refs)],
  }));
  const gz = tarball(entries);
  for (const sha of new Set(Object.values(refs))) {
    n.routes.set(`https://codeload.github.com/Squads-Protocol/v4/tar.gz/${sha}`, () => ({
      status: 200,
      headers: { "content-type": "application/x-gzip" },
      // Two chunks, and no Content-Length: the reader counts what arrives.
      chunks: [gz.subarray(0, 100), gz.subarray(100)],
    }));
  }
}

const REPO_FILES: TarIn[] = [
  { name: "README.md", body: "# Squads v4\n" },
  { name: "programs/", type: "5" },
  { name: "programs/Cargo.toml", body: "[workspace]\n" },
  { name: "programs/squads_multisig_program/src/lib.rs", body: "pub fn entry() {}\n" },
  { name: "programs/logo.png", body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) },
];

// ─── A Solana program, as the RPC answers it ─────────────────────────────────

const SQUADS = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const PROGRAM_DATA = new PublicKey(Buffer.alloc(32, 7)).toBase58();
const AUTHORITY = new PublicKey(Buffer.alloc(32, 9));
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const IDL = { address: SQUADS, metadata: { name: "squads_multisig_program" }, instructions: [] };
// The sources hashes of a tree with no authority or multisig decoding, on this stubbed network,
// for the last case of the decoding block.
const NO_SOLANA_HASH = "da4cab55ae0886ecb378ad30f61fba2a33469779b5a0d3ea45b3cc347a76359a";
const NO_IDL_HASH = "0a01d1d49dc61a7f4ec3fbb9e470cb13f63dc54584f8ed2731d428bb6220c09c";

async function idlAddress(): Promise<string> {
  const program = new PublicKey(SQUADS);
  const base = PublicKey.findProgramAddressSync([], program)[0];
  return (await PublicKey.createWithSeed(base, "anchor:idl", program)).toBase58();
}

type Accounts = Record<string, { owner: string; executable: boolean; data: Buffer }>;

/**
 * The Squads program on a stubbed RPC: the program, its programdata (upgrade authority `authority`,
 * `null` for none) and its IDL account holding `idl`. The map is returned, so a case can add the
 * accounts it reads (a multisig) and the route answers them too.
 */
async function solana(
  n: Net,
  rpc = "https://devnet.rpc.test/",
  slot = 503739376,
  opts: { authority?: PublicKey | null; idl?: unknown } = {}
): Promise<Accounts> {
  const authority = opts.authority === undefined ? AUTHORITY : opts.authority;
  const program = Buffer.alloc(36);
  program.writeUInt32LE(2, 0);
  new PublicKey(PROGRAM_DATA).toBuffer().copy(program, 4);
  const elf = Buffer.concat([Buffer.from("\x7fELF"), Buffer.alloc(60, 1)]);
  const pd = Buffer.alloc(45);
  pd.writeUInt32LE(3, 0);
  pd.writeBigUInt64LE(503000000n, 4);
  if (authority) {
    pd[12] = 1;
    authority.toBuffer().copy(pd, 13);
  }
  const payload = zlib.deflateSync(Buffer.from(JSON.stringify(opts.idl ?? IDL)));
  const idl = Buffer.alloc(44);
  idl.writeUInt32LE(payload.length, 40);
  const accounts: Accounts = {
    [SQUADS]: { owner: LOADER, executable: true, data: program },
    [PROGRAM_DATA]: { owner: LOADER, executable: false, data: Buffer.concat([pd, elf]) },
    [await idlAddress()]: { owner: SQUADS, executable: false, data: Buffer.concat([idl, payload]) },
  };
  n.routes.set(rpc, (req) => {
    const body = JSON.parse(Buffer.from(req.body!).toString("utf8"));
    const [address, opts] = body.params;
    assert.equal(body.method, "getAccountInfo");
    assert.equal(opts.commitment, "confirmed");
    const a = accounts[address];
    const value = a
      ? { owner: a.owner, executable: a.executable, lamports: 1_141_440, data: [a.data.toString("base64"), "base64"] }
      : null;
    return {
      status: 200,
      chunks: [text(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot }, value } }))],
    };
  });
  return accounts;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-sources-"));
}

async function refusal(p: Promise<unknown>): Promise<SourcesRefused> {
  try {
    await p;
  } catch (e) {
    assert.instanceOf(e, SourcesRefused);
    return e as SourcesRefused;
  }
  assert.fail("expected a refusal");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p).map((x) => `${e.name}/${x}`));
    else out.push(e.name);
  }
  return out.sort();
}

// ─── The guard ───────────────────────────────────────────────────────────────

describe("sandbox sources: the SSRF guard", () => {
  it("names every private range, in each IPv6 spelling of an IPv4 one", () => {
    for (const a of [
      "127.0.0.1",
      "10.2.3.4",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "64:ff9b::a00:1",
      "::ffff:0:7f00:1",
      "::ffff:0:127.0.0.1",
      "::ffff:0:a9fe:a9fe",
      "2002:a9fe:a9fe::1",
      "2002:7f00:1::",
      "2002:a00:1:1::1",
      "64:ff9b:1::a9fe:a9fe",
      "64:ff9b:1::169.254.169.254",
      "64:ff9b:1::7f00:1",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "2001::1",
      "fec0::1",
      "feff::1",
      "198.18.0.1",
      "198.19.255.255",
      "192.0.0.1",
      "192.0.2.1",
      "198.51.100.1",
      "203.0.113.1",
      "::ffff:198.18.0.1",
      "2002:c000:201::1",
    ]) {
      assert.isNotNull(addressProblem(a), a);
    }
    // A carrier form is judged by what it carries, so a public IPv4 inside one stays allowed, and the
    // new IPv4 blocks end where they end.
    for (const a of [
      "140.82.112.3",
      "172.32.0.1",
      "100.128.0.1",
      "2606:4700::1111",
      "::ffff:8.8.8.8",
      "::ffff:0:808:808",
      "2002:808:808::1",
      "64:ff9b:1::808:808",
      "2001:4860::8888",
      "198.17.255.255",
      "198.20.0.1",
      "192.0.1.1",
      "192.0.3.1",
      "198.51.101.1",
      "203.0.114.1",
    ]) {
      assert.isNull(addressProblem(a), a);
    }
  });

  it("refuses http:", async () => {
    const n = net();
    const e = await refusal(
      fetchSources([{ kind: "url", url: "http://docs.example.org/spec.md" }], n.deps, tmp() + "/s")
    );
    assert.equal(e.input, 1);
    assert.match(e.message, /only https:\/\/ URLs are fetched, not http:/);
    assert.lengthOf(n.seen, 0);
  });

  it("refuses a port other than 443", async () => {
    const e = await refusal(checkSources([{ kind: "url", url: "https://docs.example.org:8443/a.md" }], net().deps));
    assert.match(e.message, /only port 443 is fetched/);
  });

  it("refuses a private address, by literal and by name", async () => {
    const n = net();
    n.names.set("intranet.example.org", ["10.0.0.5"]);
    let e = await refusal(checkSources([{ kind: "url", url: "https://192.168.0.10/a.md" }], n.deps));
    assert.match(e.message, /192\.168\.0\.10, a private address \(192\.168\/16\), which is never fetched/);
    e = await refusal(checkSources([{ kind: "url", url: "https://intranet.example.org/a.md" }], n.deps));
    assert.match(e.message, /intranet\.example\.org resolves to 10\.0\.0\.5, a private address \(10\/8\)/);
    assert.lengthOf(n.seen, 0);
  });

  it("refuses a public name whose lookup also returns a private address", async () => {
    const n = net();
    n.names.set("docs.example.org", ["93.184.216.34", "::ffff:169.254.169.254"]);
    const e = await refusal(checkSources([{ kind: "url", url: "https://docs.example.org/a.md" }], n.deps));
    assert.match(
      e.message,
      /resolves to ::ffff:169\.254\.169\.254, a link-local address \(169\.254\/16\), mapped into IPv6/
    );
    assert.lengthOf(n.seen, 0);
  });

  it("connects to the address it checked, not to the name", async () => {
    const n = net();
    n.routes.set("https://docs.example.org/a.md", () => ({
      status: 200,
      headers: { "content-type": "text/markdown" },
      chunks: [text("# a\n")],
    }));
    await checkSources([{ kind: "url", url: "https://docs.example.org/a.md" }], n.deps);
    assert.deepEqual(n.seen[0].pin, { address: "93.184.216.34", family: 4 });
  });

  it("refuses a redirect to a private address", async () => {
    const n = net();
    n.names.set("metadata.example.org", ["169.254.169.254"]);
    n.routes.set("https://docs.example.org/a.md", () => ({
      status: 302,
      headers: { location: "https://metadata.example.org/latest/meta-data/" },
    }));
    const e = await refusal(checkSources([{ kind: "url", url: "https://docs.example.org/a.md" }], n.deps));
    assert.match(e.message, /metadata\.example\.org resolves to 169\.254\.169\.254, a link-local address/);
    assert.deepEqual(
      n.seen.map((s) => s.url),
      ["https://docs.example.org/a.md"]
    );
  });

  it("follows three redirects and refuses a fourth", async () => {
    const n = net();
    for (let i = 0; i < 5; i++) {
      n.routes.set(`https://docs.example.org/r${i}`, () => ({ status: 301, headers: { location: `/r${i + 1}` } }));
    }
    n.routes.set("https://docs.example.org/r3", () => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      chunks: [text("ok\n")],
    }));
    const ok = await checkSources([{ kind: "url", url: "https://docs.example.org/r0" }], n.deps);
    assert.equal((ok[0].source as { finalUrl: string }).finalUrl, "https://docs.example.org/r3");
    n.routes.delete("https://docs.example.org/r3");
    n.routes.set("https://docs.example.org/r3", () => ({ status: 301, headers: { location: "/r4" } }));
    const e = await refusal(checkSources([{ kind: "url", url: "https://docs.example.org/r0" }], n.deps));
    assert.match(e.message, /redirected more than 3 times/);
  });

  it("counts the body as it streams and refuses one over the cap with no Content-Length", async () => {
    const n = net();
    const mib = new Uint8Array(512 * 1024).fill(0x61);
    n.routes.set("https://docs.example.org/big.txt", () => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      chunks: [mib, mib, mib, mib],
    }));
    const e = await refusal(checkSources([{ kind: "url", url: "https://docs.example.org/big.txt" }], n.deps));
    assert.match(e.message, /the file is over the 1 MiB per-file cap/);
  });

  it("refuses a URL that is not text", async () => {
    const n = net();
    n.routes.set("https://docs.example.org/a.pdf", () => ({
      status: 200,
      headers: { "content-type": "application/pdf" },
      chunks: [text("%PDF")],
    }));
    const e = await refusal(checkSources([{ kind: "url", url: "https://docs.example.org/a.pdf" }], n.deps));
    assert.match(e.message, /answered application\/pdf, not plain text, JSON or markdown/);
  });

  it("refuses text/html and the rest of text/* that is not plain text or markdown, which Irys would serve as such", async () => {
    // The type answered is the type the file is served with from Irys, and a gateway renders HTML.
    for (const type of ["text/html; charset=utf-8", "text/xml", "text/javascript", "text/css"]) {
      const n = net();
      n.routes.set("https://docs.example.org/page", () => ({
        status: 200,
        headers: { "content-type": type },
        chunks: [text("<script>alert(1)</script>")],
      }));
      const e = await refusal(checkSources([{ kind: "url", url: "https://docs.example.org/page" }], n.deps));
      assert.match(e.message, /not plain text, JSON or markdown/, type);
    }
  });
});

// ─── GitHub ──────────────────────────────────────────────────────────────────

describe("sandbox sources: GitHub", () => {
  it("parses the URL strictly", () => {
    assert.deepEqual(parseGithubUrl("https://github.com/Squads-Protocol/v4"), {
      owner: "Squads-Protocol",
      repo: "v4",
      tree: null,
    });
    assert.deepEqual(parseGithubUrl("https://github.com/Squads-Protocol/v4/tree/main/programs"), {
      owner: "Squads-Protocol",
      repo: "v4",
      tree: ["main", "programs"],
    });
    for (const bad of [
      "http://github.com/a/b",
      "https://gitlab.com/a/b",
      "https://github.com/a",
      "https://github.com/a/b/blob/main/x",
      "https://github.com/a/b?tab=readme",
      "https://github.com:8443/a/b",
    ]) {
      assert.throws(() => parseGithubUrl(bad), undefined, undefined, bad);
    }
  });

  it("pins a branch to its commit, keeps the subpath's text files and counts the rest", async () => {
    const n = net();
    github(n, REPO_FILES, { HEAD: COMMIT, "refs/heads/main": COMMIT, "refs/heads/release/1.0": OTHER });
    const out = tmp() + "/sources";
    const { manifest, hash } = await fetchSources(
      [{ kind: "github", url: "https://github.com/Squads-Protocol/v4/tree/main/programs" }],
      n.deps,
      out
    );
    const [entry] = manifest.sources;
    assert.deepEqual(entry.source, {
      kind: "github",
      input: "https://github.com/Squads-Protocol/v4/tree/main/programs",
      owner: "Squads-Protocol",
      repo: "v4",
      ref: "main",
      path: "programs",
      commit: COMMIT,
    });
    assert.equal(entry.dir, "github/Squads-Protocol/v4");
    assert.deepEqual(
      entry.files.map((f) => f.path),
      [
        "github/Squads-Protocol/v4/programs/Cargo.toml",
        "github/Squads-Protocol/v4/programs/squads_multisig_program/src/lib.rs",
      ]
    );
    assert.deepEqual(entry.skipped, { files: 1, bytes: 8 });
    const lib = fs.readFileSync(
      path.join(out, "github/Squads-Protocol/v4/programs/squads_multisig_program/src/lib.rs")
    );
    assert.equal(entry.files[1].sha256, crypto.createHash("sha256").update(lib).digest("hex"));
    assert.equal(hash, sourcesHash(manifest));
    assert.deepEqual(decodeSourcesManifest(sourcesManifestBytes(manifest)), manifest);
    assert.deepEqual(walk(out), [
      "github/Squads-Protocol/v4/programs/Cargo.toml",
      "github/Squads-Protocol/v4/programs/squads_multisig_program/src/lib.rs",
    ]);
  });

  it("takes the longest ref that exists, so a branch may hold a slash", async () => {
    const n = net();
    github(n, REPO_FILES, { HEAD: COMMIT, "refs/heads/main": COMMIT, "refs/heads/release/1.0": OTHER });
    const [c] = await checkSources(
      [{ kind: "github", url: "https://github.com/Squads-Protocol/v4/tree/release/1.0/programs" }],
      n.deps
    );
    assert.include(c.source, { ref: "release/1.0", path: "programs", commit: OTHER });
    assert.equal(c.files, 2);
  });

  it("keeps only the deep subtree the protocol-audit preset names, at the paths its index lists", async () => {
    // The preset's GitHub source is the program's instructions folder, four segments
    // below the ref: the ref is still the longest branch prefix, and nothing beside the folder is kept.
    const url = (LOOP_PRESETS["protocol-audit"].sandbox.sources ?? []).flatMap((s) =>
      s.kind === "github" ? [s.url] : []
    )[0];
    assert.deepEqual(parseGithubUrl(url).tree, ["main", "programs", "squads_multisig_program", "src", "instructions"]);
    const n = net();
    github(n, [
      ...REPO_FILES,
      { name: "programs/squads_multisig_program/src/instructions/mod.rs", body: "pub mod proposal_vote;\n" },
      { name: "programs/squads_multisig_program/src/instructions/proposal_vote.rs", body: "pub fn vote() {}\n" },
      { name: "programs/squads_multisig_program/src/instructions_old.rs", body: "// beside, not under\n" },
    ]);
    const out = tmp() + "/sources";
    const { manifest } = await fetchSources([{ kind: "github", url }], n.deps, out);
    const [entry] = manifest.sources;
    assert.include(entry.source, { ref: "main", path: "programs/squads_multisig_program/src/instructions" });
    assert.deepEqual(walk(out), [
      "github/Squads-Protocol/v4/programs/squads_multisig_program/src/instructions/mod.rs",
      "github/Squads-Protocol/v4/programs/squads_multisig_program/src/instructions/proposal_vote.rs",
    ]);
  });

  it("drops symlinks and hard links, never writing or following them", async () => {
    const n = net();
    github(n, [
      ...REPO_FILES,
      { name: "programs/escape", type: "2", link: "/etc/passwd" },
      { name: "programs/hard", type: "1", link: `v4-${COMMIT}/programs/Cargo.toml` },
      { name: "programs/dev", type: "3" },
    ]);
    const out = tmp() + "/sources";
    const { manifest } = await fetchSources(
      [{ kind: "github", url: "https://github.com/Squads-Protocol/v4/tree/main/programs" }],
      n.deps,
      out
    );
    assert.notInclude(manifest.sources[0].files.map((f) => f.path).join(" "), "escape");
    assert.notInclude(walk(out).join(" "), "escape");
    assert.notInclude(walk(out).join(" "), "hard");
  });

  it("refuses a ../ path and writes nothing outside outDir", async () => {
    const n = net();
    github(n, [...REPO_FILES, { name: "programs/../../outside.txt", body: "x\n" }]);
    const parent = tmp();
    const e = await refusal(
      fetchSources([{ kind: "github", url: "https://github.com/Squads-Protocol/v4" }], n.deps, `${parent}/sources`)
    );
    assert.match(e.message, /the tarball has the path .*outside\.txt", which leaves the repository/);
    assert.deepEqual(fs.readdirSync(parent), []);
    assert.isFalse(fs.existsSync(path.join(parent, "..", "outside.txt")));
  });

  it("refuses two names that differ only in case", async () => {
    const n = net();
    github(n, [
      ...REPO_FILES,
      { name: "programs/readme.md", body: "a\n" },
      { name: "programs/README.md", body: "b\n" },
    ]);
    const e = await refusal(
      checkSources([{ kind: "github", url: "https://github.com/Squads-Protocol/v4/tree/main/programs" }], n.deps)
    );
    assert.equal(e.input, 1);
    assert.match(
      e.message,
      /programs\/README\.md and sources\/.*programs\/readme\.md differ only in case or normalisation/
    );
  });

  it("refuses a name that is not in NFC, naming the path", async () => {
    const n = net();
    github(n, [...REPO_FILES, { name: "programs/café.md", body: "a\n" }]);
    const e = await refusal(
      checkSources([{ kind: "github", url: "https://github.com/Squads-Protocol/v4/tree/main/programs" }], n.deps)
    );
    assert.match(e.message, /the file "programs\/café\.md" is refused: .* is not in Unicode NFC/);
  });

  it("refuses a repo GitHub does not serve publicly", async () => {
    const n = net();
    n.routes.set("https://github.com/Squads-Protocol/v4.git/info/refs", () => ({ status: 404 }));
    const e = await refusal(checkSources([{ kind: "github", url: "https://github.com/Squads-Protocol/v4" }], n.deps));
    assert.match(e.message, /github\.com\/Squads-Protocol\/v4 is not a public repository \(GitHub answered 404\)/);
  });

  it("refuses a ref the repo does not have, and a subpath the commit does not have", async () => {
    const n = net();
    github(n, REPO_FILES);
    let e = await refusal(
      checkSources([{ kind: "github", url: "https://github.com/Squads-Protocol/v4/tree/nope" }], n.deps)
    );
    assert.match(e.message, /has no branch or tag "nope"/);
    e = await refusal(
      checkSources([{ kind: "github", url: "https://github.com/Squads-Protocol/v4/tree/main/sdk" }], n.deps)
    );
    assert.match(e.message, /has no path "sdk" at 0123456789abcdef/);
  });
});

// ─── A static URL ────────────────────────────────────────────────────────────

describe("sandbox sources: a static URL", () => {
  it("keeps one file named for the URL's last segment, and the final URL after redirects", async () => {
    const n = net();
    n.routes.set("https://docs.example.org/spec", () => ({ status: 301, headers: { location: "/docs/spec.md" } }));
    n.routes.set("https://docs.example.org/docs/spec.md", () => ({
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8" },
      chunks: [text("# Spec\n")],
    }));
    const out = tmp() + "/sources";
    const { manifest } = await fetchSources([{ kind: "url", url: "https://docs.example.org/spec" }], n.deps, out);
    const [e] = manifest.sources;
    assert.deepEqual(e.source, {
      kind: "url",
      input: "https://docs.example.org/spec",
      finalUrl: "https://docs.example.org/docs/spec.md",
      contentType: "text/markdown",
    });
    assert.deepEqual(
      e.files.map((f) => f.path),
      ["url/docs.example.org/docs/spec.md/spec.md"]
    );
    assert.equal(fs.readFileSync(path.join(out, "url/docs.example.org/docs/spec.md/spec.md"), "utf8"), "# Spec\n");
  });
});

// ─── A Solana account ────────────────────────────────────────────────────────

describe("sandbox sources: a Solana address", () => {
  it("pins a devnet program to a slot, with its programdata and its Anchor IDL", async () => {
    const n = net();
    await solana(n);
    const out = tmp() + "/sources";
    const { manifest } = await fetchSources([{ kind: "solana", cluster: "devnet", address: SQUADS }], n.deps, out);
    const [e] = manifest.sources;
    assert.deepEqual(e.source, {
      kind: "solana",
      input: `devnet:${SQUADS}`,
      cluster: "devnet",
      address: SQUADS,
      slot: "503739376",
    });
    const dir = `solana/devnet/${SQUADS}`;
    assert.deepEqual(
      e.files.map((f) => f.path),
      [`${dir}/account.json`, `${dir}/idl.json`, `${dir}/program.json`]
    );
    const program = JSON.parse(fs.readFileSync(path.join(out, dir, "program.json"), "utf8"));
    assert.equal(program.programData, PROGRAM_DATA);
    assert.equal(program.upgradeAuthority, AUTHORITY.toBase58());
    assert.equal(program.lastDeploySlot, "503000000");
    assert.match(program.elfSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, dir, "idl.json"), "utf8")), IDL);
    const account = JSON.parse(fs.readFileSync(path.join(out, dir, "account.json"), "utf8"));
    assert.include(account, { owner: LOADER, executable: true, space: 36 });
  });

  it("refuses a mainnet address when LATH_MAINNET_RPC is unset", async () => {
    const n = net({ mainnet: "" });
    const e = await refusal(checkSources([{ kind: "solana", cluster: "mainnet", address: SQUADS }], n.deps));
    assert.match(e.message, /a mainnet address needs LATH_MAINNET_RPC on this host, and it is unset/);
    assert.lengthOf(n.seen, 0);
  });

  it("reads mainnet through LATH_MAINNET_RPC when it is set", async () => {
    const n = net({ mainnet: "https://mainnet.rpc.test/" });
    await solana(n, "https://mainnet.rpc.test/", 370000000);
    const [c] = await checkSources([{ kind: "solana", cluster: "mainnet", address: SQUADS }], n.deps);
    assert.include(c.source, { cluster: "mainnet", slot: "370000000" });
    assert.equal(c.files, 3);
  });

  it("refuses an address with no account, and one that is not base58", async () => {
    const n = net();
    await solana(n);
    let e = await refusal(
      checkSources(
        [{ kind: "solana", cluster: "devnet", address: new PublicKey(Buffer.alloc(32, 3)).toBase58() }],
        n.deps
      )
    );
    assert.match(e.message, /has no account on devnet at slot 503739376/);
    e = await refusal(checkSources([{ kind: "solana", cluster: "devnet", address: "not-an-address" }], n.deps));
    assert.match(e.message, /"not-an-address" is not a Solana address/);
  });
});

// ─── Who can upgrade, and a multisig decoded ─────────────────────────────────

/** Squads v4's `Multisig` account and the types it reads, in the pre-0.30 IDL format Squads has on chain. */
const SQUADS_LEGACY_IDL = {
  version: "2.1.0",
  name: "squads_multisig_program",
  instructions: [],
  accounts: [
    {
      name: "Multisig",
      type: {
        kind: "struct",
        fields: [
          { name: "createKey", type: "publicKey" },
          { name: "configAuthority", type: "publicKey" },
          { name: "threshold", type: "u16" },
          { name: "timeLock", type: "u32" },
          { name: "transactionIndex", type: "u64" },
          { name: "staleTransactionIndex", type: "u64" },
          { name: "rentCollector", type: { option: "publicKey" } },
          { name: "bump", type: "u8" },
          { name: "members", type: { vec: { defined: "Member" } } },
        ],
      },
    },
    {
      // A second account with an enum, so the conversion builds more than the one it decodes.
      name: "SpendingLimit",
      type: {
        kind: "struct",
        fields: [
          { name: "multisig", type: "publicKey" },
          { name: "period", type: { defined: "Period" } },
          { name: "destinations", type: { vec: "publicKey" } },
        ],
      },
    },
  ],
  types: [
    {
      name: "Member",
      type: {
        kind: "struct",
        fields: [
          { name: "key", type: "publicKey" },
          { name: "permissions", type: { defined: "Permissions" } },
        ],
      },
    },
    { name: "Permissions", type: { kind: "struct", fields: [{ name: "mask", type: "u8" }] } },
    { name: "Period", type: { kind: "enum", variants: [{ name: "OneTime" }, { name: "Day" }, { name: "Week" }] } },
  ],
};

function discriminator(name: string): Buffer {
  return crypto.createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

/** The same `Multisig` in the 0.30 format (`metadata.spec`, explicit discriminators, snake_case), read as it is. */
const SQUADS_IDL_030 = {
  address: SQUADS,
  metadata: { name: "squads_multisig_program", version: "2.1.0", spec: "0.1.0" },
  instructions: [],
  accounts: [{ name: "Multisig", discriminator: [...discriminator("Multisig")] }],
  types: [
    {
      name: "Multisig",
      type: {
        kind: "struct",
        fields: [
          { name: "create_key", type: "pubkey" },
          { name: "config_authority", type: "pubkey" },
          { name: "threshold", type: "u16" },
          { name: "time_lock", type: "u32" },
          { name: "transaction_index", type: "u64" },
          { name: "stale_transaction_index", type: "u64" },
          { name: "rent_collector", type: { option: "pubkey" } },
          { name: "bump", type: "u8" },
          { name: "members", type: { vec: { defined: { name: "Member" } } } },
        ],
      },
    },
    {
      name: "Member",
      type: {
        kind: "struct",
        fields: [
          { name: "key", type: "pubkey" },
          { name: "permissions", type: { defined: { name: "Permissions" } } },
        ],
      },
    },
    { name: "Permissions", type: { kind: "struct", fields: [{ name: "mask", type: "u8" }] } },
  ],
};

const CREATE_KEY = new PublicKey(Buffer.alloc(32, 21));
const MULTISIG = PublicKey.findProgramAddressSync(
  [Buffer.from("multisig"), Buffer.from("multisig"), CREATE_KEY.toBuffer()],
  new PublicKey(SQUADS)
)[0];
/** Squads' vault 0 of that multisig: a PDA, so off the curve. */
const VAULT = PublicKey.findProgramAddressSync(
  [Buffer.from("multisig"), MULTISIG.toBuffer(), Buffer.from("vault"), Buffer.from([0])],
  new PublicKey(SQUADS)
)[0];
const MEMBERS = [11, 12, 13].map((b) => Keypair.fromSeed(Buffer.alloc(32, b)).publicKey);
/** A presenter's key, as `solana-keygen` makes one: on the curve. */
const PRESENTER = Keypair.fromSeed(Buffer.alloc(32, 1)).publicKey;

/** A 2-of-3 `Multisig` as Squads lays it out: discriminator, then the fields in order, then unused space. */
function multisigData(): Buffer {
  const u16 = Buffer.alloc(2);
  u16.writeUInt16LE(2);
  const u32 = Buffer.alloc(4);
  const txIndex = Buffer.alloc(8);
  txIndex.writeBigUInt64LE(5n);
  const stale = Buffer.alloc(8);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(MEMBERS.length);
  return Buffer.concat([
    discriminator("Multisig"),
    CREATE_KEY.toBuffer(),
    Buffer.alloc(32), // config authority: the default key, an autonomous multisig
    u16,
    u32,
    txIndex,
    stale,
    Buffer.from([0]), // rent collector: None
    Buffer.from([254]),
    len,
    ...MEMBERS.map((m) => Buffer.concat([m.toBuffer(), Buffer.from([7])])),
    Buffer.alloc(64), // the room Squads reallocs for more members
  ]);
}

async function fetchOne(n: Net, address: string) {
  const out = tmp() + "/sources";
  const r = await fetchSources([{ kind: "solana", cluster: "devnet", address }], n.deps, out);
  const dir = `solana/devnet/${address}`;
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(out, dir, name), "utf8"));
  return { ...r, out, dir, read, entry: r.manifest.sources[0] };
}

describe("sandbox sources: who can upgrade, and a multisig decoded", () => {
  it("says authorityKind none, keypair or pda from the programdata's authority", async () => {
    for (const [authority, kind] of [
      [null, "none"],
      [PRESENTER, "keypair"],
      [VAULT, "pda"],
    ] as const) {
      assert.equal(PublicKey.isOnCurve(VAULT.toBytes()), false);
      const n = net();
      await solana(n, undefined, undefined, { authority });
      const { read } = await fetchOne(n, SQUADS);
      const program = read("program.json");
      assert.equal(program.upgradeAuthority, authority ? authority.toBase58() : null, kind);
      assert.equal(program.authorityKind, kind);
    }
  });

  it("decodes a Squads-shaped multisig with its owner's legacy IDL, text under the cap", async () => {
    const n = net();
    const accounts = await solana(n, undefined, undefined, { idl: SQUADS_LEGACY_IDL });
    accounts[MULTISIG.toBase58()] = { owner: SQUADS, executable: false, data: multisigData() };
    const { entry, dir, read } = await fetchOne(n, MULTISIG.toBase58());
    assert.deepEqual(
      entry.files.map((f) => f.path),
      [`${dir}/account.json`, `${dir}/decoded.json`]
    );
    assert.notProperty(entry, "skipped");
    const decoded = read("decoded.json");
    assert.deepEqual(decoded, {
      accountType: "Multisig",
      address: MULTISIG.toBase58(),
      data: {
        bump: 254,
        configAuthority: "11111111111111111111111111111111",
        createKey: CREATE_KEY.toBase58(),
        members: MEMBERS.map((m) => ({ key: m.toBase58(), permissions: { mask: 7 } })),
        rentCollector: null,
        staleTransactionIndex: "0",
        threshold: 2,
        timeLock: 0,
        transactionIndex: "5",
      },
      idl: await idlAddress(),
      idlSpec: "legacy",
      owner: SQUADS,
    });
    const size = entry.files.find((f) => f.path.endsWith("decoded.json"))!.size;
    assert.isBelow(size, 1024 * 1024);
  });

  it("decodes the same multisig with a 0.30 IDL, as the IDL names its fields", async () => {
    const n = net();
    const accounts = await solana(n, undefined, undefined, { idl: SQUADS_IDL_030 });
    accounts[MULTISIG.toBase58()] = { owner: SQUADS, executable: false, data: multisigData() };
    const { read } = await fetchOne(n, MULTISIG.toBase58());
    const decoded = read("decoded.json");
    assert.equal(decoded.idlSpec, "0.1.0");
    assert.equal(decoded.data.threshold, 2);
    assert.equal(decoded.data.create_key, CREATE_KEY.toBase58());
    assert.lengthOf(decoded.data.members, 3);
  });

  it("writes no decoded.json for an account whose owner has no IDL, and says nothing is missing", async () => {
    const n = net();
    const accounts = await solana(n);
    const owner = new PublicKey(Buffer.alloc(32, 5)).toBase58();
    const plainAccount = new PublicKey(Buffer.alloc(32, 6)).toBase58();
    accounts[plainAccount] = { owner, executable: false, data: multisigData() };
    const { entry, dir } = await fetchOne(n, plainAccount);
    assert.deepEqual(
      entry.files.map((f) => f.path),
      [`${dir}/account.json`]
    );
    assert.notProperty(entry, "skipped");
  });

  it("writes no decoded.json when the decode fails, and names why in the manifest's skipped list", async () => {
    const n = net();
    const accounts = await solana(n, undefined, undefined, { idl: SQUADS_LEGACY_IDL });
    const unknown = new PublicKey(Buffer.alloc(32, 31)).toBase58();
    accounts[unknown] = {
      owner: SQUADS,
      executable: false,
      data: Buffer.concat([discriminator("Proposal"), Buffer.alloc(40)]),
    };
    const short = new PublicKey(Buffer.alloc(32, 32)).toBase58();
    const shortData = multisigData().subarray(0, 50);
    accounts[short] = { owner: SQUADS, executable: false, data: shortData };

    let r = await fetchOne(n, unknown);
    assert.deepEqual(
      r.entry.files.map((f) => f.path),
      [`${r.dir}/account.json`]
    );
    assert.deepEqual(r.entry.skipped, {
      files: 1,
      bytes: 48,
      reasons: [
        `${
          r.dir
        }/decoded.json: no account type in the owner's IDL (${await idlAddress()}) has this account's discriminator`,
      ],
    } as never);

    r = await fetchOne(n, short);
    assert.notInclude(walk(r.out), `solana/devnet/${short}/decoded.json`);
    const skipped = r.entry.skipped as unknown as { files: number; bytes: number; reasons: string[] };
    assert.deepInclude(skipped, { files: 1, bytes: 50 });
    assert.lengthOf(skipped.reasons, 1);
    assert.match(skipped.reasons[0], /decoded\.json: the owner's IDL \(\w+\) does not decode it: /);

    // The reasons are part of the manifest the posture commits: it decodes and re-hashes as it was.
    const again = decodeSourcesManifest(sourcesManifestBytes(r.manifest));
    assert.isNotNull(again);
    assert.equal(sourcesHash(again!), r.hash);
  });

  it("skips, quickly and in the manifest, an owner IDL whose decode is unbounded, at fetch and at re-read", async () => {
    // Whoever holds a program's IDL authority writes its IDL, and the coder does what it says
    // synchronously: a vec of an empty struct loops its u32 length without reading a byte, an array its
    // declared length, and a type named three times per level is built 3^levels times before a byte is
    // read. Any of them, unguarded, is a heap OOM that aborts the console from an unsigned check.
    const empty = { name: "Empty", type: { kind: "struct", fields: [] } };
    const legacyBomb = {
      version: "0.1.0",
      name: "bomb",
      instructions: [],
      accounts: [
        { name: "Bomb", type: { kind: "struct", fields: [{ name: "v", type: { vec: { defined: "Empty" } } }] } },
      ],
      types: [empty],
    };
    const count = Buffer.alloc(4);
    count.writeUInt32LE(0xffffffff);
    const spec030 = (types: unknown[]) => ({
      address: SQUADS,
      metadata: { name: "bomb", version: "0.1.0", spec: "0.1.0" },
      instructions: [],
      accounts: [{ name: "Bomb", discriminator: [...discriminator("Bomb")] }],
      types,
    });
    const arrayBomb = spec030([
      {
        name: "Bomb",
        type: { kind: "struct", fields: [{ name: "v", type: { array: [{ defined: { name: "Empty" } }, 2_000_000] } }] },
      },
      { name: "Empty", type: { kind: "struct" } },
    ]);
    const tripling = spec030([
      { name: "Bomb", type: { kind: "struct", fields: [{ name: "t", type: { defined: { name: "T0" } } }] } },
      ...Array.from({ length: 11 }, (_, i) => ({
        name: `T${i}`,
        type: {
          kind: "struct",
          fields: ["a", "b", "c"].map((name) => ({ name, type: { defined: { name: `T${i + 1}` } } })),
        },
      })),
      { name: "T11", type: { kind: "struct", fields: [{ name: "x", type: "u8" }] } },
    ]);
    const recursive = spec030([
      {
        name: "Bomb",
        type: { kind: "struct", fields: [{ name: "next", type: { option: { defined: { name: "Bomb" } } } }] },
      },
    ]);
    const cases: [string, unknown, Buffer, RegExp][] = [
      [
        "a legacy vec of an empty struct, 2^32 - 1 long",
        legacyBomb,
        Buffer.concat([discriminator("Bomb"), count]),
        /a vec or array of a type that encodes in zero bytes/,
      ],
      [
        "a 0.30 array of two million empty structs",
        arrayBomb,
        discriminator("Bomb"),
        /a vec or array of a type that encodes in zero bytes/,
      ],
      [
        "a type built 3^11 times",
        tripling,
        Buffer.concat([discriminator("Bomb"), Buffer.alloc(64)]),
        /takes more than 50000 layouts and lookups to build/,
      ],
      [
        "a type that contains itself",
        recursive,
        Buffer.concat([discriminator("Bomb"), Buffer.from([1, 1, 0])]),
        /has a type that contains itself/,
      ],
    ];
    for (const [label, idl, data, why] of cases) {
      const n = net();
      const accounts = await solana(n, undefined, undefined, { idl });
      const address = new PublicKey(Buffer.alloc(32, 41)).toBase58();
      accounts[address] = { owner: SQUADS, executable: false, data };
      const started = Date.now();
      const r = await fetchOne(n, address);
      assert.isBelow(Date.now() - started, 100, label);
      assert.deepEqual(
        r.entry.files.map((f) => f.path),
        [`${r.dir}/account.json`],
        label
      );
      const skipped = r.entry.skipped as unknown as { reasons: string[] };
      assert.lengthOf(skipped.reasons, 1, label);
      assert.match(skipped.reasons[0], /decoded\.json: the owner's IDL \(\w+\) /, label);
      assert.match(skipped.reasons[0], why, label);

      // The per-step re-read decodes through the same function, so a bomb swapped in after the pin
      // is the same skip there.
      const t0 = Date.now();
      const again = decodeWithIdl(idl, "IdlAddress", SQUADS, data);
      assert.isBelow(Date.now() - t0, 100, label);
      assert.equal(again.kind, "skip", label);
    }
  });

  it("still decodes an account whose cost is bounded by its data, and skips one whose data would make it too long", () => {
    const vecOf = (n: number) => {
      const len = Buffer.alloc(4);
      len.writeUInt32LE(n);
      return Buffer.concat([discriminator("Holders"), len, Buffer.alloc(n * 32, 3)]);
    };
    const idl = {
      address: SQUADS,
      metadata: { name: "holders", version: "0.1.0", spec: "0.1.0" },
      instructions: [],
      accounts: [{ name: "Holders", discriminator: [...discriminator("Holders")] }],
      types: [{ name: "Holders", type: { kind: "struct", fields: [{ name: "keys", type: { vec: "pubkey" } }] } }],
    };
    const small = decodeWithIdl(idl, "IdlAddress", SQUADS, vecOf(100));
    assert.equal(small.kind, "decoded");
    assert.lengthOf((small as { value: { keys: string[] } }).value.keys, 100);
    // Three hundred thousand keys is 9.6 MB of account and seconds of base58: refused on its size.
    const big = decodeWithIdl(idl, "IdlAddress", SQUADS, vecOf(300_000));
    assert.equal(big.kind, "skip");
    assert.match(
      (big as { why: string }).why,
      /could take more than 2000000 reads to decode this account's 9600012 bytes/
    );
  });

  it("hashes a loop with no Solana source, and a Solana account with no IDL, exactly as without the decoding", async () => {
    // Pinned from a tree with no authority or multisig decoding on this stubbed network: the
    // decoding only adds files and fields to what a program or an IDL-owned account yields, so
    // neither of these may move.
    const n = net();
    const accounts = await solana(n);
    github(n, REPO_FILES);
    n.routes.set("https://docs.example.org/spec.md", () => ({
      status: 200,
      headers: { "content-type": "text/markdown" },
      chunks: [text("# Spec\n")],
    }));
    const noSolana = [
      { kind: "github", url: "https://github.com/Squads-Protocol/v4/tree/main/programs" },
      { kind: "url", url: "https://docs.example.org/spec.md" },
    ];
    const a = await fetchSources(noSolana, n.deps, tmp() + "/sources");
    assert.equal(a.hash, NO_SOLANA_HASH);

    const plainAccount = new PublicKey(Buffer.alloc(32, 6)).toBase58();
    accounts[plainAccount] = {
      owner: new PublicKey(Buffer.alloc(32, 5)).toBase58(),
      executable: false,
      data: multisigData(),
    };
    const b = await fetchSources(
      [...noSolana, { kind: "solana", cluster: "devnet", address: plainAccount }],
      n.deps,
      tmp() + "/sources"
    );
    assert.equal(b.hash, NO_IDL_HASH);
  });
});

// ─── The whole list ──────────────────────────────────────────────────────────

describe("sandbox sources: all or nothing", () => {
  function three(n: Net) {
    github(n, REPO_FILES);
    n.routes.set("https://docs.example.org/spec.md", () => ({
      status: 200,
      headers: { "content-type": "text/markdown" },
      chunks: [text("# Spec\n")],
    }));
    return [
      { kind: "github", url: "https://github.com/Squads-Protocol/v4/tree/main/programs" },
      { kind: "solana", cluster: "devnet", address: SQUADS },
      { kind: "url", url: "https://docs.example.org/spec.md" },
    ];
  }

  it("leaves no staging directory, and no outDir, when the third source fails", async () => {
    const n = net();
    await solana(n);
    const inputs = three(n);
    n.routes.set("https://docs.example.org/spec.md", () => ({ status: 500 }));
    const parent = tmp();
    const e = await refusal(fetchSources(inputs, n.deps, `${parent}/sources`));
    assert.equal(e.input, 3);
    assert.match(e.message, /^source 3: https:\/\/docs\.example\.org\/spec\.md: docs\.example\.org answered 500/);
    assert.deepEqual(fs.readdirSync(parent), []);
    assert.deepEqual(sourcesRefusal(e), { ok: false, error: e.message, input: 3 });
  });

  it("gives the same hash for two fetches of the same inputs, and check counts what fetch keeps", async () => {
    const n = net();
    await solana(n);
    const inputs = three(n);
    const a = await fetchSources(inputs, n.deps, tmp() + "/sources");
    const b = await fetchSources(inputs, n.deps, tmp() + "/sources");
    assert.equal(a.hash, b.hash);
    assert.deepEqual(
      a.manifest.sources.map((s) => s.source.kind),
      ["github", "solana", "url"]
    );
    const checked = await checkSources(inputs, n.deps);
    assert.deepEqual(
      checked.map((c) => c.files),
      a.manifest.sources.map((s) => s.files.length)
    );
  });

  it("refuses sources whose index would not fit a step's message, at check and at fetch, naming the repo", async () => {
    // 1 500 small text files: under the 2 000-file and byte caps, but ~130 bytes of index each is
    // well over SOURCES_INDEX_MAX_BYTES, so the sandbox could not open a step with them.
    const many: TarIn[] = Array.from({ length: 1500 }, (_, i) => ({
      name: `programs/src/f${String(i).padStart(4, "0")}.rs`,
      body: `// ${i}\n`,
    }));
    const n = net();
    github(n, many);
    n.routes.set("https://docs.example.org/spec.md", () => ({
      status: 200,
      headers: { "content-type": "text/markdown" },
      chunks: [text("# Spec\n")],
    }));
    const inputs = [
      { kind: "url", url: "https://docs.example.org/spec.md" },
      { kind: "github", url: "https://github.com/Squads-Protocol/v4" },
    ];
    let e = await refusal(checkSources(inputs, n.deps));
    assert.equal(e.input, 2);
    assert.match(e.message, /^source 2: https:\/\/github\.com\/Squads-Protocol\/v4: the sources' index is \d+ bytes/);
    assert.match(e.message, /over the 98304/);
    assert.match(e.message, /with 1500 of the index's files; narrow it to a subpath \(.*\/tree\/<ref>\/<path>\)$/);
    const parent = tmp();
    e = await refusal(fetchSources(inputs, n.deps, `${parent}/sources`));
    assert.equal(e.input, 2);
    assert.deepEqual(fs.readdirSync(parent), []);
  });

  it("refuses more than eight sources, and a row that is not a source", async () => {
    const nine = Array.from({ length: 9 }, () => ({ kind: "url", url: "https://docs.example.org/a.md" }));
    let e = await refusal(checkSources(nine, net().deps));
    assert.match(e.message, /at most 8 sources, not 9/);
    e = await refusal(checkSources([{ kind: "ftp", url: "x" }], net().deps));
    assert.equal(e.input, 1);
  });

  it("reads a tarball's pax path, and nothing but files and directories", () => {
    const long = `programs/${"d".repeat(120)}/x.rs`;
    const gz = tarball([
      { name: long, body: "x\n" },
      { name: "l", type: "2", link: "x" },
    ]);
    const entries = [...readTar(zlib.gunzipSync(gz))];
    assert.deepEqual(
      entries.map((e) => [e.path, e.kind]),
      [
        [`v4-${COMMIT}`, "dir"],
        [`v4-${COMMIT}/${long}`, "file"],
        [`v4-${COMMIT}/l`, "other"],
      ]
    );
  });
});

// ─── What a tarball costs to read ────────────────────────────────────────────

describe("sandbox sources: a tarball read as it inflates", () => {
  // A forced collection, so what is measured is what is still referenced. `--expose-gc` cannot be
  // passed through ts-mocha; the flag set at run time and `gc` taken from a fresh context is the
  // same function.
  v8.setFlagsFromString("--expose_gc");
  const gc = vm.runInNewContext("gc") as () => void;
  const retained = () => {
    gc();
    return process.memoryUsage().arrayBuffers;
  };

  it("reads entry for entry what readTar reads, data only where asked, each kept file its own copy", async () => {
    const long = `programs/${"d".repeat(120)}/x.rs`;
    const gz = tarball([
      { name: long, body: "x\n" },
      { name: "programs/a.rs", body: "fn a() {}\n" },
      { name: "l", type: "2", link: "x" },
    ]);
    const whole = [...readTar(zlib.gunzipSync(gz))];
    const streamed: TarStreamEntry[] = [];
    for await (const e of readTarGz(gz, (e) => e.path.endsWith("a.rs"))) streamed.push(e);
    assert.deepEqual(
      streamed.map((e) => [e.path, e.kind, e.type, e.size]),
      whole.map((e) => [e.path, e.kind, e.type, e.data.length])
    );
    const kept = streamed.filter((e) => e.data !== null);
    assert.deepEqual(
      kept.map((e) => e.path),
      [`v4-${COMMIT}/programs/a.rs`]
    );
    assert.equal(Buffer.from(kept[0].data!).toString(), "fn a() {}\n");
    // Not a view into a larger buffer: keeping it keeps ten bytes, not the stream's chunk.
    assert.equal(kept[0].data!.buffer.byteLength, kept[0].data!.byteLength);
  });

  it("refuses a tarball that is not gzip, as before", async () => {
    const n = net();
    github(n, REPO_FILES);
    n.routes.set(`https://codeload.github.com/Squads-Protocol/v4/tar.gz/${COMMIT}`, () => ({
      status: 200,
      chunks: [text("not a tarball at all")],
    }));
    const e = await refusal(checkSources([{ kind: "github", url: "https://github.com/Squads-Protocol/v4" }], n.deps));
    assert.match(e.message, /the repository's tarball is not gzip/);
  });

  it("holds no tarball after its walk, across four GitHub sources each inflating 96 MiB", async function () {
    this.timeout(120_000);
    // Each source keeps one 6-byte file and skips a 96 MiB one over the per-file cap. Inflated whole
    // and kept as a view, every tarball would stay referenced until the last source was fetched:
    // ~288 MiB held at the fourth fetch here, ~2 GiB for eight sources of the real 256 MiB cap, per request.
    const n = net();
    github(n, [
      { name: "big.bin", body: Buffer.alloc(96 * 1024 * 1024) },
      ...["a", "b", "c", "d"].map((d) => ({ name: `${d}/x.txt`, body: "hello\n" })),
    ]);
    const tarballRoute = `https://codeload.github.com/Squads-Protocol/v4/tar.gz/${COMMIT}`;
    const serve = n.routes.get(tarballRoute)!;
    const base = retained();
    const atFetch: number[] = [];
    n.routes.set(tarballRoute, (req) => {
      atFetch.push(retained() - base);
      return serve(req);
    });
    const inputs = ["a", "b", "c", "d"].map((d) => ({
      kind: "github",
      url: `https://github.com/Squads-Protocol/v4/tree/main/${d}`,
    }));
    const checked = await checkSources(inputs, n.deps);
    assert.deepEqual(
      checked.map((c) => c.files),
      [1, 1, 1, 1]
    );
    assert.lengthOf(atFetch, 4);
    const MiB = 1024 * 1024;
    for (const [i, held] of atFetch.entries()) {
      assert.isBelow(held, 32 * MiB, `held ${Math.round(held / MiB)} MiB when source ${i + 1} was fetched`);
    }
    assert.isBelow(retained() - base, 32 * MiB);
  });

  it("refuses one source listed twice before fetching anything", async () => {
    const n = net();
    github(n, REPO_FILES);
    const e = await refusal(
      checkSources(
        [
          { kind: "github", url: "https://github.com/Squads-Protocol/v4/tree/main/programs" },
          { kind: "url", url: "https://docs.example.org/spec.md" },
          { kind: "github", url: " https://github.com/Squads-Protocol/v4/tree/main/programs " },
        ],
        n.deps
      )
    );
    assert.equal(e.input, 3);
    assert.match(e.message, /^source 3: is source 1 again$/);
    assert.deepEqual(n.seen, [], "nothing is fetched for a list refused on its face");
    const twice = [
      { kind: "solana", cluster: "devnet", address: SQUADS },
      { kind: "solana", cluster: "devnet", address: SQUADS },
    ];
    assert.match((await refusal(checkSources(twice, n.deps))).message, /^source 2: is source 1 again$/);
    // The same address on the other cluster is another account.
    await solana(n);
    await solana(n, "https://mainnet.rpc.test/");
    const both = await checkSources(
      [twice[0], { kind: "solana", cluster: "mainnet", address: SQUADS }],
      net({ mainnet: "https://mainnet.rpc.test/" }).deps
    ).catch((err) => err);
    // Refused or not for its own reasons (this net has no routes), but never as a duplicate.
    assert.notMatch(String((both as Error).message ?? ""), /again/);
  });
});
