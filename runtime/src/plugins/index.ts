/**
 * SAS's hand-built instructions and account decoders, imported by the console as `@lath/runtime/plugins`
 * and never from the runtime's index: the console's loop receipt, which the host publishes rather than a
 * plugin, is built with them.
 *
 * No grant plugin is in this build: `squads.pay` and `sas.attest`, the `ProtocolPlugin` interface they
 * implement and the runner's hook that calls them are on the roadmap, and the console refuses a start that
 * carries grants. Chains written by granted loops still replay here; this build does not verify what their
 * plugin records say.
 */
export { createAttestationInstruction, decodeAttestation, decodeCredential, decodeSchema, sasFailure } from "./sas";
