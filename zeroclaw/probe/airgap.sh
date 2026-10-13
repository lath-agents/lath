#!/usr/bin/env bash
# The air gap's acceptance probe. A probe, not product code: the wrapper profiles below are written
# by hand, and the runtime's generated wrapper must pass the same expectations with the same probe
# (tests/zeroclaw-airgap.ts).
#
#   zeroclaw/probe/airgap.sh macos     sandbox-exec, on this Mac
#   zeroclaw/probe/airgap.sh linux     bwrap --unshare-all, on a Linux host with bwrap
#   zeroclaw/probe/airgap.sh docker    the linux run inside a privileged Debian container
#
# Two shapes of the sandbox, because the product runs both: SOURCES=0 is the
# sandbox of every loop without sources, whose wrapper has no sources rule at all; SOURCES=1 adds the
# read-only `sources/` subtree and its expectations. Unset runs 0 then 1 and fails if either does,
# so a change to one shape cannot hide behind the other passing.
#
# It builds the std-only probe, lays out one step's sandbox (workspace, data dir, the two allowed
# Unix sockets) beside things the sandbox must not reach (a host loopback listener, a third Unix
# socket, a file outside, the operator's keypair, the trace dir), runs the probe once unwrapped
# as a control — so a pass is never vacuous — and once wrapped, and checks every line. Exit 0
# only if every forbidden reach was denied, every allowed one reached, and the control reached
# what the wrapper later denied.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
MODE="${1:-}"

# The same sandbox with the real Lath binary in it instead of the std-only probe (patch series
# 0001-0006): the step must complete under the wrapper, and its peak RSS is reported.
#   zeroclaw/probe/airgap.sh macos-zeroclaw <lath binary>
#   zeroclaw/probe/airgap.sh linux-zeroclaw <lath binary>
if [[ "$MODE" == macos-zeroclaw || "$MODE" == linux-zeroclaw ]]; then
  exec "$HERE/airgap-zeroclaw.sh" "$@"
fi

if [[ "$MODE" == docker ]]; then
  # The container is privileged only so bwrap can make namespaces; the sandbox inside is what is
  # tested. Debian's bwrap is the one a Linux deploy would install.
  exec docker run --rm --privileged -e SOURCES="${SOURCES:-}" -v "$HERE:/probe:ro" rust:1-slim-bookworm bash -c \
    'apt-get -qq update >/dev/null && apt-get -qq install -y bubblewrap python3 >/dev/null && /probe/airgap.sh linux'
fi

case "$MODE" in
  macos) command -v sandbox-exec >/dev/null || { echo "no sandbox-exec" >&2; exit 2; } ;;
  linux) command -v bwrap >/dev/null || { echo "no bwrap" >&2; exit 2; } ;;
  *) echo "usage: [SOURCES=0|1] $0 macos|linux|docker, or $0 macos-zeroclaw|linux-zeroclaw <lath binary>" >&2; exit 2 ;;
esac

SOURCES="${SOURCES:-}"
if [[ -z "$SOURCES" ]]; then
  # Each shape in its own run, with its own sandbox: a file the first shape left behind must not be
  # what the second is judged on.
  rc=0
  for shape in 0 1; do SOURCES=$shape "${BASH_SOURCE[0]}" "$MODE" || rc=1; done
  exit $rc
fi
[[ "$SOURCES" == 0 || "$SOURCES" == 1 ]] || { echo "SOURCES must be 0 or 1, got $SOURCES" >&2; exit 2; }
SHAPE="$MODE, sources=$SOURCES"

# Short on purpose: a Unix socket path is at most 104 bytes on macOS and 108 on Linux, which is
# why LATH_ZEROCLAW_HOME must be short too (§5.11). realpath because Seatbelt matches the
# resolved path (/tmp is /private/tmp on macOS).
ROOT="$(realpath "$(mktemp -d /tmp/lzc.XXXXXX)")"
cleanup() { [[ -n "${HELPER:-}" ]] && kill "$HELPER" 2>/dev/null; rm -rf "$ROOT"; }
trap cleanup EXIT

SANDBOX="$ROOT/sandbox"
mkdir -p "$ROOT/bin" "$SANDBOX/work" "$SANDBOX/data" "$ROOT/outside"
echo "outside the sandbox" >"$ROOT/outside/secret.txt"
echo "inside the sandbox" >"$SANDBOX/work/note.txt"
if [[ "$SOURCES" == 1 ]]; then
  # A sandbox's sources: readable, never writable. Left writable on disk on
  # purpose, so the only thing that can refuse the write below is the wrapper's rule.
  mkdir -p "$SANDBOX/work/sources"
  echo "a source" >"$SANDBOX/work/sources/src.txt"
fi
MODEL_SOCK="$SANDBOX/m.sock"
TOOLS_SOCK="$SANDBOX/t.sock"
OTHER_SOCK="$ROOT/other.sock"

rustc -O --edition 2021 -o "$ROOT/bin/airgap-probe" "$HERE/airgap-probe.rs"

# The host side: the two sockets the sandbox may reach, one it may not, and a loopback TCP listener
# standing in for every host port (the Next server, a local RPC, the proxy's old TCP port).
python3 - "$MODEL_SOCK" "$TOOLS_SOCK" "$OTHER_SOCK" "$ROOT/port" <<'PY' &
import os, socket, sys, threading
def serve(sock):
    while True:
        c, _ = sock.accept()
        try:
            c.recv(64); c.sendall(b"pong\n")
        finally:
            c.close()
for path in sys.argv[1:4]:
    s = socket.socket(socket.AF_UNIX); s.bind(path); s.listen(8)
    threading.Thread(target=serve, args=(s,), daemon=True).start()
t = socket.socket(); t.bind(("127.0.0.1", 0)); t.listen(8)
threading.Thread(target=serve, args=(t,), daemon=True).start()
open(sys.argv[4], "w").write(str(t.getsockname()[1]))
threading.Event().wait()
PY
HELPER=$!
disown "$HELPER"
for _ in $(seq 50); do [[ -s "$ROOT/port" ]] && break; sleep 0.1; done
PORT="$(cat "$ROOT/port")"

KEYPAIR="$HOME/.config/solana/id.json"
TRACES="$REPO/frontend/.traces-devnet"
[[ -e "$KEYPAIR" ]] || { mkdir -p "$ROOT/home/.config/solana"; echo '[]' >"$ROOT/home/.config/solana/id.json"; KEYPAIR="$ROOT/home/.config/solana/id.json"; }
[[ -d "$TRACES" ]] || { mkdir -p "$ROOT/traces"; echo x >"$ROOT/traces/blob"; TRACES="$ROOT/traces"; }
TRACE_FILE="$(find "$TRACES" -type f -print -quit)"

# What the probe is asked to do, with the path each side of the wrapper sees. On Linux the sandbox
# is mounted at fixed paths (/lath/...), which is also what makes the workspace path in the
# system prompt the same on every host (§11.4); on macOS there is no mount namespace, so the
# sandbox's real paths are the paths.
if [[ "$MODE" == linux ]]; then
  IN_WORK=/lath/work IN_DATA=/lath/data IN_MODEL=/lath/model.sock IN_TOOLS=/lath/tools.sock
else
  IN_WORK="$SANDBOX/work" IN_DATA="$SANDBOX/data" IN_MODEL="$MODEL_SOCK" IN_TOOLS="$TOOLS_SOCK"
fi
probe_args() {
  local work="$1" data="$2" model="$3" tools="$4"
  echo "tcp=1.1.1.1:443" "loopback=127.0.0.1:$PORT" "udp=1.1.1.1:53" "dns=example.com:443" \
    "read=$KEYPAIR" "read=$TRACE_FILE" "read=$ROOT/outside/secret.txt" "read=/etc/hosts" \
    "write=$ROOT/outside/planted.txt" "unix=$OTHER_SOCK" "exec=/bin/sh" \
    "read=$work/note.txt" "write=$work/made.txt" "write=$data/trace.jsonl" \
    "allow=$model" "allow=$tools" "env=1"
  [[ "$SOURCES" == 1 ]] && echo "read=$work/sources/src.txt" "write=$work/sources/planted.txt"
  return 0
}

# The control: the same probe, unwrapped, with the sandbox's real paths. It must reach the host
# loopback, the keypair, the file outside and the third socket; if it cannot, the wrapped run
# proves nothing about the wrapper.
CONTROL="$("$ROOT/bin/airgap-probe" $(probe_args "$SANDBOX/work" "$SANDBOX/data" "$MODEL_SOCK" "$TOOLS_SOCK"))"
# The control planted a file outside and, with sources, one in sources/; remove both, so the wrapped
# run is judged on its own writes.
rm -f "$ROOT/outside/planted.txt" "$SANDBOX/work/sources/planted.txt"

ENV_NAMES="HOME,LANG,TZ"
# bwrap --chdir sets PWD in the child; it names the workspace, which the system prompt carries anyway.
[[ "$MODE" == linux ]] && ENV_NAMES="HOME,LANG,PWD,TZ"
if [[ "$MODE" == macos ]]; then
  PROFILE="$ROOT/sandbox.sb"
  # The sources are read-only: after the workspace's allow, because Seatbelt lets the last matching
  # rule decide. Without sources the line is not there at all, as in the posture's profile.
  SOURCES_RULE=""
  [[ "$SOURCES" == 1 ]] && SOURCES_RULE="(deny file-write* (subpath \"$SANDBOX/work/sources\"))"
  # deny default: everything not named here is refused, network included. The two
  # network-outbound rules are the whole of what the sandbox may reach.
  cat >"$PROFILE" <<SB
(version 1)
(deny default)
(allow process-exec (literal "$ROOT/bin/airgap-probe"))
(allow file-read* (literal "$ROOT/bin/airgap-probe"))
(allow file-read* (subpath "/usr/lib") (subpath "/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes") (subpath "/System/Cryptexes"))
(allow file-read-metadata (literal "/") (literal "/private") (literal "/private/tmp") (literal "$ROOT") (literal "$SANDBOX"))
; dyld opens the root directory itself at start; that is a read of "/"'s entries, not below it.
(allow file-read* (literal "/"))
(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))
(allow file-write-data (literal "/dev/null"))
(allow sysctl-read)
(allow file-read* file-write* (subpath "$SANDBOX/work") (subpath "$SANDBOX/data"))
$SOURCES_RULE
(allow network-outbound (remote unix-socket (path-literal "$MODEL_SOCK")))
(allow network-outbound (remote unix-socket (path-literal "$TOOLS_SOCK")))
SB
  WRAPPED="$(env -i TZ=UTC LANG=C HOME="$SANDBOX/data" sandbox-exec -f "$PROFILE" "$ROOT/bin/airgap-probe" \
    $(probe_args "$IN_WORK" "$IN_DATA" "$IN_MODEL" "$IN_TOOLS") 2>&1 || true)"
else
  # Only the binary, the libraries its loader needs, the sandbox and the two sockets are mounted;
  # --unshare-all takes the network namespace with it, so there is no route anywhere, not even
  # to the host's loopback. Pathname Unix sockets still work: they are files, bound in.
  LIBS=()
  while read -r lib; do LIBS+=(--ro-bind "$lib" "$lib"); done < <(ldd "$ROOT/bin/airgap-probe" | grep -oE '/[^ ]+' | sort -u)
  # A later mount covers an earlier one: sources/ bound read-only over the writable workspace.
  SRC_BIND=()
  [[ "$SOURCES" == 1 ]] && SRC_BIND=(--ro-bind "$SANDBOX/work/sources" /lath/work/sources)
  WRAPPED="$(bwrap --unshare-all --die-with-parent --new-session --clearenv \
    --setenv TZ UTC --setenv LANG C --setenv HOME /lath/data \
    --proc /proc --dev /dev \
    "${LIBS[@]}" \
    --ro-bind "$ROOT/bin/airgap-probe" /lath/bin/zeroclaw \
    --bind "$SANDBOX/work" /lath/work ${SRC_BIND[@]+"${SRC_BIND[@]}"} --bind "$SANDBOX/data" /lath/data \
    --bind "$MODEL_SOCK" /lath/model.sock --bind "$TOOLS_SOCK" /lath/tools.sock \
    --chdir /lath/work /lath/bin/zeroclaw \
    $(probe_args "$IN_WORK" "$IN_DATA" "$IN_MODEL" "$IN_TOOLS") 2>&1 || true)"
fi

fail=0
expect() { # <output> <name-prefix> <reached|denied> <label>
  local line
  line="$(grep -F -- "$2" <<<"$1" | head -1 || true)"
  local got; got="$(cut -f2 <<<"$line")"
  if [[ "$got" == "$3" ]]; then printf 'ok    %-9s %-44s %s\n' "$3" "$4" "$(cut -f3 <<<"$line" | cut -c1-60)"
  else printf 'FAIL  %-9s %-44s got %q: %s\n' "$3" "$4" "$got" "$(cut -f3 <<<"$line" | cut -c1-80)"; fail=1; fi
}

echo "== control (unwrapped): must reach what the wrapper will deny"
expect "$CONTROL" "loopback:" reached "host loopback TCP"
expect "$CONTROL" "read:$KEYPAIR" reached "operator keypair"
expect "$CONTROL" "read:$ROOT/outside" reached "file outside the sandbox"
expect "$CONTROL" "unix:$OTHER_SOCK" reached "a third Unix socket"
[[ "$SOURCES" == 1 ]] && expect "$CONTROL" "write:$SANDBOX/work/sources/" reached "write into sources/ on disk"

echo "== wrapped ($SHAPE): the air gap"
expect "$WRAPPED" "tcp:" denied "outbound TCP 1.1.1.1:443"
expect "$WRAPPED" "loopback:" denied "host loopback TCP"
expect "$WRAPPED" "udp:" denied "outbound UDP 1.1.1.1:53"
expect "$WRAPPED" "dns:" denied "DNS example.com"
expect "$WRAPPED" "read:$KEYPAIR" denied "~/.config/solana/id.json"
expect "$WRAPPED" "read:$TRACE_FILE" denied "the trace dir"
expect "$WRAPPED" "read:$ROOT/outside" denied "file outside the sandbox"
expect "$WRAPPED" "read:/etc/hosts" denied "/etc/hosts"
expect "$WRAPPED" "write:$ROOT/outside" denied "write outside the sandbox"
expect "$WRAPPED" "unix:$OTHER_SOCK" denied "a third Unix socket"
expect "$WRAPPED" "exec:" denied "exec /bin/sh"
[[ "$SOURCES" == 1 ]] && expect "$WRAPPED" "write:$IN_WORK/sources/" denied "write into the read-only sources/"
echo "== wrapped ($SHAPE): what the sandbox may do"
[[ "$SOURCES" == 1 ]] && expect "$WRAPPED" "read:$IN_WORK/sources/src.txt" reached "read in sources/"
expect "$WRAPPED" "read:$IN_WORK/note.txt" reached "read in the workspace"
expect "$WRAPPED" "write:$IN_WORK/made.txt" reached "write in the workspace"
expect "$WRAPPED" "write:$IN_DATA/trace.jsonl" reached "write in the step's data dir"
expect "$WRAPPED" "allow:$IN_MODEL" reached "the metering proxy's socket"
expect "$WRAPPED" "allow:$IN_TOOLS" reached "the host-tool socket"
env_line="$(grep '^env:' <<<"$WRAPPED" | cut -f3 || true)"
if [[ "$env_line" == "$ENV_NAMES" ]]; then echo "ok    env       exactly $ENV_NAMES"; else echo "FAIL  env       got $env_line"; fail=1; fi

if [[ $fail -ne 0 ]]; then echo; echo "wrapped output:"; echo "$WRAPPED"; echo "AIR GAP: FAIL ($SHAPE)"; exit 1; fi
echo "AIR GAP: PASS ($SHAPE)"
