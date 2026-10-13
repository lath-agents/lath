import { redirect } from "next/navigation";
import { legacyRedirect } from "@/lib/workspace";

/**
 * There is no sandboxes index: every sandbox is one loop's, and each sandbox's proof page
 * (`/zeroclaw/<loopId>`) is reached from its run. The route lands on the workspace so a link to it
 * is not a 404.
 */
export default function ZeroClawIndexPage() {
  redirect(legacyRedirect("/zeroclaw", null) ?? "/");
}
