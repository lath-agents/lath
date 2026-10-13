#!/usr/bin/env bash
# Runs the frontend against devnet without touching frontend/.env.local.
#
# A stray .env.local (one pointing at another cluster, say) can point the app
# elsewhere. Next.js only fills in variables
# that are *not* already in the environment (`@next/env` `processEnv`: a key present in the
# initial `process.env` snapshot is skipped, never overwritten), so exporting the devnet values
# here beats the file without editing it — including the Photon and prover urls, which are exported
# as empty so a stray value cannot leak into a devnet run.
#
# Usage: npm run dev:devnet [-- --port 3001] [--build] [--print] [--e2e] [--lan]
#
# --lan listens on every interface instead of 127.0.0.1 alone. Off by default because this console
# carries the mainnet Tempo treasury and a server keypair, its API answers a request that sends no
# Origin, and under --e2e the E2E wallet's secret is inlined into the JS it serves: on a shared
# network, anyone who can reach the port can spend through it. Pass --lan only on a network you trust.
#
# --e2e sources frontend/.env.devnet.e2e (written by `scripts/seed.ts --devnet
# --e2e-wallet`): the E2E keypair wallet and the :3112 blob gateway the Playwright suite drives.
# Never on by default, so a demo console never offers the "E2E Keypair" wallet. It changes nothing
# else: blobs and sources go to Irys as on any devnet console.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The port a lone console runs on. A start on any other port is by definition a second console
# beside a running one, which is what NEXT_DIST_DIR below exists for.
DEFAULT_PORT=3000
PORT=$DEFAULT_PORT
BUILD=0
PRINT=0
E2E=0
LAN=0
EXTRA=()

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      PORT="${2:?--port needs a number}"
      shift 2
      ;;
    --port=*)
      PORT="${1#*=}"
      shift
      ;;
    --build)
      BUILD=1
      shift
      ;;
    --print | --dry-run)
      PRINT=1
      shift
      ;;
    --e2e)
      E2E=1
      shift
      ;;
    --lan)
      LAN=1
      shift
      ;;
    -h | --help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      EXTRA+=("$1")
      shift
      ;;
  esac
done

if [ "$E2E" = "1" ]; then
  E2E_ENV="$REPO/frontend/.env.devnet.e2e"
  [ -f "$E2E_ENV" ] || { echo "--e2e: $E2E_ENV is missing; run scripts/seed.ts --devnet --e2e-wallet > $E2E_ENV" >&2; exit 1; }
  set -a
  # shellcheck disable=SC1090
  . "$E2E_ENV"
  set +a
fi

# ─── The RPC: an explicit override, the environment, or the solana CLI ───────
#
# One endpoint has to serve JSON-RPC, the Photon index and the prover, so this must be a
# ZK-compression RPC (Helius). `api.devnet.solana.com` has no compression index and every agent
# read comes back empty; it is not rejected here because the url shape cannot tell the two apart.
is_devnet() { case "$1" in *devnet*) return 0 ;; *) return 1 ;; esac; }

RPC=""
SOURCE=""
if [ -n "${LATH_DEVNET_RPC:-}" ]; then
  RPC="$LATH_DEVNET_RPC"
  SOURCE="\$LATH_DEVNET_RPC"
elif [ -n "${LATH_RPC_URL:-}" ] && is_devnet "${LATH_RPC_URL}"; then
  RPC="$LATH_RPC_URL"
  SOURCE="\$LATH_RPC_URL"
elif [ -n "${NEXT_PUBLIC_RPC_URL:-}" ] && is_devnet "${NEXT_PUBLIC_RPC_URL}"; then
  # Read, for a shell that still carries it, and then blanked below: it is a
  # source for the server's url, never again the browser's.
  RPC="$NEXT_PUBLIC_RPC_URL"
  SOURCE="\$NEXT_PUBLIC_RPC_URL"
else
  CLI_RPC="$(solana config get 2>/dev/null | sed -n 's/^RPC URL: *//p' | tr -d '[:space:]' || true)"
  if [ -n "$CLI_RPC" ] && is_devnet "$CLI_RPC"; then
    RPC="$CLI_RPC"
    SOURCE="solana config"
  fi
fi

if [ -z "$RPC" ]; then
  cat >&2 <<'MSG'
No devnet RPC found. Set one of:

  LATH_DEVNET_RPC="https://devnet.helius-rpc.com/?api-key=…"   (this run only)
  solana config set --url https://devnet.helius-rpc.com/?api-key=…

It has to be a ZK-compression RPC — one url serving Solana JSON-RPC, Photon and the prover.
See README.md, "Run it locally".
MSG
  exit 1
fi

# ─── The cluster's public configuration (docs/ARCHITECTURE.md §12) ───────────
#
# The RPC is not part of it. The url carries the Helius key, Next inlines every NEXT_PUBLIC_* into the
# JavaScript each visitor downloads, and this is the same url the server writes every chain with — so
# exporting it here would publish the key to anyone who opened devtools. The browser reads through
# the console's own /api/rpc/devnet instead
# (frontend/src/app/api/rpc/proxy.ts), which forwards to LATH_RPC_URL below. Empty, not unset, for
# the same reason as the Photon and prover urls: a value in the environment is what stops a stray
# .env.local's url being loaded, and empty is how `config.ts` spells "use the proxy".
export NEXT_PUBLIC_RPC_URL=""
export NEXT_PUBLIC_CLUSTER="devnet"
export NEXT_PUBLIC_TREASURY_ADMIN="${NEXT_PUBLIC_TREASURY_ADMIN:-Ghs6xLtvzUFA6MyPtzWU7y5EtSsccu8jteLFp7S4KYSy}"
export NEXT_PUBLIC_USDC_MINT="${NEXT_PUBLIC_USDC_MINT:-4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU}"
# Empty, not unset: a value in the environment is what stops a stray .env.local's ports being
# loaded, and empty is how `config.ts` and `api/run` spell "follow the main url".
export NEXT_PUBLIC_PHOTON_URL=""
export NEXT_PUBLIC_PROVER_URL=""
export LATH_PHOTON_URL=""
export LATH_PROVER_URL=""

# The blob gateway the *browser* resolves traces and epoch blobs through. A .env.local written for the E2E
# run points this at `e2e/serve-traces.mjs` (127.0.0.1:3112), which is not running in a plain devnet session
# and refuses the connection, so "Open"/"Open steps" never resolve. The app serves the same bytes
# from the trace directory at /api/traces; the browser re-hashes whatever comes back either way.
# The encoding must match how the console writes locators here (hex); the scheme is not set at
# all, because the reader takes it from the cell the chain answered with and the raw gateway's
# own default is already 0. The registry is blanked so a stray registry id cannot leak into a
# devnet read. Nothing points at Irys: scheme-4 locators have a gateway in code.
export NEXT_PUBLIC_TRACE_GATEWAY="${NEXT_PUBLIC_TRACE_GATEWAY:-/api/traces}"
export NEXT_PUBLIC_TRACE_ENCODING="hex"
export NEXT_PUBLIC_TRACE_REGISTRY=""

# The console's server side (`frontend/src/app/api/run/route.ts`) reads LATH_RUNTIME_KEYPAIR,
# LATH_TRACE_DIR, LATH_CONSOLE_TAG, LATH_EPOCHS, LATH_SESSION_CAP_USDC,
# LATH_MAX_STEPS and the Irys settings (LATH_IRYS_NODE, LATH_IRYS_NETWORK,
# LATH_IRYS_GATEWAY). All of those are cluster-independent and are inherited untouched;
# LATH_RPC_URL is the one that is not, so it is pinned to the devnet url rather than left to
# .env.local.
export LATH_RPC_URL="$RPC"
# Trace and epoch blobs are per cluster: a chain's audit fetches its old epochs through this
# directory forever, so a devnet chain must not share it with the app's default (.traces).
export LATH_TRACE_DIR="${LATH_TRACE_DIR:-$REPO/frontend/.traces-devnet}"
# Epoch blobs and the session bundle go to Irys devnet by default. The runtime key is the uploader
# and pays from its balance *at*
# Irys (`npm run irys -- balance`); an unfunded key refuses to start a session, an upload that
# fails mid-run falls back to LATH_TRACE_DIR and reports it.
#
# --e2e is on Irys too. Pinning it to the directory would leave no chains behind for devnet Irys
# to expire after about sixty days; but a console on the directory writes scheme-0 locators that
# only this checkout resolves, which a fresh clone cannot read, and keeps the sandbox's sources off
# Irys, so no Playwright run would exercise the path the product and the demo film claim. A
# suite's chains may expire with their blobs; that is accepted.
# `LATH_TRACE_BACKEND=fs` in the shell still keeps any console, --e2e or not, on the directory.
#
# The treasury is not emptied under --e2e. Tempo is the only rail a billed call is paid on, so a
# console without a treasury bills nothing at all: every session runs the scripted transport and
# the suite stops seeing the charge it exists to check. The development treasury (a mainnet account
# holding a few USDC.e, kept in the checkout as the git-ignored `.tempo-treasury.key`) is therefore
# the default on both paths, and a Playwright run spends real USDC.e: the model is cheap and a whole
# run is under twenty cents, which is worth less than a suite that cannot tell billed from scripted.
# A shell value still wins. Only whether there is one is printed, never the key.
if [ -z "${LATH_TEMPO_TREASURY:-}" ] && [ -f "$REPO/.tempo-treasury.key" ]; then
  export LATH_TEMPO_TREASURY="$REPO/.tempo-treasury.key"
fi
echo "lath: tempo: $([ -n "${LATH_TEMPO_TREASURY:-}" ] && echo "treasury set" || echo "off (LATH_TEMPO_TREASURY unset)")"
export LATH_TRACE_BACKEND="${LATH_TRACE_BACKEND:-irys}"
echo "lath: trace backend: $LATH_TRACE_BACKEND"
# Which Irys node the uploads go to. Empty is the default and means the network's own node; it is
# exported rather than merely inherited so the line below can print it, and so the fallback check
# — point it at a port nothing listens on and watch the blob fall back to LATH_TRACE_DIR — is one
# variable on the command line.
export LATH_IRYS_NODE="${LATH_IRYS_NODE:-}"

# Where Next writes its dev build cache (`distDir` in frontend/next.config.mjs, which reads this
# variable). Two `next dev` on one checkout share `frontend/.next` and corrupt each other: the
# second start is refused by the treasury lock in frontend/src/instrumentation.ts as designed, but
# only *after* Next has begun writing that cache, and the first console then answers 500 on every
# page — `Cannot find module .next/server/pages/_document.js`, then `Invariant: Expected
# clientReferenceManifest to be defined` — until it is restarted. A
# non-default port is the case: nothing but a second console asks for one, and the process that
# already holds the treasury is on the default. So that start gets its own build dir and leaves
# the running console's alone. The default port is untouched, so `npm --prefix frontend run
# typecheck` and every production build still see `.next`; a shell value wins over both.
#
# The authoritative "is another console live" answer is `readTreasuryLock` in
# frontend/src/app/api/_lib/tempo.ts (a pid plus a heartbeat), but it is the refusing process that
# reads it — by then the damage is done, so the decision is taken here from the port alone.
#
# Setting this makes Next rewrite frontend/tsconfig.json's `include` to the alternate
# `<distDir>/types` path; check that file out again after such a run, or prettier fails on it.
if [ "$PORT" != "$DEFAULT_PORT" ]; then
  export NEXT_DIST_DIR="${NEXT_DIST_DIR:-.next-$PORT}"
  echo "lath: next build dir: $NEXT_DIST_DIR (port $PORT is not $DEFAULT_PORT; frontend/.next belongs to the console on $DEFAULT_PORT)"
fi

# The api key is the only part of the url worth not printing.
RPC_HOST="$(printf '%s' "$RPC" | sed -e 's#^[a-z]*://##' -e 's#[/?].*##')"
KEYPAIR="${LATH_RUNTIME_KEYPAIR:-frontend/.runtime-keypair.json}"

# Loopback unless --lan. `next dev` with no --hostname listens on every interface, and this
# console holds the mainnet treasury above: the middleware's cross-site check lets a request with
# no Origin through (curl does not send one), so the port is the only fence. A --hostname the
# caller passes through EXTRA is their explicit choice and wins, so it is not doubled here.
HOST_ARGS=()
HOST_SHOWN="all interfaces"
case " ${EXTRA[*]-} " in
  *" --hostname"* | *" -H "*) HOST_SHOWN="as passed" ;;
  *)
    if [ "$LAN" = "0" ]; then
      HOST_ARGS=(--hostname 127.0.0.1)
      HOST_SHOWN=127.0.0.1
    fi
    ;;
esac
if [ "$LAN" = "1" ]; then
  echo "lath: listening on every interface (--lan): anyone on this network can call the console's API"
  if [ "$E2E" = "1" ]; then
    echo "lath: --lan with --e2e also serves NEXT_PUBLIC_E2E_WALLET_SECRET to that network"
  fi
fi

echo "lath: cluster=devnet rpc=$RPC_HOST (from $SOURCE) admin=$NEXT_PUBLIC_TREASURY_ADMIN mint=$NEXT_PUBLIC_USDC_MINT port=$PORT host=$HOST_SHOWN"

# The runtime key's fee balance, printed once here rather than polled by the browser: it is an
# operator's number, not something a visitor to the app has any use for. Best effort — a missing
# keypair or an RPC that will not answer must not stop a dev server from starting.
case "$KEYPAIR" in /*) KEYPAIR_PATH="$KEYPAIR" ;; *) KEYPAIR_PATH="$REPO/$KEYPAIR" ;; esac
RUNTIME_ADDR="$(solana address -k "$KEYPAIR_PATH" 2>/dev/null || true)"
if [ -n "$RUNTIME_ADDR" ]; then
  RUNTIME_SOL="$(solana balance "$RUNTIME_ADDR" --url "$RPC" 2>/dev/null || true)"
  echo "lath: runtime key $RUNTIME_ADDR ${RUNTIME_SOL:-balance unavailable}"
fi

# ─── The sandbox every loop step runs in (docs/ARCHITECTURE.md §5) ──────────────
#
# Checked once, here, and never required: a console without the Lath-patched ZeroClaw still serves
# the app, and `/api/loops` refuses to start a loop with the reason on screen — there is no
# in-process fallback. LATH_ZEROCLAW_BIN wins; else `zeroclaw` on PATH; else the build output of
# `zeroclaw/build.sh`. Exported as an absolute path, because Next runs from frontend/ and a path
# relative to the repo would name nothing there. "The Lath build" is what the runtime checks
# (`resolveZeroClaw`): the record build.sh writes beside the binary names these bytes, or the
# binary's --version names a patch set. The wrapper and the rest are checked per start.
ZC_BIN="${LATH_ZEROCLAW_BIN:-}"
[ -z "$ZC_BIN" ] && ZC_BIN="$(command -v zeroclaw 2>/dev/null || true)"
[ -z "$ZC_BIN" ] && [ -x "$REPO/zeroclaw/.build/zeroclaw" ] && ZC_BIN="$REPO/zeroclaw/.build/zeroclaw"
if [ -z "$ZC_BIN" ]; then
  echo "lath: zeroclaw: none (set LATH_ZEROCLAW_BIN or run zeroclaw/build.sh); loops will refuse to start"
else
  case "$ZC_BIN" in /*) ;; *) ZC_BIN="$REPO/$ZC_BIN" ;; esac
  export LATH_ZEROCLAW_BIN="$ZC_BIN"
  if [ ! -x "$ZC_BIN" ]; then
    echo "lath: zeroclaw: $ZC_BIN is missing or not executable; loops will refuse to start"
  else
    ZC_SHA="$(shasum -a 256 "$ZC_BIN" | cut -d' ' -f1)"
    ZC_VERSION="$(env -i "$ZC_BIN" --version </dev/null 2>/dev/null | head -1 || true)"
    ZC_RECORD="$(head -1 "$ZC_BIN.sha256" 2>/dev/null || true)"
    if [ -z "$ZC_VERSION" ]; then
      ZC_KIND="does not answer --version; loops will refuse to start"
    elif [ "${ZC_RECORD%% *}" = "$ZC_SHA" ] && printf '%s' "$ZC_RECORD" | grep -q 'patchset='; then
      ZC_KIND="the Lath build ($(printf '%s' "$ZC_RECORD" | sed -n 's/.*\(patchset=[^ ]*\).*/\1/p'))"
    elif printf '%s' "$ZC_VERSION" | grep -q 'patchset='; then
      ZC_KIND="the Lath build ($ZC_VERSION)"
    else
      ZC_KIND="NOT the Lath build ($ZC_VERSION; no build record names it); loops will refuse to start"
    fi
    echo "lath: zeroclaw: $ZC_BIN sha256=$ZC_SHA — $ZC_KIND"
  fi
fi
echo "lath: zeroclaw home: ${LATH_ZEROCLAW_HOME:-$HOME/.lath/zc (default)}"

if [ "$PRINT" = "1" ]; then
  echo
  echo "env:"
  for v in NEXT_PUBLIC_CLUSTER NEXT_PUBLIC_TREASURY_ADMIN NEXT_PUBLIC_USDC_MINT; do
    echo "  $v=${!v}"
  done
  echo "  NEXT_PUBLIC_RPC_URL=\"\"   (empty → the browser reads through /api/rpc/devnet; the key stays server-side)"
  echo "  LATH_RPC_URL=https://$RPC_HOST/?api-key=***"
  echo "  NEXT_PUBLIC_PHOTON_URL=\"\"   (empty → the browser reads Photon through /api/rpc/devnet/photon)"
  echo "  NEXT_PUBLIC_PROVER_URL=\"\"   (empty → unused: the browser's Rpc takes proofs from Photon)"
  for v in LATH_PHOTON_URL LATH_PROVER_URL; do
    echo "  $v=\"\"   (empty → follows LATH_RPC_URL)"
  done
  echo "  NEXT_PUBLIC_TRACE_GATEWAY=$NEXT_PUBLIC_TRACE_GATEWAY (hex; scheme 4 reads gateway.irys.xyz)"
  [ "$E2E" = "1" ] && echo "  e2e: NEXT_PUBLIC_E2E_WALLET_SECRET=$([ -n "${NEXT_PUBLIC_E2E_WALLET_SECRET:-}" ] && echo set || echo unset) (from frontend/.env.devnet.e2e)"
  echo "  NEXT_DIST_DIR=${NEXT_DIST_DIR:-.next   (default; a non-default --port gets .next-<port>)}"
  echo "  passed through: LATH_RUNTIME_KEYPAIR=$KEYPAIR LATH_CONSOLE_TAG=${LATH_CONSOLE_TAG:-unset} LATH_EPOCHS=${LATH_EPOCHS:-unset} LATH_TRACE_DIR=$LATH_TRACE_DIR LATH_TRACE_BACKEND=$LATH_TRACE_BACKEND LATH_IRYS_NODE=${LATH_IRYS_NODE:-default}"
  echo
  [ "$BUILD" = "1" ] && echo "build: npm --prefix sdk run build && npm --prefix runtime run build"
  echo "cmd:   (cd frontend && npx next dev --port $PORT${HOST_ARGS[*]:+ ${HOST_ARGS[*]}}${EXTRA[*]:+ ${EXTRA[*]}})"
  exit 0
fi

if [ "$BUILD" = "1" ]; then
  npm --prefix "$REPO/sdk" run build
  npm --prefix "$REPO/runtime" run build
fi

cd "$REPO/frontend"
exec npx next dev --port "$PORT" ${HOST_ARGS[@]+"${HOST_ARGS[@]}"} ${EXTRA[@]+"${EXTRA[@]}"}
