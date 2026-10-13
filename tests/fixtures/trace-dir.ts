import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * A throwaway `LATH_TRACE_DIR`, set before anything that reads it is loaded.
 *
 * `frontend/src/app/api/_lib/runner.ts` captures the directory once, at module evaluation, so a
 * test cannot set the variable in its own body: imports are hoisted and the module would already
 * hold the default. Importing this module first is the ordering hook — ES modules evaluate their
 * dependencies in the order they are imported.
 */
export const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "lath-registry-"));
process.env.LATH_TRACE_DIR = traceDir;
// Captured at the same moment as the directory: the deploy route answers 503 without an RPC url,
// and a suite that set it at its own top would be too late once another console suite had loaded
// `runner.ts` first. Nothing in these suites reaches a cluster; every case is answered before a
// transaction is built.
process.env.LATH_RPC_URL ??= "https://rpc.invalid";
// Where the console under test says it is, so a signed message can name it. Read at each
// call rather than captured, but set here so every console suite signs for the same origin as the
// one `verifyAuth` compares with, and so the route suites — which build their requests with no
// `Host` header and no URL — have an origin at all.
process.env.LATH_CONSOLE_ORIGIN ??= "http://localhost:3000";
/** The domain and URI the suites' signed messages carry: `LATH_CONSOLE_ORIGIN` as `authMessage` wants them. */
export const consoleOrigin = {
  domain: new URL(process.env.LATH_CONSOLE_ORIGIN).host,
  uri: new URL(process.env.LATH_CONSOLE_ORIGIN).origin,
};
