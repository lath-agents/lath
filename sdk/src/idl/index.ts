import rawIdl from "./lath.json";
import type { Lath } from "./lath-types";

export type { Lath };

/**
 * The Lath IDL, bundled so consumers need no Anchor workspace or on-chain IDL fetch.
 * Regenerate with `npm run sdk:sync` after `anchor build`.
 */
export const LATH_IDL = rawIdl as unknown as Lath;

/** Program id the bundled IDL was built for. */
export const LATH_PROGRAM_ID = LATH_IDL.address;

import rawBillingIdl from "./lath-billing.json";
import type { LathBilling } from "./lath-billing-types";

export type { LathBilling };

/** The Lath billing IDL (USDC escrow, allowances, sweep). Bundled on the same terms. */
export const LATH_BILLING_IDL = rawBillingIdl as unknown as LathBilling;

/** Program id the bundled billing IDL was built for. */
export const LATH_BILLING_PROGRAM_ID = LATH_BILLING_IDL.address;
