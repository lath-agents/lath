/**
 * The Explore join (`frontend/src/lib/explore.ts`), over the rows a cluster-wide scan returns:
 * a named agent the wallet signs for, a stranger's loop this console does not run (known only by
 * its `loop.step` checkpoints), a described agent, a Playwright fixture, an unnamed header, and a
 * row its owner archived — and the fixture-name rule that orders them.
 *
 * Node-only: `explore.ts` imports `tiles.ts`, which imports nothing.
 */
import { assert } from "chai";
import {
  exploreRows,
  isFixtureName,
  searchExplore,
  sortExplore,
  viewExplore,
  ExploreRow,
} from "../frontend/src/lib/explore";
import { TileOwnerInput } from "../frontend/src/lib/tiles";

const NOW = 1_780_000_000_000;
const HOUR = 3_600_000;
const WALLET = "WalletMine111111111111111111111111111111111";

function idOf(prefix: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < prefix.length && i < 32; i++) bytes[i] = prefix.charCodeAt(i);
  return bytes;
}

function hexOf(prefix: string): string {
  return Buffer.from(idOf(prefix)).toString("hex");
}

function header(
  prefix: string,
  authority: string,
  seq: number,
  updatedAgoMs: number,
  createdAgoMs: number
): TileOwnerInput {
  return {
    state: {
      agentId: idOf(prefix),
      authority: { toBase58: () => authority },
      seq: BigInt(seq),
      createdAt: NOW - createdAgoMs,
      updatedAt: NOW - updatedAgoMs,
    },
  };
}

const headers = [
  header("mine", WALLET, 12, 3 * HOUR, 10 * HOUR),
  header("stranger-loop", "Stranger", 400, 2 * HOUR, 50 * HOUR),
  header("for-sale", "Seller", 5, 5 * HOUR, 5 * HOUR),
  header("fixture", "Bot", 3, 60_000, 60 * HOUR),
  header("nameless", "Bot", 1, 30_000, 70 * HOUR),
  header("archived", WALLET, 7, HOUR, HOUR),
];

const names = {
  [hexOf("mine")]: "research-desk",
  [hexOf("stranger-loop")]: "treasury-watch",
  [hexOf("for-sale")]: "price-reporter",
  [hexOf("fixture")]: "e2e-pub-x7jhtn",
  [hexOf("archived")]: "old-thing",
};

function build(): ExploreRow[] {
  return exploreRows({
    headers,
    // A description is what lifts a row into the first tier; the registry is the one source of it.
    registry: { agents: [{ id: hexOf("for-sale"), description: "Reports a price." }], archived: [hexOf("archived")] },
    loops: [],
    names,
    checkpointed: [hexOf("stranger-loop").toUpperCase()],
    wallet: WALLET,
    now: NOW,
  });
}

describe("explore rows", () => {
  it("drops archived rows and keeps every other header, whoever signs for it", () => {
    const ids = build().map((r) => r.agentId);
    assert.notInclude(ids, hexOf("archived"));
    assert.lengthOf(ids, 5);
  });

  it("opens on what says what it does, then bare names, fixtures and unnamed headers", () => {
    const order = build().map((r) => r.name);
    // price-reporter is described, so it leads though it wrote last of the three.
    assert.deepEqual(order.slice(0, 3), ["price-reporter", "treasury-watch", "research-desk"]);
    assert.equal(order[3], "e2e-pub-x7jhtn");
    assert.match(order[4], /^unnamed · /);
  });

  it("calls a chain with loop.step checkpoints a loop, and tags that as a chain fact", () => {
    const loop = build().find((r) => r.agentId === hexOf("stranger-loop"))!;
    assert.equal(loop.kind, "loop");
    assert.isTrue(loop.checkpointed);
    const kind = loop.fields.find((f) => f.label === "kind");
    assert.equal(kind?.source, "chain");
  });

  it("marks the wallet's own headers as signer and nobody else's", () => {
    const mine = build().filter((r) => r.mine);
    assert.deepEqual(
      mine.map((r) => r.name),
      ["research-desk"]
    );
    assert.deepEqual(mine[0].relations, ["signer"]);
    assert.equal(mine[0].testId, "explore-row");
  });

  it("counts funded agents and agents the wallet started through the console as yours", () => {
    const rows = exploreRows({
      headers,
      registry: { agents: [{ id: hexOf("for-sale"), owner: WALLET }], archived: [] },
      loops: [{ id: "loop-1", agentId: hexOf("stranger-loop"), owner: WALLET, status: "running" }],
      relations: { [hexOf("fixture").toUpperCase()]: ["funded"] },
      names,
      wallet: WALLET,
      now: NOW,
    });
    const yours = viewExplore(rows, "yours").map((r) => r.agentId);
    assert.sameMembers(yours, [
      hexOf("mine"),
      hexOf("for-sale"),
      hexOf("stranger-loop"),
      hexOf("fixture"),
      hexOf("archived"),
    ]);
    assert.deepEqual(rows.find((r) => r.agentId === hexOf("fixture"))!.relations, ["funded"]);
  });

  it("shows nothing as yours without a wallet", () => {
    const rows = exploreRows({ headers, registry: { agents: [{ id: hexOf("for-sale"), owner: WALLET }] }, now: NOW });
    assert.lengthOf(viewExplore(rows, "yours"), 0);
  });

  it("splits the wallet's rows into agents and loops, and shows nobody else's in either", () => {
    const rows = build();
    assert.deepEqual(
      viewExplore(rows, "agents").map((r) => r.name),
      ["research-desk"]
    );
    // treasury-watch is a loop on chain, but a stranger's: on chain is not yours.
    assert.lengthOf(viewExplore(rows, "loops"), 0);
  });

  it("searches name, id and authority", () => {
    const rows = build();
    assert.lengthOf(searchExplore(rows, "REPORTER"), 1);
    assert.lengthOf(
      searchExplore(rows, "seller", (r) => (r.agentId === hexOf("for-sale") ? "Seller" : undefined)),
      1
    );
  });

  it("sorts by records and by age without touching the featured order", () => {
    const rows = build();
    assert.equal(sortExplore(rows, "records")[0].name, "treasury-watch");
    assert.equal(sortExplore(rows, "newest")[0].name, "price-reporter");
    assert.equal(sortExplore(rows, "last-write")[0].unnamed, true);
    assert.deepEqual(
      sortExplore(rows, "featured").map((r) => r.agentId),
      rows.map((r) => r.agentId)
    );
  });
});

/**
 * Curated agents first, machine-named fixtures after. Explore's order uses the rule, so it is
 * pinned here. What is pinned is an ordering: a name the rule calls a
 * fixture moves down the grid and never off it.
 */
describe("isFixtureName", () => {
  /** The five agents the seed scripts publish — the names the product actually ships. */
  const SEEDED = ["slot-watcher", "fee-reporter", "chain-auditor", "balance-monitor", "web-researcher"];

  it("does not call a curated name a fixture, hyphen or not", () => {
    // The trap the rule has to avoid: every seeded name contains a hyphen, so "has a hyphen" or
    // "has a suffix" would sweep every curated row into the fixture group and invert the page.
    for (const name of SEEDED) {
      assert.isFalse(isFixtureName(name), `${name} should be curated`);
    }
  });

  it("catches the three machine prefixes", () => {
    // `e2e-` is the Playwright suite, `mv2-` and `walk-` older devnet test agents; seeds never use
    // any of the three.
    assert.isTrue(isFixtureName("e2e-pub-x7jhtn"));
    assert.isTrue(isFixtureName("mv2-0911-src"));
    assert.isTrue(isFixtureName("walk-0913-a"));
  });

  it("catches a bare six-character run suffix", () => {
    // A fixture need not carry a prefix — the suites append the run id to whatever stem they were
    // given — so the suffix shape is the second half of the rule.
    assert.isTrue(isFixtureName("publisher-yscmjf"));
    assert.isTrue(isFixtureName("seller-we8svo"));
  });

  it("is total: nothing, empty and whitespace are not fixtures", () => {
    assert.isFalse(isFixtureName(undefined));
    assert.isFalse(isFixtureName(null));
    assert.isFalse(isFixtureName(""));
    assert.isFalse(isFixtureName("   "));
  });
});
