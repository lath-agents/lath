import { configProblems } from "@/lib/config";

/** Says exactly which variable is missing, instead of failing somewhere deep in a query. */
export function SetupBanner() {
  if (configProblems.length === 0) return null;
  return (
    <div className="mt-4 rounded-lg border border-amber-400/25 bg-amber-400/[0.07] px-3 py-2.5 text-xs leading-relaxed text-amber-200">
      <span className="font-semibold">Not configured:</span>{" "}
      <span className="font-mono">{configProblems.join(", ")}</span>. Copy{" "}
      <code className="font-mono">frontend/.env.example</code> to <code className="font-mono">frontend/.env.local</code>{" "}
      and fill it in.
    </div>
  );
}
