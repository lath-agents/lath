import { assert } from "chai";
import { Keypair } from "@solana/web3.js";
import { sha256, utf8 } from "../sdk/src";
import { SEED_SECRET_ENV, SEED_SECRET_MIN_LENGTH, seedKeypair, seedSecret } from "../scripts/seed";

/**
 * Seed keys must not be derivable from this repository. A `scripts/seed.ts` that derived every
 * keypair from a public label and nothing else would, on devnet, hand any reader of the repo the
 * real escrow in the *deployed* treasury, the allowance grant, and the authority of
 * `seed-agent-alpha` — to withdraw, revoke, append, or `close_agent` and burn the name for good.
 *
 * What this pins, network-free: devnet mixes in `LATH_SEED_SECRET`, the secret actually
 * changes the key, an unset or too-short secret stops the run instead of falling back, and
 * the frozen `localnet` input is bit-for-bit the public-label formula (no mode uses it, but it is a
 * derivation literal that must not move).
 *
 * The derivation is imported rather than reimplemented: a copy of the formula here would still
 * pass while the script kept the old one. Importing it is also why the script guards its
 * `main()` on `require.main === module` — the import must seed nothing.
 */

const SECRET = "test-seed-secret-0123456789abcdef";
const OTHER = "test-seed-secret-fedcba9876543210";
const LABELS = ["user", "agent-authority", "mint-authority", "admin"] as const;

/** An env with no secret in it, whatever the shell running mocha happens to export. */
const bare: NodeJS.ProcessEnv = {};
const withSecret = (secret: string): NodeJS.ProcessEnv => ({ [SEED_SECRET_ENV]: secret });

/**
 * The public-label formula, kept here only to assert the devnet keys are not derived from it. The
 * `lattice-seed-` prefix is a frozen derivation input, not the product name: the `localnet` input
 * stays byte-identical.
 */
function worldDerivable(label: string, cluster: "devnet" | "localnet"): Keypair {
  return Keypair.fromSeed(sha256(utf8(`lattice-seed-${cluster}:${label}`)).slice(0, 32));
}

describe("seed key derivation", () => {
  it("leaves localnet derivable from source, and identical to the public-label formula", () => {
    for (const label of LABELS) {
      assert.equal(
        seedKeypair(label, "localnet", bare).publicKey.toBase58(),
        worldDerivable(label, "localnet").publicKey.toBase58(),
        `localnet key for ${label} moved; the frozen literal moved`
      );
    }
    // And a secret in the environment must not silently change the localnet keys either — CI
    // could have one exported for a devnet job in the same shell.
    assert.equal(
      seedKeypair("user", "localnet", withSecret(SECRET)).publicKey.toBase58(),
      worldDerivable("user", "localnet").publicKey.toBase58()
    );
    assert.isNull(seedSecret("localnet", bare));
  });

  it("derives devnet keys that no reader of this repo can reconstruct", () => {
    for (const label of LABELS) {
      const key = seedKeypair(label, "devnet", withSecret(SECRET)).publicKey.toBase58();
      assert.notEqual(key, worldDerivable(label, "devnet").publicKey.toBase58(), `devnet ${label} is still public`);
      assert.notEqual(key, worldDerivable(label, "localnet").publicKey.toBase58());
      assert.notEqual(
        key,
        seedKeypair(label, "localnet", bare).publicKey.toBase58(),
        `devnet ${label} collides with the localnet key`
      );
    }
  });

  it("makes the secret load-bearing: a different value is a different, unfunded key", () => {
    for (const label of LABELS) {
      assert.notEqual(
        seedKeypair(label, "devnet", withSecret(SECRET)).publicKey.toBase58(),
        seedKeypair(label, "devnet", withSecret(OTHER)).publicKey.toBase58(),
        `devnet ${label} does not depend on ${SEED_SECRET_ENV}`
      );
    }
    // Deterministic for a given secret, or a rerun would seed a second set of accounts instead
    // of topping up the first — the whole reason the keys are derived and not generated.
    assert.equal(
      seedKeypair("user", "devnet", withSecret(SECRET)).publicKey.toBase58(),
      seedKeypair("user", "devnet", withSecret(SECRET)).publicKey.toBase58()
    );
    // Labels stay separated under one secret: the agent authority must never be the user.
    assert.notEqual(
      seedKeypair("user", "devnet", withSecret(SECRET)).publicKey.toBase58(),
      seedKeypair("agent-authority", "devnet", withSecret(SECRET)).publicKey.toBase58()
    );
  });

  it("fails closed on devnet when the secret is unset, empty or whitespace", () => {
    for (const env of [bare, withSecret(""), withSecret("   "), { [SEED_SECRET_ENV]: undefined }]) {
      assert.throws(() => seedSecret("devnet", env), new RegExp(SEED_SECRET_ENV));
      assert.throws(() => seedKeypair("user", "devnet", env), /must not be derivable from this repository/);
    }
  });

  it("refuses a secret short enough to guess", () => {
    const short = "a".repeat(SEED_SECRET_MIN_LENGTH - 1);
    assert.throws(() => seedSecret("devnet", withSecret(short)), /at least/);
    assert.isString(seedSecret("devnet", withSecret("b".repeat(SEED_SECRET_MIN_LENGTH))));
  });

  it("never puts the raw secret in the preimage, so an error or a dump cannot leak it", () => {
    // The secret enters as sha256(secret): appending a label-shaped tail to it must not collide
    // with the next label, which a raw `secret:label` concatenation would allow.
    const a = seedKeypair("user", "devnet", withSecret(SECRET)).publicKey.toBase58();
    const b = seedKeypair("", "devnet", withSecret(`${SECRET}:user`)).publicKey.toBase58();
    assert.notEqual(a, b);
  });
});
