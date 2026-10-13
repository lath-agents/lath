/**
 * Which stops read as grey, and where _Run again_ is offered: a `tempo-key-*` stop is the loop's Tempo cap working, not a
 * fault, and _Run again_ belongs to a stopped run only.
 *
 * `LoopSpine.tsx` and `LoopList.tsx` are client components behind the `@/` alias and JSX, which the
 * root tsconfig does not load, so this reads their source with the TypeScript parser and pins the
 * two facts the badge, the node and the button rest on: the literal set `NEUTRAL_STOPS` and the
 * badge's labels cover every `tempo-key-*` code `LOOP_STOP_REASON_TEXT` words (a fifth one added
 * there fails here until it is drawn), and `RunAgainButton` returns nothing on a run that is not
 * stopped, beside the guards it already had. Node-only, no network.
 */
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { LOOP_STOP_REASON_TEXT } from "../frontend/src/types/loop";

const COMPONENTS = path.join(__dirname, "..", "frontend", "src", "components");

function parse(file: string): ts.SourceFile {
  const full = path.join(COMPONENTS, file);
  return ts.createSourceFile(full, fs.readFileSync(full, "utf8"), ts.ScriptTarget.ES2020, true, ts.ScriptKind.TSX);
}

/** The first node under `root` that `pick` accepts, depth first. */
function find<T extends ts.Node>(root: ts.Node, pick: (n: ts.Node) => n is T): T | undefined {
  let hit: T | undefined;
  const visit = (n: ts.Node) => {
    if (hit) return;
    if (pick(n)) hit = n;
    else ts.forEachChild(n, visit);
  };
  visit(root);
  return hit;
}

function declaration(src: ts.SourceFile, name: string): ts.VariableDeclaration {
  const d = find(src, (n): n is ts.VariableDeclaration => ts.isVariableDeclaration(n) && n.name.getText(src) === name);
  assert.exists(d, `${src.fileName} declares ${name}`);
  return d!;
}

/** The strings of `new Set([...])`. */
function setLiteral(src: ts.SourceFile, name: string): string[] {
  const init = declaration(src, name).initializer;
  assert.isTrue(!!init && ts.isNewExpression(init), `${name} is a new Set([...])`);
  const array = (init as ts.NewExpression).arguments?.[0];
  assert.isTrue(!!array && ts.isArrayLiteralExpression(array), `${name}'s members are a literal array`);
  return (array as ts.ArrayLiteralExpression).elements.map((e) => {
    assert.isTrue(ts.isStringLiteral(e), `${name} holds string literals only`);
    return (e as ts.StringLiteral).text;
  });
}

/** The keys of an object literal. */
function objectKeys(src: ts.SourceFile, name: string): string[] {
  const init = declaration(src, name).initializer;
  assert.isTrue(!!init && ts.isObjectLiteralExpression(init), `${name} is an object literal`);
  return (init as ts.ObjectLiteralExpression).properties.map((p) => {
    const n = (p as ts.PropertyAssignment).name;
    return ts.isStringLiteral(n) || ts.isIdentifier(n) ? n.text : n.getText(src);
  });
}

const KEY_STOPS = Object.keys(LOOP_STOP_REASON_TEXT).filter((r) => r.startsWith("tempo-key-"));

describe("a tempo-key stop is neutral, in the node and the badge", () => {
  const spine = parse("LoopSpine.tsx");
  const list = parse("LoopList.tsx");

  it("names the four stops a loop's Tempo key causes", () => {
    assert.sameMembers(KEY_STOPS, ["tempo-key-limit", "tempo-key-expired", "tempo-key-missing", "tempo-key-refused"]);
  });

  it("draws every tempo-key stop grey on the spine, and keeps the stops that are faults rose", () => {
    const neutral = setLiteral(spine, "NEUTRAL_STOPS");
    for (const r of [...KEY_STOPS, "max-steps", "stopped", "budget"]) assert.include(neutral, r);
    // The endings that are failures, or owe writes, stay out of it.
    for (const r of ["anchor-failed", "anchor-discarded", "escalated", "trace-flagged"]) assert.notInclude(neutral, r);
  });

  it("words every tempo-key stop in the badge, neutral, rather than as stopped: <code>", () => {
    assert.sameMembers(objectKeys(list, "TEMPO_KEY_STOP_LABEL"), KEY_STOPS);
    const badge = find(
      list,
      (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === "LoopStatusBadge"
    );
    assert.exists(badge);
    const text = badge!.getText(list);
    // The label is read before the last return, which is where `stopped: <code>` in rose is drawn.
    const at = text.indexOf("TEMPO_KEY_STOP_LABEL[");
    assert.isAbove(at, 0, "the badge reads the labels");
    assert.isBelow(at, text.lastIndexOf("stopped: ${loop.stopReason}"));
    assert.match(text.slice(at), /^TEMPO_KEY_STOP_LABEL\[[^\]]+\][^]*?<Badge tone="neutral"/);
  });
});

describe("Run again is offered on a stopped run only", () => {
  const list = parse("LoopList.tsx");
  const button = find(
    list,
    (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === "RunAgainButton"
  );

  /** The `if (…) return null;` guards at the top of the component's body, as source text. */
  const guards = () =>
    (button!.body?.statements ?? [])
      .filter(
        (s): s is ts.IfStatement =>
          ts.isIfStatement(s) &&
          ts.isReturnStatement(s.thenStatement) &&
          s.thenStatement.expression?.kind === ts.SyntaxKind.NullKeyword
      )
      .map((s) => s.expression.getText(list).replace(/\s+/g, " "));

  it("returns nothing for a run that is not stopped", () => {
    assert.exists(button);
    assert.include(guards(), 'loop.status !== "stopped"');
  });

  it("keeps the owner, anchor-failed and trial guards it had", () => {
    const g = guards();
    assert.include(g, "!publicKey || publicKey.toBase58() !== loop.owner");
    assert.include(g, 'loop.stopReason === "anchor-failed"');
    assert.include(g, "loop.trial");
  });

  it("guards after its hooks, so a run that changes status renders the same hooks", () => {
    const statements = button!.body!.statements;
    const firstGuard = statements.findIndex((s) => ts.isIfStatement(s));
    const lastHook = statements
      .map((s, i) => (/\buse[A-Z]\w*\(/.test(s.getText(list)) && !ts.isFunctionDeclaration(s) ? i : -1))
      .reduce((a, b) => Math.max(a, b), -1);
    assert.isAbove(firstGuard, lastHook);
  });
});
