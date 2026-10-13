/**
 * The shell lines the verify block hands a reader, as pure string builders.
 *
 * Kept apart from `verify.ts` and free of imports — no SDK, no config, no DOM — so the root
 * tsconfig can load this file and `tests/trace-routing.ts` can *run* the commands it builds
 * against real bytes. A command that is only ever read is a command nobody has checked: a
 * plaintext check printed for ciphertext hashes to nothing the chain holds.
 * `verify.ts` re-exports all three, so callers import them from `verify.ts`.
 */

/**
 * Download the bytes, hash them, compare to the number the chain carries. Two lines because
 * that is the whole argument: `curl` is not ours, `shasum` is not ours, and the expected digest
 * came off the chain. `shasum -a 256` on macOS, `sha256sum` on Linux — both are in the comment
 * rather than in a shell conditional, since this is read as much as it is run.
 *
 * Only for plaintext. The chain commits to the plaintext's hash, so for a trace written encrypted
 * this digest never matches; `lath-audit --trace-key` is the check for those.
 */
export function blobCheckCommand(url: string, expectedHex: string, file = "trace.bin"): string {
  return [
    `curl -sL "${url}" -o ${file}`,
    `shasum -a 256 ${file}   # or: sha256sum ${file}`,
    `# expect: ${expectedHex}`,
  ].join("\n");
}

/**
 * The same check for bytes that came out of a session bundle: download the bundle, walk its
 * entries, and hash each one until one hashes to the digest the chain carries.
 *
 * Why a script and not `shasum`: the chain anchored the *bundle* (`sdk/src/bundle.ts`,
 * `"LPB1" ‖ count ‖ count × (len ‖ bytes)`), not this entry, so hashing the download would prove
 * nothing about this record — the same trap `EpochVerify` explains for epochs. Pulling the entry
 * out is eight lines of `struct` and `hashlib`; `python3` is not ours any more than `curl` is,
 * and it is on every macOS and Linux a reader is likely to be at. The alternative was to point
 * at **Export verification** + `npm run verify:bundle`, and that would have been dishonest here:
 * the export carries records, roots and Merkle paths, never payload bytes, so it cannot check
 * this hash against anything. This command can, with no checkout and no key.
 */
export function bundleCheckCommand(url: string, expectedHex: string, file = "bundle.bin"): string {
  return [
    `curl -sL "${url}" -o ${file}`,
    `python3 - ${file} ${expectedHex} <<'PY'`,
    `import hashlib, struct, sys`,
    `b = open(sys.argv[1], "rb").read()`,
    `assert b[:4] == b"LPB1", "not a Lath session bundle"`,
    `n, at = struct.unpack_from("<I", b, 4)[0], 8`,
    `for i in range(n):`,
    `    l = struct.unpack_from("<I", b, at)[0]; e = b[at + 4 : at + 4 + l]; at += 4 + l`,
    `    if hashlib.sha256(e).hexdigest() == sys.argv[2]:`,
    `        print(f"entry {i} of {n}, {l} bytes, hashes to the digest the chain carries"); break`,
    `else:`,
    `    print("no entry of this bundle hashes to that digest")`,
    `PY`,
  ].join("\n");
}
