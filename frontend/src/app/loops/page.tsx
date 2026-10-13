import { redirect } from "next/navigation";
import { legacyRedirect } from "@/lib/workspace";

/**
 * `/loops` is a redirect: a wallet's runs
 * are under their agents in the workspace's Yours list. `?loop=L` lands on `/?run=L`: the server holds
 * no loop registry read here, and the workspace already reads every run of the wallet, so it finds L's
 * agent there and writes `item` into the URL itself (`resolveSelection`).
 */
export default async function LoopsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(legacyRedirect("/loops", await searchParams) ?? "/");
}
