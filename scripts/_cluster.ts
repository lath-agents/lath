/**
 * Which cluster an RPC url really points at, whatever it is called.
 *
 * Every script that signs resolves its url from an env var or the solana CLI's config, and none of
 * those says which cluster it is: a keyed Helius mainnet url left in `LATH_DEVNET_RPC`, or a CLI
 * switched to mainnet for something else, would have the seed's funder send real SOL before
 * anything noticed. The genesis hash is the one answer a url cannot misname, so each script asks
 * it before its first transaction.
 */

/** Devnet's and mainnet-beta's genesis hashes. */
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/**
 * Refuse a url whose genesis hash is not the cluster's. The scripts sign, and a CLI configured for
 * mainnet at the moment someone runs them would otherwise spend real SOL there.
 */
export async function assertCluster(
  connection: { getGenesisHash(): Promise<string> },
  genesis: string,
  name: string
): Promise<void> {
  const got = await connection.getGenesisHash();
  if (got !== genesis) throw new Error(`the RPC is not ${name}: genesis ${got}, expected ${genesis}`);
}
