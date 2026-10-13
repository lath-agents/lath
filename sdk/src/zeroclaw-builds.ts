// The Lath-patched ZeroClaw builds this repo publishes (docs/ARCHITECTURE.md §12). A
// posture naming a binary not listed here names a build nobody can rebuild from this repo's pins.
export interface ZeroclawBuild {
  triple: string;
  sha256: string;
  patchSet: string;
  note: string;
}

export const ZEROCLAW_UPSTREAM_COMMIT = "dc372cc7a269241a7f7877e04b82dc9d7b4aebb8";

// `patchSet` hashes the patch files whole, mail header included. The six patches' `From:` line names the project,
// and `git apply` never reads it: the same patches under another author line, patch set b1d8206f…, build the same
// bytes (the darwin build re-runs with `--expect` its sha256), and older postures name that set.
export const PUBLISHED_ZEROCLAW_BUILDS: readonly ZeroclawBuild[] = [
  {
    triple: "aarch64-apple-darwin",
    sha256: "42789b08a2c285689aaf2ef7991d9dcdb276038e50751e644cf93f748c850fe3",
    patchSet: "11c267ec1b55b09c6f03ecb3f3dfd74cdfa5b551ee813fa4ac8d7183c6f5bbc7",
    note: "patch 0005 accepts context_window",
  },
  {
    triple: "x86_64-unknown-linux-gnu",
    sha256: "1d374282a9540567b3f2d0ec62bedd7a8d9d714ae63d42e5ff71cb94db5902d1",
    patchSet: "11c267ec1b55b09c6f03ecb3f3dfd74cdfa5b551ee813fa4ac8d7183c6f5bbc7",
    note: "CI zeroclaw-linux run 36098248493",
  },
];

export function publishedBuild(sha256: string): ZeroclawBuild | undefined {
  return PUBLISHED_ZEROCLAW_BUILDS.find((b) => b.sha256 === sha256.toLowerCase());
}
