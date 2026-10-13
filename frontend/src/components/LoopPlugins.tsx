"use client";

/**
 * The devnet explorer link the loop's receipt card (`LoopReceipt`) draws. Every receipt is on devnet,
 * whatever cluster the page is built for.
 *
 * The grant plugins and their _Protocol plugins_ card are on the roadmap, not in this build; a loop
 * whose policy names grants says so in one line on its page.
 */
import type { ReactNode } from "react";
import { EXTERNAL_LINK_CLASS, ExternalIcon } from "@/components/ui";
import { devnetExplorerUrl, shortAddress } from "@/lib/plugins-view";

/** A devnet explorer link, whatever cluster the page is built for: every receipt is on devnet. */
export function DevnetLink({
  kind,
  value,
  children,
  testId,
}: {
  kind: "tx" | "address";
  value: string;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <a
      href={devnetExplorerUrl(kind, value)}
      target="_blank"
      rel="noreferrer"
      title={`Open ${kind === "tx" ? "transaction" : "address"} ${value} in the explorer (devnet)`}
      className={EXTERNAL_LINK_CLASS}
      data-testid={testId}
    >
      {children ?? shortAddress(value)}
      <ExternalIcon />
    </a>
  );
}
