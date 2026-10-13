# Linux only: run a command, and report the peak RSS (VmHWM) of every process in its tree.
# argv: <report path> -- <command...>
# Writes one line per process to the report ("<pid> <comm> <peak kB>") and exits with the
# command's status. Polls /proc every 2 ms; VmHWM is the kernel's own high-water mark, so a peak
# between two polls is still counted as long as the process is seen once.
import os, subprocess, sys, time

report = sys.argv[1]
cmd = sys.argv[sys.argv.index("--") + 1:]
proc = subprocess.Popen(cmd)
peaks = {}


def children(pid):
    out = []
    try:
        for tid in os.listdir(f"/proc/{pid}/task"):
            with open(f"/proc/{pid}/task/{tid}/children") as f:
                out += [int(c) for c in f.read().split()]
    except OSError:
        pass
    return out


def sample(pid):
    try:
        with open(f"/proc/{pid}/status") as f:
            fields = dict(line.split(":", 1) for line in f if ":" in line)
        hwm = int(fields.get("VmHWM", "0 kB").split()[0])
        name = fields.get("Name", "?").strip()
        prev = peaks.get(pid, (name, 0))
        # Keep the name the process ends with: bwrap's child execs into the binary.
        peaks[pid] = (name, max(prev[1], hwm))
    except OSError:
        pass


while proc.poll() is None:
    stack = [proc.pid]
    while stack:
        p = stack.pop()
        sample(p)
        stack += children(p)
    time.sleep(0.002)
with open(report, "w") as f:
    for pid, (name, kb) in sorted(peaks.items()):
        f.write(f"{pid} {name} {kb}\n")
sys.exit(proc.returncode)
