"use client";

import { use } from "react";
import { ZeroClawSandboxView, sandboxQuery } from "@/components/ZeroClawSandbox";

/**
 * One loop's sandbox as a page of its own. The view is `ZeroClawSandboxView`, which the loop page
 * also carries as its _ZeroClaw Sandbox_ tab; this route stays for every link already
 * out, the replay record's and the specs' among them.
 */
export default function ZeroClawSandboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ step?: string; sandbox?: string; room?: string }>;
}) {
  const { id } = use(params);
  const { at, member } = sandboxQuery(use(searchParams));
  return <ZeroClawSandboxView id={id} at={at} member={member} />;
}
