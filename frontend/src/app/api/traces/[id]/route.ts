/**
 * A read-only blob gateway over the directory the console writes traces and epoch blobs to.
 *
 * This is the same fifteen-line thing `e2e/serve-traces.mjs` is: it returns bytes for a name and
 * is trusted for nothing else. The browser re-hashes every trace it fetches and rebuilds every
 * epoch root, so a wrong or hostile gateway shows as "bytes do not match", never as a wrong trace.
 * `NEXT_PUBLIC_TRACE_GATEWAY=/api/traces` points the app here.
 */
import * as fs from "fs/promises";
import * as path from "path";

export const dynamic = "force-dynamic";

const TRACE_DIR = process.env.LATH_TRACE_DIR?.trim() || path.join(process.cwd(), ".traces");

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // basename() so a locator can never walk out of the directory, and only the shapes the
  // stores write: a 32-byte hex trace or locator id, a base64url id, `<root hex>.epoch`, or
  // `<hash hex>.<32 hex>` — the name an encrypting store gives its blob when another key's
  // ciphertext of the same plaintext already holds the hash (`traceVariantName`,
  // sdk/src/trace-store.ts). This build writes traces in the clear, but a directory holding older
  // encrypted blobs is still served.
  // The deployment registry (`agents.json`) and any keypair file share this directory and
  // are not served.
  const name = path.basename(id);
  if (!/^([0-9a-f]{64}(\.epoch|\.[0-9a-f]{32})?|[A-Za-z0-9_-]{43})$/.test(name))
    return new Response(null, { status: 404 });
  try {
    const bytes = await fs.readFile(path.join(TRACE_DIR, name));
    return new Response(bytes, {
      headers: { "content-type": "application/octet-stream", "cache-control": "public, max-age=31536000, immutable" },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
