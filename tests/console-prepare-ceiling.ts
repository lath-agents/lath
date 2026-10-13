import "./fixtures/trace-dir";
import { assert } from "chai";
import { cloneContext } from "../frontend/src/app/api/_lib/copy";
import { PREPARES_PER_CALLER, prepareCeiling, rateLimited } from "../frontend/src/app/api/_lib/runner";

/**
 * What the server-wide `prepare:server` ceiling costs, and what does *not* cost it.
 *
 * The ordering itself lives in the route files, and `route.ts` imports `next/server`, which
 * does not resolve outside `frontend/` — so no node-only suite can call `POST` and watch the
 * bucket move. What is testable is the half the route ordering rests on: every refusal a
 * malformed or unauthorised clone body can earn is decided by `cloneContext`, and **it does not
 * touch the server ceiling**. So the ceiling is spent only where a route calls `prepareCeiling()`
 * itself, and that call sitting below the validators (`agents/[id]/route.ts`, matching
 * `agents/route.ts`) is what makes an unauthenticated 400 free.
 *
 * The ceiling is the last of the buckets a prepare is charged: the route's per-wallet bucket,
 * then the caller's address when a trusted proxy names one (never `"local"`), then the server's —
 * all asked before any is stamped. One address cannot spend the server's hour for everybody, and
 * a refusal by one bucket spends none of the others.
 *
 * `prepareCeiling` is a process-global counter keyed on a constant string, so the exhaustion case
 * has to come last in this file: once the hour's budget is spent nothing in this process gets it
 * back. That is the shape of the attack, too — one attacker's 200 empty bodies would be every
 * honest caller's hour.
 */
describe("the prepare ceiling", () => {
  /** `LATH_PREPARES_PER_HOUR`'s default, read at module evaluation by `runner.ts`. */
  const PREPARES_PER_HOUR = Number(process.env.LATH_PREPARES_PER_HOUR ?? 200);

  const BUYER = "Ghs6xLtvzUFA6MyPtzWU7y5EtSsccu8jteLFp7S4KYSy";
  const UNKNOWN = "a".repeat(64);

  it("is not charged by anything a bad clone body is refused for", () => {
    for (let i = 0; i < 50; i++) {
      for (const p of [
        { agentId: "", source: null, wallet: BUYER, name: "n" },
        { agentId: UNKNOWN, source: null, wallet: BUYER, name: "n" },
      ]) {
        const plan = cloneContext({ ...p, ip: "local" });
        assert.property(plan, "error", `cloneContext accepted ${JSON.stringify({ ...p, source: null })}`);
      }
    }
    assert.isNull(prepareCeiling(), "an empty-body clone refusal spent one of the hour's prepares");
  });

  // One caller must not spend the server's hour for everybody. Each case below spends some of the
  // server's 200, which the exhaustion case after them finishes off.
  it("gives each trusted address a bucket of its own, refused before the server's is touched", () => {
    const ip = "198.51.100.7";
    for (let i = 0; i < PREPARES_PER_CALLER; i++) assert.isNull(prepareCeiling(ip), `prepare ${i + 1}`);
    const refused = prepareCeiling(ip);
    assert.isString(refused);
    assert.include(refused!, "from one address");
    assert.notInclude(refused!, "for this server");
    // Another address, and the server, still have their hour.
    assert.isNull(prepareCeiling("198.51.100.8"));
    assert.isNull(rateLimited("prepared transactions", "prepare:server", PREPARES_PER_HOUR));
  });

  it('gives no address bucket to "local", which is every caller when no proxy vouches for one', () => {
    // A bucket keyed on "local" would be a second server-wide ceiling, smaller than the first.
    for (let i = 0; i <= PREPARES_PER_CALLER; i++) assert.isNull(prepareCeiling("local"), `prepare ${i + 1}`);
  });

  it("asks the wallet's bucket first and stamps nothing for a request one bucket refuses", () => {
    const ip = "198.51.100.9";
    const deploys = { what: "deploys", key: "deploy:W:198.51.100.9", perHour: 2 };
    assert.isNull(prepareCeiling(ip, deploys));
    assert.isNull(prepareCeiling(ip, deploys));
    const refused = prepareCeiling(ip, deploys);
    assert.equal(refused, "rate limit: 2 deploys per hour");
    // The refused third spent nothing of the address's bucket: two stamps, not three.
    assert.isNull(rateLimited("prepared transactions", `prepare:caller:${ip}`, 3));
    assert.isString(rateLimited("prepared transactions", `prepare:caller:${ip}`, 2));
  });

  it("refuses for the whole server once the hour's prepares are spent", () => {
    // Some are already gone to the cases above; the rest of the hour is spent here.
    let refused: string | null = null;
    for (let i = 0; i < PREPARES_PER_HOUR && !refused; i++) refused = prepareCeiling();
    assert.isString(refused, `${PREPARES_PER_HOUR} prepares did not exhaust the ceiling`);
    assert.include(refused!, "prepared transactions per hour");
    assert.include(refused!, "for this server");
    // And it stays refused: the bucket is keyed on a constant, not on the caller.
    assert.isString(prepareCeiling());
    // A server at its ceiling spends nothing of a wallet's or an address's hour on the refusal.
    const deploys = { what: "deploys", key: "deploy:V:198.51.100.10", perHour: 1 };
    assert.include(prepareCeiling("198.51.100.10", deploys)!, "for this server");
    assert.isNull(rateLimited(deploys.what, deploys.key, deploys.perHour));
    assert.isNull(rateLimited("prepared transactions", "prepare:caller:198.51.100.10", 1));
  });
});
