/**
 * `lath-audit` from a checkout of this repo. The implementation moved into the SDK — the
 * engine to `sdk/src/audit.ts`, the command line to `sdk/src/cli.ts`. `@lath/sdk` is not on npm, so an
 * external auditor runs it from a clone:
 *
 * ```bash
 * npm run -s audit -- --name agent-alpha --rpc "https://devnet.helius-rpc.com/?api-key=…"
 * ```
 *
 * This file stays as the `npm run audit` entry point (and as the import surface `tests/audit.ts`
 * uses), so both paths run exactly the same code.
 */
export { audit, exitCode, formatReport, subHashes, type AuditOptions, type AuditReport } from "../sdk/src";
export { main, openStore } from "../sdk/src/cli";

import { run } from "../sdk/src/cli";

if (require.main === module) run();
