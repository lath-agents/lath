import { PublicKey } from "@solana/web3.js";
import { USDC_DECIMALS } from "@lath/sdk/browser";

/** Micro-USDC to a fixed-point string. Never floats: a balance is exact or it is wrong. */
export function formatUsdc(micro: bigint, decimals = USDC_DECIMALS): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const unit = 10n ** BigInt(decimals);
  const whole = (abs / unit).toString();
  const frac = (abs % unit).toString().padStart(decimals, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** A decimal string of whole USDC to micro-USDC, rejecting anything that is not a number. */
export function parseUsdc(input: string, decimals = USDC_DECIMALS): bigint | null {
  const trimmed = input.trim();
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === ".") return null;
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac || "0").padEnd(decimals, "0"));
}

export function truncate(value: string, lead = 6, tail = 6): string {
  return value.length <= lead + tail + 1 ? value : `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function shortKey(key: PublicKey | string): string {
  return truncate(typeof key === "string" ? key : key.toBase58(), 4, 4);
}

/** Unix milliseconds (chain timestamps in Lath) to a local, sortable string. */
export function formatTimestampMs(ms: bigint | number): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return new Date(n).toLocaleString();
}

/** Unix seconds (Solana block times, allowance expiry) to the same. */
export function formatTimestampSecs(secs: bigint | number | null): string {
  if (secs === null) return "—";
  return formatTimestampMs(Number(secs) * 1000);
}

export function relativeToNow(secs: bigint | number): string {
  const delta = Number(secs) * 1000 - Date.now();
  const abs = Math.abs(delta);
  const units: [number, string][] = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [ms, label] of units) {
    if (abs >= ms) {
      const n = Math.round(abs / ms);
      return delta < 0 ? `${n} ${label}${n === 1 ? "" : "s"} ago` : `in ${n} ${label}${n === 1 ? "" : "s"}`;
    }
  }
  return delta < 0 ? "just now" : "in under a minute";
}

/**
 * The "no expiry" an allowance is written with: the billing program has no sentinel for never, so
 * a grant meant to stand is dated a hundred years out. Must equal `MAX_EXPIRATION_DAYS` in
 * `app/api/templates/validate.ts`, which is the server's own ceiling on the same number.
 */
export const INDEFINITE_DAYS = 36_500;

/**
 * Whether an allowance's expiry (unix seconds) is the "no expiry" above rather than a date anyone
 * means: more than fifty years out. Read literally, the hundred-year sentinel shows as _expires in
 * 36498 days_; half of it leaves room for any real date and for a sentinel two days old.
 */
export function isNoExpiry(secs: bigint | number): boolean {
  return Number(secs) * 1000 - Date.now() > (INDEFINITE_DAYS / 2) * 86_400_000;
}
