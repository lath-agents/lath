#!/usr/bin/env bash
# The real Lath binary in the sandbox, reached through airgap.sh:
#
#   zeroclaw/probe/airgap.sh macos-zeroclaw <lath binary>   sandbox-exec, on this Mac
#   zeroclaw/probe/airgap.sh linux-zeroclaw <lath binary>   bwrap --unshare-all, on a Linux host
#
# One step of the contract (zeroclaw/CONTRACT.md) under the wrapper, with the scripted provider on
# m.sock and the stub host-tool listener on t.sock: the step writes a file, reads it back and calls
# store_get, and must complete with exit 0. The wrapper is the probe's, not a looser one: on macOS
# `(deny default)` with no rule for /bin/sh and exactly two network rules, one per socket; on
# Linux every namespace unshared, only the binary, its loader's libraries, the workspace, the
# config directory and the two sockets mounted. Reports peak RSS against the 31 MB upstream
# baseline: `/usr/bin/time -l` on macOS (sandbox-exec execs into the binary, so it is the
# binary's own number); on Linux the /proc high-water mark of the binary and, separately, of the
# bwrap parent that stays resident.
#
# SOURCES=0 is the sandbox of every loop without sources (no sources rule in the wrapper); SOURCES=1
# adds the read-only sources/ subtree (`zeroclaw/CONTRACT.md` §5). Unset runs 0 then 1, as airgap.sh.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="$1"
BIN="$(realpath "$2")"
TOKEN="step-token-0123456789"
# shellcheck source=contract-config.sh
source "$HERE/contract-config.sh"

case "$MODE" in
  macos-zeroclaw) command -v sandbox-exec >/dev/null || { echo "no sandbox-exec" >&2; exit 2; } ;;
  linux-zeroclaw) command -v bwrap >/dev/null || { echo "no bwrap" >&2; exit 2; } ;;
  *) echo "usage: [SOURCES=0|1] $0 macos-zeroclaw|linux-zeroclaw <lath binary>" >&2; exit 2 ;;
esac

SOURCES="${SOURCES:-}"
if [[ -z "$SOURCES" ]]; then
  # Each shape in its own sandbox, so neither is judged on what the other left behind.
  rc=0
  for shape in 0 1; do SOURCES=$shape "${BASH_SOURCE[0]}" "$MODE" "$BIN" || rc=1; done
  exit $rc
fi
[[ "$SOURCES" == 0 || "$SOURCES" == 1 ]] || { echo "SOURCES must be 0 or 1, got $SOURCES" >&2; exit 2; }
SHAPE="$MODE, sources=$SOURCES"

ROOT="$(realpath "$(mktemp -d /tmp/lzz.XXXXXX)")"
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null; done
  if [[ -n "${KEEP:-}" ]]; then echo "kept $ROOT"; else rm -rf "$ROOT"; fi
}
trap cleanup EXIT

SANDBOX="$ROOT/sandbox"
mkdir -p "$ROOT/bin" "$SANDBOX/work" "$SANDBOX/cfg"
if [[ "$SOURCES" == 1 ]]; then
  # A sandbox with sources: the wrapper's read-only rule for sources/ is in
  # place, so the step shows the binary starts, walks its workspace and completes under it. The
  # write refused inside sources/ is the TS suite's case (tests/zeroclaw-runtime.ts, real binary):
  # the scripted provider here has no scenario that writes there.
  mkdir -p "$SANDBOX/work/sources"
  echo "a source" >"$SANDBOX/work/sources/src.txt"
fi
cp "$BIN" "$ROOT/bin/zeroclaw"
MSOCK="$SANDBOX/m.sock"
TSOCK="$SANDBOX/t.sock"
python3 "$HERE/stub-provider.py" "$ROOT/requests.jsonl" "$MSOCK" lath & PIDS+=($!)
python3 "$HERE/stub-tools.py" "$ROOT/tools.jsonl" "$TSOCK" "$TOKEN" & PIDS+=($!)
disown -a
for _ in $(seq 100); do [[ -S "$MSOCK" && -S "$TSOCK" ]] && break; sleep 0.05; done

MESSAGE="Write a note, read it back, and read the greeting."
set +e
if [[ "$MODE" == macos-zeroclaw ]]; then
  contract_config "$SANDBOX/cfg" "$SANDBOX/work" "$MSOCK" "$TSOCK" "$TOKEN"
  PROFILE="$ROOT/sandbox.sb"
  # deny default, and no rule for /bin/sh: the Lath binary has no shell (patch 0005). The sandbox is
  # the workspace and the config directory; the network is the two sockets.
  ancestors=""
  d="$SANDBOX"
  while [[ "$d" != "/" ]]; do ancestors+=" (literal \"$d\")"; d="$(dirname "$d")"; done
  # After the workspace's allow, because Seatbelt lets the last matching rule decide; absent
  # without sources, as in the posture's profile.
  SOURCES_RULE=""
  [[ "$SOURCES" == 1 ]] && SOURCES_RULE="(deny file-write* (subpath \"$SANDBOX/work/sources\"))"
  cat >"$PROFILE" <<SB
(version 1)
(deny default)
(allow process-exec (literal "$ROOT/bin/zeroclaw"))
(allow file-read* (literal "$ROOT/bin/zeroclaw"))
(allow file-read* (subpath "/usr/lib") (subpath "/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes") (subpath "/System/Cryptexes"))
; path canonicalisation walks the sandbox's ancestors; dyld reads "/" itself at start.
(allow file-read-metadata$ancestors (literal "$ROOT/bin"))
(allow file-read* (literal "/"))
(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))
(allow file-write-data (literal "/dev/null"))
(allow sysctl-read)
(allow file-read* file-write* (subpath "$SANDBOX/work") (subpath "$SANDBOX/cfg"))
$SOURCES_RULE
(allow network-outbound (remote unix-socket (path-literal "$MSOCK")))
(allow network-outbound (remote unix-socket (path-literal "$TSOCK")))
SB
  (cd "$SANDBOX/work" && /usr/bin/time -l env -i HOME="$SANDBOX/cfg" TZ=UTC LANG=C \
    ZEROCLAW_NOW=2026-09-24T12:00:00Z ZEROCLAW_OMIT_HOST=1 \
    sandbox-exec -f "$PROFILE" "$ROOT/bin/zeroclaw" --config-dir "$SANDBOX/cfg" agent -a lath -m "$MESSAGE" \
    </dev/null >"$ROOT/stdout" 2>"$ROOT/stderr")
  RC=$?
else
  contract_config "$SANDBOX/cfg" /lath/work /lath/m.sock /lath/t.sock "$TOKEN"
  LIBS=()
  while read -r lib; do LIBS+=(--ro-bind "$lib" "$lib"); done < <(ldd "$ROOT/bin/zeroclaw" | grep -oE '/[^ ]+' | sort -u)
  # A later mount covers an earlier one: sources/ bound read-only over the writable workspace.
  SRC_BIND=()
  [[ "$SOURCES" == 1 ]] && SRC_BIND=(--ro-bind "$SANDBOX/work/sources" /lath/work/sources)
  # Every namespace unshared, the network with them: no route anywhere, not even the host's
  # loopback. The sockets are files, bound in at fixed paths.
  (cd "$SANDBOX/work" && python3 "$HERE/peak-rss.py" "$ROOT/rss" -- \
    bwrap --unshare-all --die-with-parent --new-session --clearenv \
    --setenv HOME /lath/cfg --setenv TZ UTC --setenv LANG C \
    --setenv ZEROCLAW_NOW 2026-09-24T12:00:00Z --setenv ZEROCLAW_OMIT_HOST 1 \
    --proc /proc --dev /dev \
    "${LIBS[@]}" \
    --ro-bind "$ROOT/bin/zeroclaw" /lath/bin/zeroclaw \
    --bind "$SANDBOX/work" /lath/work ${SRC_BIND[@]+"${SRC_BIND[@]}"} --bind "$SANDBOX/cfg" /lath/cfg \
    --bind "$MSOCK" /lath/m.sock --bind "$TSOCK" /lath/t.sock \
    --chdir /lath/work /lath/bin/zeroclaw --config-dir /lath/cfg agent -a lath -m "$MESSAGE" \
    </dev/null >"$ROOT/stdout" 2>"$ROOT/stderr")
  RC=$?
fi
set -e

fail=0
ok() { printf 'ok    %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; fail=1; }
if [[ $RC -eq 0 ]]; then ok "exit 0 under the wrapper"; else bad "exit $RC: $(grep -v '^ ' "$ROOT/stderr" | tail -4)"; fi
if grep -q '^DONE:' "$ROOT/stdout"; then ok "stdout: $(head -1 "$ROOT/stdout")"; else bad "stdout: $(head -2 "$ROOT/stdout")"; fi
if [[ "$(cat "$SANDBOX/work/notes/hello.txt" 2>/dev/null)" == "hello from step one" ]]; then ok "file_write landed, file_read read it"; else bad "notes/hello.txt missing"; fi
n_req="$(wc -l <"$ROOT/requests.jsonl" 2>/dev/null | tr -d ' ' || echo 0)"
if [[ "$n_req" == 4 ]]; then ok "four model requests over m.sock"; else bad "$n_req model requests"; fi
if grep -q '/tools/store.get' "$ROOT/tools.jsonl" 2>/dev/null; then ok "store_get reached the host over t.sock"; else bad "no host-tool call"; fi
if [[ "$SOURCES" == 0 ]]; then
  if [[ ! -e "$SANDBOX/work/sources" ]]; then ok "no sources/ in a sandbox without sources"; else bad "sources/ appeared"; fi
elif [[ "$(cat "$SANDBOX/work/sources/src.txt")" == "a source" && "$(ls "$SANDBOX/work/sources")" == "src.txt" ]]; then
  ok "sources/ is as the host left it"
else bad "sources/ changed: $(ls "$SANDBOX/work/sources")"; fi
if [[ -e "$SANDBOX/cfg/data/state/runtime-trace.jsonl" ]]; then ok "the trace is in the config directory's data/"; else bad "no runtime trace"; fi
# Nothing written in the config directory outside data/ (CONTRACT §4).
stray="$(cd "$SANDBOX/cfg" && find . -mindepth 1 -maxdepth 1 ! -name data ! -name config.toml)"
if [[ -z "$stray" ]]; then ok "nothing written in the config directory outside data/"; else bad "wrote in the config directory: $stray"; fi

echo "== peak RSS (upstream baseline: 31 MB max RSS on macOS)"
if [[ "$MODE" == macos-zeroclaw ]]; then
  rss="$(awk '/maximum resident set size/ {print $1}' "$ROOT/stderr")"
  foot="$(awk '/peak memory footprint/ {print $1}' "$ROOT/stderr")"
  wall="$(awk '/ real / {print $1}' "$ROOT/stderr")"
  awk -v r="${rss:-0}" -v f="${foot:-0}" -v w="$wall" 'BEGIN {
    printf "the Lath binary under sandbox-exec: max RSS %.1f MB, peak footprint %.1f MB, %s s wall\n", r / 1048576, f / 1048576, w }'
else
  awk '{ printf "%-10s pid %-7s peak RSS %.1f MB\n", $2, $1, $3 / 1024 }' "$ROOT/rss"
fi

if [[ $fail -ne 0 ]]; then echo; echo "stderr:"; tail -20 "$ROOT/stderr"; echo "ZEROCLAW IN THE SANDBOX: FAIL ($SHAPE)"; exit 1; fi
echo "ZEROCLAW IN THE SANDBOX: PASS ($SHAPE)"
