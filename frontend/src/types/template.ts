/**
 * The one template shape both sides of the console share: what a run or an agent records about
 * the template version it came from.
 *
 * It is the console's lineage key and not a chain fact — the chain
 * knows `agent_id = sha256(name)` and nothing about where a configuration was copied from.
 *
 * No runtime imports, so a route handler and a React component can both have it.
 */
export interface TemplateLinkView {
  id: string;
  version: number;
  hash: string;
}
