import { redirect } from "next/navigation";
import { legacyRedirect } from "@/lib/workspace";

/**
 * `/agents` is a redirect: the wallet's agents are the workspace's Yours list, each run nested under
 * its agent, so there is no separate list. `?agent=X` lands on `/?item=X`, the same agent selected,
 * so every link to `/agents` — a bookmark, a doc, a breadcrumb — opens on what it points at. On the server, so the old URL
 * never draws a frame of its own.
 */
export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(legacyRedirect("/agents", await searchParams) ?? "/");
}
