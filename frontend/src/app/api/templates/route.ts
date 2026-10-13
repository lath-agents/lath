/**
 * Templates: the read side, and the three writes an owner has.
 *
 * `GET` is open, like `GET /api/loops` and for the same reason: `verifyAuth` burns a nonce and a
 * GET carries no body to put a signature in. Like that GET it answers every reader the same.
 *
 * The writes are owner-signed under the purpose `"Lath template"`, so a session or a deploy
 * signature cannot be replayed as one. There are three and they are all POST or PUT: `POST`
 * with a `kind` writes version 1, `PUT` appends version n+1, and `POST { id, action: "archive" }`
 * archives. No `DELETE` verb and no `[id]` route — archive is an action on the owner-signed POST
 * the way pause and stop are on `/api/loops`, and one route file with an `id` in the body is the
 * whole surface.
 *
 * Nothing here touches the chain: a template is off-chain by construction, so a server with no
 * runtime keypair still serves these. Editing writes a new version and touches no run; archiving
 * hides the id and leaves every run it produced verifiable. That is also why the closed beta
 * (`_lib/beta.ts`) does not gate these writes: they spend no treasury USDC.e and no server SOL, and
 * what they cost — a JSON row — is bounded by the per-owner cap and the hourly buckets. A template
 * is spent only when something runs it, and every route that runs one is gated.
 *
 * The list is the *latest* version of each template plus how many versions it has, rather than
 * every version: the pages that use it (`/templates`, the wizard's *from a template*) offer the
 * current config, and a run that needs an older one resolves it by `{ id, version }` through
 * `lookupTemplate`. Archived templates are omitted; their versions are still readable by id.
 */
import { NextRequest } from "next/server";
import { AuthPurpose, CLUSTER, SessionAuth, callerIp, consoleOrigin, verifyAuth, walletIn } from "../_lib/runner";
import {
  Template,
  archiveTemplate,
  chargeTemplateWrite,
  lookupTemplate,
  ownedTemplates,
  recordTemplate,
  templateCapRefusal,
  templateVersions,
} from "../_lib/templates";
import { checkClonedFrom, checkConfig, checkName, resolveWrite } from "./validate";
import { asBody, bodyTooLarge, readJsonCapped } from "../rpc/proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The purpose template writes are signed under, one member of `AuthPurpose`. It is the first line of
 * the signed message, which is what keeps a session or deploy signature from passing as a template
 * write.
 */
const TEMPLATE_PURPOSE: AuthPurpose = "Lath template";

interface Body {
  id?: string;
  action?: "archive";
  kind?: Template["kind"];
  name?: string;
  config?: unknown;
  clonedFrom?: unknown;
  auth?: SessionAuth;
}

/**
 * The body, read whole and capped before anything parses it or looks at its signature, or `null`
 * when it is past the cap (the write answers `bodyTooLarge`). `req.json()` would buffer and parse
 * whatever was sent — unsigned, since the signature is checked after — and a template write is one an
 * anonymous key can sign. The config inside it has its own bound, `MAX_CONFIG_CHARS` in
 * `validate.ts`, which is what bounds what a write stores; this one bounds what a request costs before
 * it is refused. What does not parse, or is not an object, is an empty body.
 */
async function readBody(req: NextRequest): Promise<Body | null> {
  const read = await readJsonCapped(req);
  return read ? asBody<Body>(read.json) : null;
}

/** The signing wallet, or the response that refuses the write. */
function owner(req: NextRequest, body: Body): { wallet: string } | { refusal: Response } {
  // The verb is the method's: `POST` writes version 1 (or archives, with `action`), `PUT` appends one.
  const verified = verifyAuth(
    body.auth,
    body.auth ? walletIn(body.auth.message) : null,
    TEMPLATE_PURPOSE,
    {
      action: req.method === "PUT" ? "append" : body.action === "archive" ? "archive" : "write",
      target: body.id ?? "new",
    },
    consoleOrigin(req)
  );
  if (!("wallet" in verified)) {
    return {
      refusal: Response.json(
        { error: `a wallet signature is required to write a template: ${verified.reason}` },
        { status: 401 }
      ),
    };
  }
  return { wallet: verified.wallet.toBase58() };
}

/**
 * The hourly write quota — the server's bucket, then the wallet's (`chargeTemplateWrite`) —
 * charged only once a write has passed every check and is about to land. Charged inside `owner()`,
 * before the kind, the name, the config, the lineage and the target are looked at, a caller's typo or
 * a refused archive of somebody else's template would spend a write they never made; `/api/agents`
 * charges its quota the same way. Every check before it is a local read, so charging late opens
 * nothing unmetered that costs the operator.
 */
function charge(req: NextRequest, wallet: string): Response | null {
  const refused = chargeTemplateWrite(wallet, callerIp(req));
  return refused ? Response.json({ error: refused }, { status: 429 }) : null;
}

/** What every write returns: the version written, and the id's history after it. */
function written(t: Template): Response {
  return Response.json({ cluster: CLUSTER, template: t, versions: templateVersions(t.id) });
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  const ownerParam = req.nextUrl.searchParams.get("owner") ?? undefined;

  if (id) {
    const latest = lookupTemplate(id);
    if (!latest) return Response.json({ error: "no template with that id" }, { status: 404 });
    return Response.json({
      cluster: CLUSTER,
      template: latest,
      versions: templateVersions(id),
    });
  }

  // No `owner` lists every non-archived template, as `GET /api/loops` lists every loop: the
  // store is this console's, and the wallet a template belongs to is on the record.
  const templates = ownedTemplates(ownerParam).map(({ latest, versions }) => ({ ...latest, versions }));
  return Response.json({ cluster: CLUSTER, templates });
}

/** Version 1 of a new template, or `{ id, action: "archive" }` on an existing one. */
export async function POST(req: NextRequest) {
  const body = await readBody(req);
  if (!body) return bodyTooLarge();
  const signer = owner(req, body);
  if ("refusal" in signer) return signer.refusal;

  if (body.action === "archive") {
    const target = resolveWrite(body.id ? lookupTemplate(body.id) : null, signer.wallet);
    if (!("latest" in target)) return Response.json({ error: target.error }, { status: target.status });
    const limited = charge(req, signer.wallet);
    if (limited) return limited;
    const versions = archiveTemplate(target.latest.id);
    if (!versions) return Response.json({ error: "no template with that id" }, { status: 404 });
    return Response.json({ cluster: CLUSTER, template: versions[versions.length - 1], versions });
  }
  if (body.action !== undefined) return Response.json({ error: `unknown action: ${body.action}` }, { status: 400 });
  // A POST is version 1. Appending to an existing id is `PUT`, so that a client that sent the
  // id by mistake gets a refusal rather than a template it did not mean to fork.
  if (body.id) return Response.json({ error: "use PUT to write a new version of a template" }, { status: 400 });

  if (body.kind !== "agent" && body.kind !== "loop") {
    return Response.json({ error: 'kind must be "agent" or "loop"' }, { status: 400 });
  }
  const name = checkName(body.name);
  if ("error" in name) return Response.json({ error: name.error }, { status: 400 });
  const config = checkConfig(body.kind, body.config);
  if ("error" in config) return Response.json({ error: config.error }, { status: 400 });
  const clonedFrom = checkClonedFrom(body.clonedFrom);
  if ("error" in clonedFrom) return Response.json({ error: clonedFrom.error }, { status: 400 });
  // A clone says which version it was copied from, so the id it names has to exist and be of
  // the same kind; a lineage line that resolves to nothing is worse than no lineage line.
  if (clonedFrom.clonedFrom) {
    const source = lookupTemplate(clonedFrom.clonedFrom.id, clonedFrom.clonedFrom.version);
    if (!source) return Response.json({ error: "clonedFrom names no stored version" }, { status: 400 });
    if (source.kind !== body.kind) return Response.json({ error: "clonedFrom is a different kind" }, { status: 400 });
  }
  // A POST mints an id, so it is the one write the per-owner cap applies to; before the quota,
  // so a wallet at its cap is told that rather than charged a write it cannot make.
  const capped = templateCapRefusal(signer.wallet);
  if (capped) return Response.json({ error: capped }, { status: 429 });
  const limited = charge(req, signer.wallet);
  if (limited) return limited;

  return written(
    recordTemplate({
      kind: body.kind,
      owner: signer.wallet,
      name: name.name,
      config: config.config,
      ...clonedFrom,
    })
  );
}

/** Version n+1 of an existing template. The kind and the owner are the id's, not the body's. */
export async function PUT(req: NextRequest) {
  const body = await readBody(req);
  if (!body) return bodyTooLarge();
  const signer = owner(req, body);
  if ("refusal" in signer) return signer.refusal;

  const target = resolveWrite(body.id ? lookupTemplate(body.id) : null, signer.wallet);
  if (!("latest" in target)) return Response.json({ error: target.error }, { status: target.status });
  const latest = target.latest;

  // The name is optional: an edit of the config alone keeps the name the id already has.
  const name = body.name === undefined ? { name: latest.name } : checkName(body.name);
  if ("error" in name) return Response.json({ error: name.error }, { status: 400 });
  const config = checkConfig(latest.kind, body.config);
  if ("error" in config) return Response.json({ error: config.error }, { status: 400 });
  const limited = charge(req, signer.wallet);
  if (limited) return limited;

  return written(
    recordTemplate({
      id: latest.id,
      kind: latest.kind,
      owner: latest.owner,
      name: name.name,
      config: config.config,
    })
  );
}
