/**
 * A static file server over the seeded trace directory — the "gateway" half of the locator
 * path, which is the only part of it that is not already the chain or the browser.
 *
 * Deliberately about fifteen lines: a gateway is a thing that returns bytes for a locator and
 * is trusted for nothing else. Anything more here would be
 * pretending the app depends on more than it does.
 *
 * The one exception is `/__tamper/<name>`, which exists for the end-to-end tests only: it makes
 * this gateway lie about one named blob so a test can watch the browser catch it. It is opt-in,
 * per blob and in memory, so tests running against the same gateway are unaffected by it.
 */
import { createServer } from "http";
import { readFile } from "fs/promises";
import { join, basename } from "path";

const dir = process.env.LATH_TRACE_DIR ?? join(process.cwd(), ".traces");
const port = Number(process.env.LATH_TRACE_PORT ?? 3112);

/** Names currently served with one byte flipped. `POST` adds, `DELETE` removes. */
const tampered = new Set();
const LOCAL = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

createServer(async (req, res) => {
  const path = decodeURIComponent((req.url ?? "/").split("?")[0]);

  // E2E only (see the module note). The listener is loopback-only already; the check states it.
  if (path.startsWith("/__tamper/")) {
    const name = basename(path.slice("/__tamper/".length));
    if (!name || !LOCAL.includes(req.socket.remoteAddress ?? "")) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === "POST") tampered.add(name);
    else if (req.method === "DELETE") tampered.delete(name);
    else {
      res.writeHead(405).end();
      return;
    }
    res.writeHead(204).end();
    return;
  }

  // basename() so a locator can never walk out of the directory.
  const name = basename(path.slice(1));
  // The root is a liveness answer, not a listing: a gateway serves locators, and Playwright
  // needs something at the base URL to know the process is up.
  if (!name) {
    res.writeHead(200, { "content-type": "text/plain" }).end("lath trace gateway\n");
    return;
  }
  try {
    const bytes = await readFile(join(dir, name));
    // One flipped byte: the bytes stay the right length and the wrong content, which is exactly
    // the case the reader is supposed to catch by re-deriving the hash or the Merkle root.
    if (tampered.has(name) && bytes.length > 0) bytes[bytes.length - 1] ^= 0xff;
    res
      .writeHead(200, {
        "content-type": "application/octet-stream",
        "access-control-allow-origin": "*",
        // So a reload after a tamper toggle fetches again rather than reading the browser cache.
        "cache-control": "no-store",
      })
      .end(bytes);
  } catch {
    res.writeHead(404, { "access-control-allow-origin": "*" }).end();
  }
}).listen(port, "127.0.0.1", () => console.log(`traces on http://127.0.0.1:${port} from ${dir}`));
