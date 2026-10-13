import Link from "next/link";
import { Button, Card } from "@/components/ui";
import { truncate } from "@/lib/format";
import { chainReadErrorText } from "@/lib/read-error";

/**
 * An id the cluster does not know, said plainly, with no example data standing in — or, when the
 * read itself failed, that it could not be read. The two are kept apart because "not registered"
 * about an agent the indexer simply did not answer for is a false statement about the chain.
 */
export function NotFound({
  kind,
  id,
  error,
  onRetry,
}: {
  kind: "agent";
  id: string;
  error?: unknown;
  onRetry?: () => void;
}) {
  const message = error instanceof Error ? error.message : null;
  if (error) {
    return (
      <Card title={`This ${kind} could not be read`}>
        <div className="space-y-3 text-sm text-ink-2" data-testid="read-failed">
          <p>
            <span className="font-mono text-xs text-ink-1">{truncate(id, 12, 8)}</span>: {chainReadErrorText(error)}
          </p>
          {message && <p className="well px-3 py-2 font-mono text-xs text-ink-3">{message}</p>}
          <div className="flex flex-wrap gap-2">
            {onRetry && (
              <Button variant="secondary" onClick={onRetry}>
                Try again
              </Button>
            )}
            <Link href="/" className="inline-block">
              <Button variant="ghost">Back to your agents</Button>
            </Link>
          </div>
        </div>
      </Card>
    );
  }
  return (
    <Card title={`No ${kind} at this id`}>
      <div className="space-y-3 text-sm text-ink-2" data-testid="not-found">
        <p>
          <span className="font-mono text-xs text-ink-1">{truncate(id, 12, 8)}</span> is not registered on this cluster,
          or the indexer has not seen it yet.
        </p>
        <Link href="/" className="inline-block">
          <Button variant="secondary">Back to your agents</Button>
        </Link>
      </div>
    </Card>
  );
}
