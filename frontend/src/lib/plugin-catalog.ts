/**
 * The protocol plugins the loop form offers, as a section general enough that the next plugins are easy
 * to add. One entry per plugin action, `<plugin>.<action>` as the tool id the chain records. SAS · receipt
 * is the one entry; the other plugins (SAS · attest, Squads · pay, Pyth · feed, Raydium · swap, Jupiter ·
 * swap) are on the roadmap (ROADMAP.md), and the catalog lists only what a start can carry.
 *
 * A `receipt` entry is not a grant (it needs no loop key and no rule): it puts the receipt pointer in
 * the start body, which `LoopStartForm` builds from the console's `attestDemo.receipt`. Grant plugins,
 * whose entries would become `GrantItem`s of the start body's `grants`, are not in this build; the console
 * refuses a start that carries grants.
 *
 * Data only, with no React and no imports, so the node suite (`tests/plugins-view.ts`) holds the catalog
 * without the browser bundle.
 */

/** What picking an entry adds to the start body: the loop receipt's pointer under `receipt`. */
export type PluginKind = "receipt";

export interface PluginCatalogEntry {
  /** `<plugin>.<action>`, the tool id a step's Action carries. */
  id: string;
  kind: PluginKind;
  /** What the chip says: `SAS · receipt`. */
  label: string;
  /** One line, the chip's `title`. */
  blurb: string;
}

/**
 * The loop's receipt on SAS, the SDK's `SAS_RECEIPT_TOOL` spelled here so the catalog stays free of
 * value imports from the SDK. The form's one plugin, and what the `protocol-audit` preset picks.
 */
export const SAS_RECEIPT = "sas.receipt";

export const PLUGIN_CATALOG: readonly PluginCatalogEntry[] = [
  {
    id: SAS_RECEIPT,
    kind: "receipt",
    label: "SAS · receipt",
    blurb:
      "When the decision model says the goal is reached, publish one receipt of the loop on the Solana Attestation Service, pointing at its records.",
  },
];

/** A preset's plugin terms, as `presetPluginPicks` and `presetPluginsOn` read them. */
type PresetPlugins = { receipt?: unknown } | null | undefined;

/**
 * What the console offers that a preset's picks depend on: the receipt, which needs plugins on and a
 * receipt schema the console can sign under (`receiptOffered` in `lib/plugins-view.ts`). Required rather
 * than defaulted, so no caller picks the receipt without having asked the console.
 */
export interface PresetOffers {
  receipt: boolean;
}

/**
 * The catalog ids a preset opens the _Protocol plugins_ section with picked: SAS · receipt for a preset
 * that asks for one (`receipt`) on a console that offers it, and none otherwise, so its form opens as it
 * did before plugins.
 *
 * The receipt only when offered: picked on a console with plugins off it would never be sent, and the
 * form would say so in an amber line; picked on one with no schema the form would hold Start with a red
 * one. Either way the preset would put on screen a receipt the loop would not get. So such a console
 * opens the preset as one without a receipt, and an owner who switches the section on by hand there
 * still sees the honest refusal.
 */
export function presetPluginPicks(preset: PresetPlugins, offers: PresetOffers): string[] {
  const wanted = new Set(preset?.receipt && offers.receipt ? [SAS_RECEIPT] : []);
  return PLUGIN_CATALOG.filter((p) => wanted.has(p.id)).map((p) => p.id);
}

/**
 * Whether a preset opens the section switched on: only where `presetPluginPicks` picks the receipt, so a
 * receipt preset on a console without one opens off with nothing picked and nothing sent.
 */
export function presetPluginsOn(preset: PresetPlugins, offers: PresetOffers): boolean {
  return presetPluginPicks(preset, offers).includes(SAS_RECEIPT);
}

/** The catalog entry for an id, or `undefined`. */
export function pluginEntry(id: string): PluginCatalogEntry | undefined {
  return PLUGIN_CATALOG.find((p) => p.id === id);
}

/** Whether the picks ask for the loop's receipt: SAS · receipt picked while the catalog lists it. */
export function receiptPicked(picked: readonly string[]): boolean {
  return picked.includes(SAS_RECEIPT) && pluginEntry(SAS_RECEIPT) !== undefined;
}
