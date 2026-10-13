import "./fixtures/trace-dir";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";

/**
 * The `_lib` modules load in every order a route can force, and none of them reads a binding
 * across a cycle while it is still being evaluated.
 *
 * The crash this guards against is one the rest of the console suite cannot see. If `_lib/copy.ts`
 * used an exported `COPY_TICKET_TTL_MS` as the default argument of `ticketStore`, and a module in a
 * cycle with it — `copy → templates/validate → loops → … → copy` — called `ticketStore()` at
 * module scope, then a route that pulled the chain in from the `validate` end would evaluate that
 * module while `copy.ts` was still part-way down its own imports, `COPY_TICKET_TTL_MS` would be in
 * its temporal dead zone, and **every route that loaded any of it would answer 500**:
 * `Cannot access 'COPY_TICKET_TTL_MS' before initialization`.
 *
 * What makes it worth a file of its own is that nothing else here would catch it. Each other
 * console test imports the module it is about first, which is the order that happens to work;
 * ts-mocha's resolution and webpack's differ, and the failing order is produced only by
 * `next dev` loading `api/agents/[id]/route.ts`.
 *
 * So the entry-order cases import each module *first* in its own process-visible order and use
 * something from it. **They are not what stops the regression.** Under ts-node's CJS emit the TDZ
 * never happens at all, so introducing `ttlMs: number = COPY_TICKET_TTL_MS` leaves all
 * of them green. What has teeth is the runtime guard in `ticketStore`, which turns both halves of
 * the failure (node's silent `undefined`, webpack's `ReferenceError`) into one throw at load;
 * the last case below is the one that would go red, and it is mutation-checked.
 *
 * Keep the entry-order cases anyway: they are cheap, and they would catch a genuine import-time
 * throw of any other kind.
 */

/** Each entry point a route can start the graph from, with something to touch once it is loaded. */
const ENTRIES: { name: string; load: () => unknown }[] = [
  {
    // The order that would crash: `validate` pulls `loops`, which pulls `copy` from this end.
    name: "templates/validate",
    load: () => require("../frontend/src/app/api/templates/validate").MAX_EXPIRATION_DAYS,
  },
  { name: "_lib/copy", load: () => require("../frontend/src/app/api/_lib/copy").ticketStore },
  { name: "_lib/loops", load: () => require("../frontend/src/app/api/_lib/loops").planLoopStart },
  // The scheduler's modules behind `_lib/loops.ts`, from both ends: the registry most of them import,
  // and the start every route's door reaches last.
  { name: "_lib/loop-registry", load: () => require("../frontend/src/app/api/_lib/loop-registry").readLoops },
  { name: "_lib/loop-request", load: () => require("../frontend/src/app/api/_lib/loop-request").planLoopStart },
  { name: "_lib/templates", load: () => require("../frontend/src/app/api/_lib/templates").recordTemplate },
  { name: "_lib/runner", load: () => require("../frontend/src/app/api/_lib/runner").lookupAgent },
];

describe("the _lib module graph", () => {
  // Every case here drops the `_lib` modules out of `require.cache` to force a fresh graph, which
  // would leave the fresh instances behind. Nothing is corrupted — every console file binds its
  // imports at load, before any body runs, and no `_lib` module does a call-time `require` — but
  // a later file that lazily required one would get a *second* copy of the ticket stores. The
  // prepare-ceiling maps (`recentByCaller`, `usedNonces`) live on `globalThis` and survive a
  // fresh graph, so the risk is the stores alone. Put back what was there.
  const saved = { ...require.cache };
  after(() => {
    for (const key of Object.keys(require.cache)) if (!(key in saved)) delete require.cache[key];
    Object.assign(require.cache, saved);
  });

  for (const entry of ENTRIES) {
    it(`loads with ${entry.name} as the entry point`, () => {
      // A fresh graph each time: with the modules already cached, every order is the first one.
      for (const key of Object.keys(require.cache)) {
        if (key.includes("/frontend/src/app/api/")) delete require.cache[key];
      }
      const value = entry.load();
      assert.isDefined(value, `${entry.name} evaluated to nothing, which means the cycle broke it`);
    });
  }

  it("no `_lib` module imports a value back from a module that imports it, however far round", () => {
    // The static half of the guard, and the one with teeth for `_lib/loops.ts`, which is a barrel over
    // twenty modules that call each other across files: a value import that closed a cycle among them
    // is the shape of the crash above, a binding read while its module is still evaluating, and the
    // entry-order cases would not see it under ts-node either. A type-only import is erased and closes
    // nothing: `import type`, or braces whose every name is marked `type`. A re-export is an import.
    const dir = path.join(__dirname, "../frontend/src/app/api/_lib");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
    const graph = new Map<string, string[]>();
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      const deps: string[] = [];
      for (const m of text.matchAll(/^(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s+"\.\/([^"]+)";/gms)) {
        const names = /^\{([^}]*)\}$/.exec(m[2].trim());
        const typeOnly =
          !!m[1] ||
          (!!names &&
            names[1]
              .split(",")
              .map((n) => n.trim())
              .filter(Boolean)
              .every((n) => n.startsWith("type ")));
        if (!typeOnly && files.includes(`${m[3]}.ts`)) deps.push(`${m[3]}.ts`);
      }
      graph.set(f, deps);
    }
    assert.isAbove(graph.get("loops.ts")?.length ?? 0, 10, "`_lib/loops.ts` re-exports the scheduler's modules");
    const cycles: string[] = [];
    const state = new Map<string, "open" | "done">();
    const stack: string[] = [];
    const visit = (f: string) => {
      state.set(f, "open");
      stack.push(f);
      for (const d of graph.get(f) ?? []) {
        if (state.get(d) === "open") cycles.push([...stack.slice(stack.indexOf(d)), d].join(" → "));
        else if (!state.has(d)) visit(d);
      }
      stack.pop();
      state.set(f, "done");
    };
    for (const f of files) if (!state.has(f)) visit(f);
    assert.deepEqual(cycles, [], "a value import cycle among the `_lib` modules");
  });

  it("the ticket store a module builds at load works when validate is the entry point", () => {
    // The shape of the crash: a module calls `ticketStore()` at load while the graph is still
    // evaluating, so the default argument must not be a binding from `copy.ts`'s own module scope.
    // `copy.ts`'s own clone store is such a module-scope store.
    for (const key of Object.keys(require.cache)) {
      if (key.includes("/frontend/src/app/api/")) delete require.cache[key];
    }
    require("../frontend/src/app/api/templates/validate");
    const { peekCloneTicket } = require("../frontend/src/app/api/_lib/copy");
    assert.isNull(peekCloneTicket("nothing"), "the clone ticket store is live, not a half-built module");

    const { ticketStore, COPY_TICKET_TTL_MS } = require("../frontend/src/app/api/_lib/copy");
    assert.equal(COPY_TICKET_TTL_MS, 10 * 60_000);
    const store = ticketStore();
    const id = store.issue({ what: "a ticket" });
    assert.equal(store.peek(id).what, "a ticket");
    store.spend(id);
    assert.isNull(store.peek(id));
  });

  it("refuses to build a ticket store with a TTL a cycle has not set yet", () => {
    // The actual regression guard. A default argument that reads across the cycle arrives here as
    // `undefined` under node and never arrives at all under webpack; both are a store whose
    // tickets are dead on issue, which is not a thing to find in production. Mutation-checked:
    // delete the `Number.isFinite` guard in `_lib/copy.ts` and this case goes red while the
    // entry-order cases above stay green.
    // `undefined` is not one of these: it is what a default parameter fires on, so with the
    // literal default in place `ticketStore(undefined)` is a correct ten-minute store. The
    // regression puts the cycle-read binding *in* the default position, where node hands it
    // through as `undefined` and `Number.isFinite` refuses it — which is what `NaN` stands in for
    // here, since a test cannot rebuild the cycle inside ts-node.
    const { ticketStore } = require("../frontend/src/app/api/_lib/copy");
    assert.throws(() => ticketStore(Number.NaN), /positive TTL/);
    assert.throws(() => ticketStore(0), /module cycle/);
    assert.throws(() => ticketStore(-1), /positive TTL/);
    assert.throws(() => ticketStore("600000" as unknown as number), /positive TTL/);
  });

  it("a named ticket store survives the module being evaluated again", () => {
    // What a Next recompile does between `prepare` and `confirm`: a second evaluation builds a
    // second store. A named one reads the same map off `globalThis`, so the ticket the first issued
    // is still there; an unnamed one is the old behaviour and starts empty.
    const { ticketStore } = require("../frontend/src/app/api/_lib/copy");
    const name = `test-${Date.now()}`;
    const id = ticketStore(undefined, name).issue({ wallet: "w" });
    assert.equal(ticketStore(undefined, name).peek(id)?.wallet, "w");
    assert.equal(ticketStore().peek(id), null);
  });
});
