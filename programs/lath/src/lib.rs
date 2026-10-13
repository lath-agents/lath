//! Lath — ZK-compressed agent event log on Solana.
//!
//! Every agent owns one compressed `AgentState` account (hash-chain head + sequence).
//! Every state transition appends a ~150-byte `EventRecord` compressed account whose
//! address is derived from `(agent_id, seq)`, and advances the chain head:
//!
//! ```text
//! head_n = sha256(head_{n-1} || agent_id || seq_le || ts_le || kind || status_le || ref || payload_hash)
//! ```
//!
//! Verbose traces stay off-chain; only `payload_hash` (the typed event payload) is committed.
//! Storage is paid via Light Protocol ZK compression, so no rent is locked per event.
#![allow(unexpected_cfgs)]
#![allow(deprecated)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use light_sdk::{
    account::LightAccount,
    address::v2::derive_address,
    constants::ADDRESS_TREE_V2,
    cpi::{
        v2::{CpiAccounts, LightSystemProgramCpi},
        CpiSigner, InvokeLightSystemProgram, LightCpiInstruction,
    },
    derive_light_cpi_signer,
    instruction::{account_meta::CompressedAccountMeta, PackedAddressTreeInfo, ValidityProof},
    LightDiscriminator, PackedAddressTreeInfoExt,
};

declare_id!("AzAeQaquLE634eGz4kFEosuqGoDpB71D7dhQoAe6BKKz");

pub const LIGHT_CPI_SIGNER: CpiSigner =
    derive_light_cpi_signer!("AzAeQaquLE634eGz4kFEosuqGoDpB71D7dhQoAe6BKKz");

pub const AGENT_SEED: &[u8] = b"agent";
pub const EVENT_SEED: &[u8] = b"event";

/// Timestamps are client-attested (unix ms). Slot time is the trust anchor, so a write may
/// not claim to be more than this far ahead of it. Backdating stays legal — the chain only
/// guarantees order, and a monotonic bound would let a bad clock brick an agent.
pub const MAX_TIMESTAMP_SKEW_MS: i64 = 5 * 60 * 1000;

/// Upper bound on `log_events` batch size.
///
/// The binding constraint is the prover, not transaction size or compute: the pinned Light
/// stack (SPEC §11) only has combined circuits for 1–2 new addresses per validity proof
/// (`v2_combined_32_40_1_{1,2}`), and one batch of N events creates N new addresses. Raising
/// this needs wider non-inclusion circuits, which arrive with `light-sdk` 0.24 / anchor-lang
/// 1.x — see SPEC §10. The program itself is written for any N.
pub const MAX_EVENTS_PER_TX: usize = 2;

/// Longest epoch `commit_epoch` accepts, in steps (`end_seq - start_seq`).
///
/// The LEP1 blob counts its steps in a u32 (SPEC §15), so a longer epoch is one no reader could
/// open. Bounding it here also keeps a single commit from pushing `seq` to `u64::MAX`, which would
/// leave the agent unable to append — every later write fails `checked_add` with `Overflow` — with
/// no `AgentClosed` to say so. Every epoch on devnet is at most 1000 steps.
pub const MAX_EPOCH_SPAN: u64 = u32::MAX as u64;

/// Structure header: one per `(owner, struct_id)`, at `["hdr", owner_address, struct_id]`.
///
/// Every structure address is seeded by the owner's **header address** — its `AgentState`
/// compressed address — rather than its `agent_id`. An id is an arbitrary 32-byte value that
/// anyone can put in an account; the header address is derived by the program and validated by
/// the Light system program, so it is the only attributable half of the pair.
pub const HEADER_SEED: &[u8] = b"hdr";
/// `Log` cells: `["log", owner_address, struct_id, index_le_u64]`.
pub const LOG_SEED: &[u8] = b"log";
/// Cells of a **consumable** `Log` — a queue or mailbox — at `["qlog", …]`.
///
/// Consumability is in the address rather than checked against the header because the address
/// is self-proving: `close_cell` needs no header account to know a cell may be closed, which
/// keeps both the transaction and the SBF stack frame small. It is fixed at creation either
/// way, so nothing is lost.
pub const CONSUMABLE_LOG_SEED: &[u8] = b"qlog";
/// `Map` cells: `["map", owner_address, struct_id, key_slot]`.
pub const MAP_SEED: &[u8] = b"map";

/// The two base structures (SPEC §12).
pub mod struct_kind {
    /// Append-only, index-addressed. Cells are never replaced; closed only if `consumable`.
    pub const LOG: u8 = 0;
    /// Key-addressed, mutable: `put` / `replace` / `close`.
    pub const MAP: u8 = 1;
    pub const MAX: u8 = MAP;
}

/// Whether cell contents are raw or salted commitments. Content-only — existence, count,
/// timing and authority of cells are public either way (SPEC §12 #8).
pub mod struct_mode {
    pub const PUBLIC: u8 = 0;
    pub const PRIVATE: u8 = 1;
    pub const MAX: u8 = PRIVATE;
}

/// Who may create cells in a structure. Closing and replacing are always owner-only: a mailbox
/// lets senders append, never dequeue (SPEC §12).
pub mod append_policy {
    pub const OWNER_ONLY: u8 = 0;
    /// Signer must prove membership in the allow list committed by `StructHeader.policy_ref`.
    pub const ALLOW_LIST: u8 = 1;
    pub const ANYONE: u8 = 2;
    pub const MAX: u8 = ANYONE;
}

/// Operation byte folded into the owner's hash chain. Distinct values keep an append from
/// hashing identically to a replace of the same bytes.
pub mod cell_op {
    pub const CREATE_STRUCT: u8 = 0;
    pub const CREATE: u8 = 1;
    pub const REPLACE: u8 = 2;
    pub const CLOSE: u8 = 3;
    /// Epoch anchor: folds a Merkle root of batched off-chain steps into the owner's chain.
    pub const EPOCH: u8 = 4;
    /// A header's `append_policy` and `policy_ref` rewritten by the owner (`set_append_policy`).
    /// The next free value, so no existing op moves.
    pub const SET_APPEND_POLICY: u8 = 5;
}

/// The four minimal event primitives.
pub mod kind {
    /// Genesis / task assignment. `ref` = caller pubkey.
    pub const GENESIS: u8 = 0;
    /// External side-effect / tool mutation. `ref` = sha256(tool_id). `status` = status code.
    pub const ACTION: u8 = 1;
    /// Delegation / handshake between agents. `ref` = to_agent pubkey.
    pub const DELEGATION: u8 = 2;
    /// Terminal resolution. `ref` = task_id. `status` = 0 success, 1 failed, 2 aborted.
    pub const RESOLUTION: u8 = 3;
    pub const MAX: u8 = RESOLUTION;
}

#[program]
pub mod lath {
    use super::*;

    /// Creates the compressed `AgentState` account for `agent_id`, owned by the signer.
    ///
    /// `created_at` is bounded like every other client-attested timestamp. It is attested
    /// metadata — §4.4 does not read it — but an unbounded one let an agent register at
    /// `i64::MAX`, and this was the only write that skipped the check.
    pub fn register_agent<'info>(
        ctx: Context<'_, '_, '_, 'info, LightAccounts<'info>>,
        proof: ValidityProof,
        address_tree_info: PackedAddressTreeInfo,
        output_state_tree_index: u8,
        agent_id: [u8; 32],
        created_at: i64,
    ) -> Result<()> {
        check_timestamp(created_at)?;
        let cpi_accounts = CpiAccounts::new(
            ctx.accounts.authority.as_ref(),
            ctx.remaining_accounts,
            LIGHT_CPI_SIGNER,
        );
        let address_tree = address_tree_info
            .get_tree_pubkey(&cpi_accounts)
            .map_err(|_| error!(LathError::InvalidAddressTree))?;
        require!(
            address_tree.to_bytes() == ADDRESS_TREE_V2,
            LathError::InvalidAddressTree
        );

        let (address, seed) = derive_address(&[AGENT_SEED, &agent_id], &address_tree, &crate::ID);
        let new_address_params = address_tree_info.into_new_address_params_assigned_packed(seed, Some(0));

        let authority = ctx.accounts.authority.key();
        let mut state =
            LightAccount::<AgentState>::new_init(&crate::ID, Some(address), output_state_tree_index);
        state.authority = authority;
        state.agent_id = agent_id;
        state.seq = 0;
        state.head = [0u8; 32];
        state.created_at = created_at;
        state.updated_at = created_at;

        LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
            .with_light_account(state)?
            .with_new_addresses(&[new_address_params])
            .invoke(cpi_accounts)?;

        emit!(AgentRegistered { agent_id, authority });
        Ok(())
    }

    /// Appends one event: creates an `EventRecord` at address `(agent_id, seq)` and advances
    /// the agent's hash chain. Requires one validity proof covering the agent state (inclusion)
    /// and the new event address (non-inclusion).
    pub fn log_event<'info>(
        ctx: Context<'_, '_, '_, 'info, LightAccounts<'info>>,
        proof: ValidityProof,
        current: AgentState,
        agent_meta: CompressedAccountMeta,
        event_tree_info: PackedAddressTreeInfo,
        event_output_state_tree_index: u8,
        input: EventInput,
    ) -> Result<()> {
        require!(input.kind <= kind::MAX, LathError::InvalidKind);
        check_timestamp(input.timestamp)?;
        require_keys_eq!(current.authority, ctx.accounts.authority.key(), LathError::Unauthorized);

        let mut state = LightAccount::<AgentState>::new_mut(&crate::ID, &agent_meta, current)?;
        let seq = state.seq;
        let agent_id = state.agent_id;
        let head = next_head(&state.head, &agent_id, seq, &input);

        let cpi_accounts = CpiAccounts::new(
            ctx.accounts.authority.as_ref(),
            ctx.remaining_accounts,
            LIGHT_CPI_SIGNER,
        );
        let address_tree = event_tree_info
            .get_tree_pubkey(&cpi_accounts)
            .map_err(|_| error!(LathError::InvalidAddressTree))?;
        require!(
            address_tree.to_bytes() == ADDRESS_TREE_V2,
            LathError::InvalidAddressTree
        );
        // Records are seeded by `["event", owner_id, seq]`. The owner's header is always an
        // agent header, so there is one record address space and no seed to choose.
        let (event_address, seed) = derive_address(
            &[EVENT_SEED, &state.agent_id, &seq.to_le_bytes()],
            &address_tree,
            &crate::ID,
        );
        // The event record is the first account passed to the CPI, so the new address is
        // assigned to account index 0.
        let new_address_params = event_tree_info.into_new_address_params_assigned_packed(seed, Some(0));

        let mut record = LightAccount::<EventRecord>::new_init(
            &crate::ID,
            Some(event_address),
            event_output_state_tree_index,
        );
        record.agent_id = state.agent_id;
        record.seq = seq;
        record.timestamp = input.timestamp;
        record.kind = input.kind;
        record.status = input.status;
        record.reference = input.reference;
        record.payload_hash = input.payload_hash;
        record.head = head;

        state.seq = seq.checked_add(1).ok_or(LathError::Overflow)?;
        state.head = head;
        state.updated_at = input.timestamp;

        LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
            .with_light_account(record)?
            .with_light_account(state)?
            .with_new_addresses(&[new_address_params])
            .invoke(cpi_accounts)?;

        emit!(EventLogged { agent_id, seq, kind: input.kind, head });
        Ok(())
    }

    /// Appends up to `MAX_EVENTS_PER_TX` events in one transaction. Semantically identical to
    /// calling `log_event` once per input — same chain formula, same addresses, same events —
    /// but it spends `AgentState` once and rides a single validity proof covering the agent
    /// account plus every new event address.
    ///
    /// The records are passed to the CPI first, in input order, so event `i` is assigned
    /// account index `i` and the agent state lands last.
    pub fn log_events<'info>(
        ctx: Context<'_, '_, '_, 'info, LightAccounts<'info>>,
        proof: ValidityProof,
        current: AgentState,
        agent_meta: CompressedAccountMeta,
        event_tree_info: PackedAddressTreeInfo,
        event_output_state_tree_index: u8,
        inputs: Vec<EventInput>,
    ) -> Result<()> {
        require!(
            !inputs.is_empty() && inputs.len() <= MAX_EVENTS_PER_TX,
            LathError::InvalidBatchSize
        );
        for input in inputs.iter() {
            require!(input.kind <= kind::MAX, LathError::InvalidKind);
            check_timestamp(input.timestamp)?;
        }
        require_keys_eq!(current.authority, ctx.accounts.authority.key(), LathError::Unauthorized);

        let mut state = LightAccount::<AgentState>::new_mut(&crate::ID, &agent_meta, current)?;
        let agent_id = state.agent_id;
        let first_seq = state.seq;

        let cpi_accounts = CpiAccounts::new(
            ctx.accounts.authority.as_ref(),
            ctx.remaining_accounts,
            LIGHT_CPI_SIGNER,
        );
        let address_tree = event_tree_info
            .get_tree_pubkey(&cpi_accounts)
            .map_err(|_| error!(LathError::InvalidAddressTree))?;
        require!(
            address_tree.to_bytes() == ADDRESS_TREE_V2,
            LathError::InvalidAddressTree
        );

        let mut cpi = LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof);
        let mut new_address_params = Vec::with_capacity(inputs.len());
        let mut head = state.head;

        for (i, input) in inputs.iter().enumerate() {
            let seq = first_seq.checked_add(i as u64).ok_or(LathError::Overflow)?;
            head = next_head(&head, &agent_id, seq, input);

            let (event_address, seed) = derive_address(
                &[EVENT_SEED, &agent_id, &seq.to_le_bytes()],
                &address_tree,
                &crate::ID,
            );
            new_address_params
                .push(event_tree_info.into_new_address_params_assigned_packed(seed, Some(i as u8)));

            let mut record = LightAccount::<EventRecord>::new_init(
                &crate::ID,
                Some(event_address),
                event_output_state_tree_index,
            );
            record.agent_id = agent_id;
            record.seq = seq;
            record.timestamp = input.timestamp;
            record.kind = input.kind;
            record.status = input.status;
            record.reference = input.reference;
            record.payload_hash = input.payload_hash;
            record.head = head;
            cpi = cpi.with_light_account(record)?;

            emit!(EventLogged { agent_id, seq, kind: input.kind, head });
        }

        state.seq = first_seq
            .checked_add(inputs.len() as u64)
            .ok_or(LathError::Overflow)?;
        state.head = head;
        state.updated_at = inputs[inputs.len() - 1].timestamp;

        cpi.with_light_account(state)?
            .with_new_addresses(&new_address_params)
            .invoke(cpi_accounts)?;

        Ok(())
    }

    /// Hands the agent to a new authority. Does **not** touch `seq` or `head`: the chain
    /// formula (SPEC §4.4) is frozen and has no slot for a non-event transition. The rotation
    /// is still provable — `authority` is part of the hashed `AgentState`, so spending the old
    /// account required the old key, and `AuthorityChanged` records the pair in the ledger.
    pub fn set_authority<'info>(
        ctx: Context<'_, '_, '_, 'info, LightAccounts<'info>>,
        proof: ValidityProof,
        current: AgentState,
        agent_meta: CompressedAccountMeta,
        new_authority: Pubkey,
    ) -> Result<()> {
        require_keys_eq!(current.authority, ctx.accounts.authority.key(), LathError::Unauthorized);
        require!(new_authority != Pubkey::default(), LathError::InvalidAuthority);

        let previous = current.authority;
        let mut state = LightAccount::<AgentState>::new_mut(&crate::ID, &agent_meta, current)?;
        let agent_id = state.agent_id;
        state.authority = new_authority;

        let cpi_accounts = CpiAccounts::new(
            ctx.accounts.authority.as_ref(),
            ctx.remaining_accounts,
            LIGHT_CPI_SIGNER,
        );
        LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
            .with_light_account(state)?
            .invoke(cpi_accounts)?;

        emit!(AuthorityChanged { agent_id, previous, new_authority });
        Ok(())
    }

    /// Retires an agent by closing its `AgentState` compressed account. `EventRecord`s are
    /// separate accounts and are untouched, so the history stays readable and replayable —
    /// only the appendable head goes away, and with it the ability to log anything further.
    ///
    /// This is terminal. The leaf is nullified but the address stays in the address tree, so a
    /// later `register_agent` for the same `agent_id` fails non-inclusion: the id is spent for
    /// good. `AgentClosed` records the final `(seq, head)` as the end of the chain.
    pub fn close_agent<'info>(
        ctx: Context<'_, '_, '_, 'info, LightAccounts<'info>>,
        proof: ValidityProof,
        current: AgentState,
        agent_meta: CompressedAccountMeta,
    ) -> Result<()> {
        require_keys_eq!(current.authority, ctx.accounts.authority.key(), LathError::Unauthorized);

        let agent_id = current.agent_id;
        let final_seq = current.seq;
        let final_head = current.head;
        let state = LightAccount::<AgentState>::new_close(&crate::ID, &agent_meta, current)?;

        let cpi_accounts = CpiAccounts::new(
            ctx.accounts.authority.as_ref(),
            ctx.remaining_accounts,
            LIGHT_CPI_SIGNER,
        );
        LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
            .with_light_account(state)?
            .invoke(cpi_accounts)?;

        emit!(AgentClosed { agent_id, final_seq, final_head });
        Ok(())
    }

    /// Cheaper variant: advances the hash chain only (no per-event compressed account).
    /// The record is emitted as an Anchor event and must be replayed from transaction
    /// history; use `log_event` when records must be queryable by address.
    pub fn log_event_compact<'info>(
        ctx: Context<'_, '_, '_, 'info, LightAccounts<'info>>,
        proof: ValidityProof,
        current: AgentState,
        agent_meta: CompressedAccountMeta,
        input: EventInput,
    ) -> Result<()> {
        require!(input.kind <= kind::MAX, LathError::InvalidKind);
        check_timestamp(input.timestamp)?;
        require_keys_eq!(current.authority, ctx.accounts.authority.key(), LathError::Unauthorized);

        let mut state = LightAccount::<AgentState>::new_mut(&crate::ID, &agent_meta, current)?;
        let seq = state.seq;
        let head = next_head(&state.head, &state.agent_id, seq, &input);
        let agent_id = state.agent_id;

        state.seq = seq.checked_add(1).ok_or(LathError::Overflow)?;
        state.head = head;
        state.updated_at = input.timestamp;

        let cpi_accounts = CpiAccounts::new(
            ctx.accounts.authority.as_ref(),
            ctx.remaining_accounts,
            LIGHT_CPI_SIGNER,
        );
        LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
            .with_light_account(state)?
            .invoke(cpi_accounts)?;

        emit!(EventLogged { agent_id, seq, kind: input.kind, head });
        Ok(())
    }

    /// Creates a structure header at `["hdr", owner_address, struct_id]`, where `owner_address` is
    /// the owner's `AgentState` compressed address, not its id (see `HEADER_SEED` for why).
    ///
    /// Spending the owner's `AgentState` is what proves the caller may create a structure in
    /// this owner's namespace — headers are not permissionless, or anyone could plant an
    /// `append_policy = ANYONE` structure under someone else's id. The creation folds into the
    /// owner's chain (SPEC §12 #6) with `op = CREATE_STRUCT`, so an auditor sees the mode and
    /// the policy a structure was created with, not just its cells.
    ///
    /// Any kind may carry a non-owner `append_policy` (`ALLOW_LIST` or `ANYONE`), not only a
    /// Mailbox: an open registry is a deliberate, tested design (`tests/security.ts`), and SPEC §12
    /// #12 states it. `replace_cell` and `close_cell` stay owner-only whatever the policy. Every
    /// non-owner append spends the owner's `AgentState`, so it moves the owner's seq and head.
    pub fn create_struct<'info>(
        ctx: Context<'_, '_, '_, 'info, LightAccounts<'info>>,
        proof: ValidityProof,
        current: AgentState,
        agent_meta: CompressedAccountMeta,
        header_tree_info: PackedAddressTreeInfo,
        header_output_state_tree_index: u8,
        params: StructParams,
    ) -> Result<()> {
        require!(params.kind <= struct_kind::MAX, LathError::InvalidStructKind);
        require!(params.mode <= struct_mode::MAX, LathError::InvalidStructMode);
        require!(
            params.append_policy <= append_policy::MAX,
            LathError::InvalidAppendPolicy
        );
        check_timestamp(params.created_at)?;
        require_keys_eq!(current.authority, ctx.accounts.authority.key(), LathError::Unauthorized);

        let mut state = LightAccount::<AgentState>::new_mut(&crate::ID, &agent_meta, current)?;
        let owner_id = state.agent_id;
        let op_seq = state.seq;

        let cpi_accounts = CpiAccounts::new(
            ctx.accounts.authority.as_ref(),
            ctx.remaining_accounts,
            LIGHT_CPI_SIGNER,
        );
        let address_tree = checked_address_tree(&header_tree_info, &cpi_accounts)?;
        // Seeded by the owner's *header address*, not its id: an id is a field anyone can put
        // in an account, so seeding by id would let two owners share one address space. The
        // header address is derived by the program, and the Light system
        // program has validated it as part of `agent_meta`.
        let (header_address, seed) = derive_address(
            &[HEADER_SEED, &agent_meta.address, &params.struct_id],
            &address_tree,
            &crate::ID,
        );
        let new_address_params = header_tree_info.into_new_address_params_assigned_packed(seed, Some(0));

        let mut header = LightAccount::<StructHeader>::new_init(
            &crate::ID,
            Some(header_address),
            header_output_state_tree_index,
        );
        header.owner_id = owner_id;
        header.struct_id = params.struct_id;
        header.kind = params.kind;
        header.mode = params.mode;
        header.len_or_count = 0;
        header.created_op_seq = op_seq;
        header.consumable = params.consumable;
        header.append_policy = params.append_policy;
        header.policy_ref = params.policy_ref;

        // The header's own bytes are what gets folded, in the same shape a cell would be.
        let head = next_header_head(&state.head, cell_op::CREATE_STRUCT, &header, op_seq);

        state.seq = op_seq.checked_add(1).ok_or(LathError::Overflow)?;
        state.head = head;
        state.updated_at = params.created_at;

        LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
            .with_light_account(header)?
            .with_light_account(state)?
            .with_new_addresses(&[new_address_params])
            .invoke(cpi_accounts)?;

        emit!(StructCreated {
            owner_id,
            struct_id: params.struct_id,
            kind: params.kind,
            mode: params.mode,
            op_seq,
            head,
        });
        Ok(())
    }

    /// Appends a `Log` cell or `put`s a `Map` cell. Fails if the address already exists, which
    /// is exactly the non-membership proof a `Set` needs.
    pub fn create_cell<'info>(
        ctx: Context<'_, '_, '_, 'info, LightAccounts<'info>>,
        proof: ValidityProof,
        current: AgentState,
        agent_meta: CompressedAccountMeta,
        header_current: StructHeader,
        header_meta: CompressedAccountMeta,
        cell_tree_info: PackedAddressTreeInfo,
        cell_output_state_tree_index: u8,
        input: CellInput,
    ) -> Result<()> {
        // The body lives in its own frame: an instruction that deserialises an `AgentState`, a
        // `StructHeader`, a `CellInput` and two metas has little of the 4 KB SBF frame left for
        // the Light CPI machinery (`cargo build-sbf` fails the build if it overflows).
        create_cell_inner(
            &ctx,
            proof,
            current,
            &agent_meta,
            header_current,
            &header_meta,
            &cell_tree_info,
            cell_output_state_tree_index,
            &input,
        )
    }

    /// Rewrites a `Map` cell in place (nullify + re-create at the same address), bumping its
    /// version. `Log` cells are append-only and are refused.
    pub fn replace_cell<'info>(
        ctx: Context<'_, '_, '_, 'info, LightAccounts<'info>>,
        proof: ValidityProof,
        current: AgentState,
        agent_meta: CompressedAccountMeta,
        cell_current: Cell,
        cell_meta: CompressedAccountMeta,
        input: CellInput,
    ) -> Result<()> {
        check_timestamp(input.timestamp)?;
        require_keys_eq!(current.authority, ctx.accounts.authority.key(), LathError::Unauthorized);

        let mut state = LightAccount::<AgentState>::new_mut(&crate::ID, &agent_meta, current)?;
        let owner_id = state.agent_id;
        let op_seq = state.seq;
        let struct_id = cell_current.struct_id;

        let cpi_accounts = CpiAccounts::new(
            ctx.accounts.authority.as_ref(),
            ctx.remaining_accounts,
            LIGHT_CPI_SIGNER,
        );
        // No header is needed, and passing one would be worse than useless: an *unspent*
        // account is not validated by the Light system program, so a caller could hand over a
        // fabricated header. The cell's own address is the proof of what it is — a Map cell is
        // exactly one that lives at `["map", owner, struct_id, key_slot]`, and `cell_meta`
        // *is* validated because the cell is spent.
        require!(
            cell_current.owner_id == owner_id,
            LathError::CellMismatch
        );
        let (map_address, _) = derive_address(
            &[MAP_SEED, &agent_meta.address, &struct_id, &cell_current.key_slot],
            &address_tree_v2(),
            &crate::ID,
        );
        require!(cell_meta.address == map_address, LathError::LogNotReplaceable);

        let version = cell_current
            .index_or_version
            .checked_add(1)
            .ok_or(LathError::Overflow)?;
        let mut cell = LightAccount::<Cell>::new_mut(&crate::ID, &cell_meta, cell_current)?;
        cell.index_or_version = version;
        cell.op_seq = op_seq;
        cell.timestamp = input.timestamp;
        cell.tag = input.tag;
        cell.status = input.status;
        // `key_slot` is what addresses the cell, so a replace cannot move it.
        cell.value_slot = input.value_slot;
        let head = next_cell_head(&state.head, cell_op::REPLACE, &cell);
        cell.head = head;

        state.seq = op_seq.checked_add(1).ok_or(LathError::Overflow)?;
        state.head = head;
        state.updated_at = input.timestamp;

        LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
            .with_light_account(cell)?
            .with_light_account(state)?
            .invoke(cpi_accounts)?;

        emit!(CellWritten {
            owner_id,
            struct_id,
            index_or_version: version,
            op_seq,
            op: cell_op::REPLACE,
            head,
        });
        Ok(())
    }

    /// Closes a cell: a `Map` delete, or the provable dequeue of a consumable `Log`. The cell
    /// is gone from the indexer afterwards, so the fold — and `CellWritten` — are the only
    /// record that it existed and was consumed (SPEC §12 #11).
    ///
    /// No header is involved. A cell's address already says whether it may be closed: only
    /// `Map` cells and the cells of a consumable `Log` live at addresses this can re-derive,
    /// and `cell_meta` is validated by the Light system program because the cell is spent.
    /// An unspent header passed as instruction data would prove nothing.
    pub fn close_cell<'info>(
        ctx: Context<'_, '_, '_, 'info, LightAccounts<'info>>,
        proof: ValidityProof,
        current: AgentState,
        agent_meta: CompressedAccountMeta,
        cell_current: Cell,
        cell_meta: CompressedAccountMeta,
        timestamp: i64,
    ) -> Result<()> {
        check_timestamp(timestamp)?;
        require_keys_eq!(current.authority, ctx.accounts.authority.key(), LathError::Unauthorized);

        let mut state = LightAccount::<AgentState>::new_mut(&crate::ID, &agent_meta, current)?;
        let owner_id = state.agent_id;
        let op_seq = state.seq;
        let struct_id = cell_current.struct_id;
        let index_or_version = cell_current.index_or_version;
        require!(cell_current.owner_id == owner_id, LathError::CellMismatch);
        require!(
            closable(&agent_meta.address, &cell_current, &cell_meta.address),
            LathError::NotConsumable
        );

        // What is folded is the cell as it stood, under the CLOSE op.
        let head = next_cell_head(&state.head, cell_op::CLOSE, &cell_current);

        state.seq = op_seq.checked_add(1).ok_or(LathError::Overflow)?;
        state.head = head;
        state.updated_at = timestamp;

        let cell = LightAccount::<Cell>::new_close(&crate::ID, &cell_meta, cell_current)?;

        let cpi_accounts = CpiAccounts::new(
            ctx.accounts.authority.as_ref(),
            ctx.remaining_accounts,
            LIGHT_CPI_SIGNER,
        );
        LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
            .with_light_account(cell)?
            .with_light_account(state)?
            .invoke(cpi_accounts)?;

        emit!(CellWritten {
            owner_id,
            struct_id,
            index_or_version,
            op_seq,
            op: cell_op::CLOSE,
            head,
        });
        Ok(())
    }

    /// Anchors an off-chain epoch of batched micro-agent steps by folding a single
    /// Merkle root into the agent's hash chain. The epoch covers `[start_seq, end_seq)`
    /// and the chain head jumps from `start_seq` to `end_seq` in one step.
    ///
    /// No `EventRecord` compressed accounts are created — the individual steps live
    /// off-chain in `TraceStore` batch blobs. Only the epoch root is committed.
    ///
    /// Chain formula (domain-separated from `next_head` and `next_cell_head`):
    /// ```text
    /// head = sha256(prev_head || agent_id || "lattice.epoch" || start_seq_le || end_seq_le || epoch_root)
    /// ```
    ///
    /// The `"lattice.epoch"` tag is a frozen legacy string, kept byte-for-byte through the rename
    /// to Lath: it is a hash input of every epoch already committed on devnet, so respelling it
    /// would break the audit of chains that are already written.
    pub fn commit_epoch<'info>(
        ctx: Context<'_, '_, '_, 'info, LightAccounts<'info>>,
        proof: ValidityProof,
        current: AgentState,
        agent_meta: CompressedAccountMeta,
        epoch_root: [u8; 32],
        start_seq: u64,
        end_seq: u64,
    ) -> Result<()> {
        check_epoch_bounds(current.seq, start_seq, end_seq)?;
        require_keys_eq!(current.authority, ctx.accounts.authority.key(), LathError::Unauthorized);

        let mut state = LightAccount::<AgentState>::new_mut(&crate::ID, &agent_meta, current)?;
        let agent_id = state.agent_id;
        let head = epoch_head(&state.head, &agent_id, &epoch_root, start_seq, end_seq);

        state.seq = end_seq;
        state.head = head;
        state.updated_at = Clock::get()?
            .unix_timestamp
            .checked_mul(1000)
            .ok_or(LathError::Overflow)?;

        let cpi_accounts = CpiAccounts::new(
            ctx.accounts.authority.as_ref(),
            ctx.remaining_accounts,
            LIGHT_CPI_SIGNER,
        );
        LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
            .with_light_account(state)?
            .invoke(cpi_accounts)?;

        emit!(EpochCommitted { agent_id, epoch_root, start_seq, end_seq, head });
        Ok(())
    }

    /// Rewrites a structure header's `append_policy` and `policy_ref` in place. Owner-only.
    ///
    /// An older `runtime-inbox` header may be `ANYONE`, and without this nothing could change that:
    /// every funded key could go on appending to it, each append spending the owner's `AgentState`
    /// and advancing its seq and head. The owner can take it to `OWNER_ONLY` (what the runtime
    /// creates) or to an `ALLOW_LIST`, and the structure stays usable. Closing the header would spend
    /// its address for good — the address tree never drops one — so the runtime's `ensureCreated`
    /// would find no header and fail to re-create it on every later session.
    ///
    /// The header is spent and re-created at the same address with every other field as it was:
    /// `len_or_count`, `created_op_seq`, kind, mode and consumability are untouched, so the cells
    /// already in the structure and the address of the next one do not move. The rewrite folds into
    /// the owner's chain under `op = SET_APPEND_POLICY`, over the header's bytes as they now stand
    /// and this write's `op_seq` — the preimage `create_struct` folds, under a different op byte —
    /// so an auditor sees the policy change in the chain and not only in the account. The event
    /// carries the policy it replaced, which a replay needs to recompute the `CREATE_STRUCT` fold
    /// from a header that no longer shows its creation policy.
    pub fn set_append_policy<'info>(
        ctx: Context<'_, '_, '_, 'info, LightAccounts<'info>>,
        proof: ValidityProof,
        current: AgentState,
        agent_meta: CompressedAccountMeta,
        header_current: StructHeader,
        header_meta: CompressedAccountMeta,
        new_policy: u8,
        new_policy_ref: [u8; 32],
        timestamp: i64,
    ) -> Result<()> {
        // Its own frame for the reason `create_cell` has one: an `AgentState`, a `StructHeader` and
        // two metas leave little of the 4 KB SBF stack for the Light CPI builder.
        set_append_policy_inner(
            &ctx,
            proof,
            current,
            &agent_meta,
            header_current,
            &header_meta,
            new_policy,
            &new_policy_ref,
            timestamp,
        )
    }
}

/// Body of `set_append_policy`. See the note there on why it is a separate function.
#[inline(never)]
fn set_append_policy_inner<'info>(
    ctx: &Context<'_, '_, '_, 'info, LightAccounts<'info>>,
    proof: ValidityProof,
    current: AgentState,
    agent_meta: &CompressedAccountMeta,
    header_current: StructHeader,
    header_meta: &CompressedAccountMeta,
    new_policy: u8,
    new_policy_ref: &[u8; 32],
    timestamp: i64,
) -> Result<()> {
    require!(new_policy <= append_policy::MAX, LathError::InvalidAppendPolicy);
    check_timestamp(timestamp)?;
    // The owner's key, whatever the header's current policy says: a policy governs who may
    // append, and rewriting it is the owner's alone, like `replace_cell` and `close_cell`.
    require_keys_eq!(current.authority, ctx.accounts.authority.key(), LathError::Unauthorized);

    let mut state = LightAccount::<AgentState>::new_mut(&crate::ID, agent_meta, current)?;
    let owner_id = state.agent_id;
    let op_seq = state.seq;
    let struct_id = header_current.struct_id;
    let previous_policy = header_current.append_policy;
    let previous_policy_ref = header_current.policy_ref;
    // No address is created, so there is no `PackedAddressTreeInfo` to read a tree from; every
    // header this program creates is pinned to `ADDRESS_TREE_V2`, so that is the one to re-derive
    // against (as `replace_cell` does). The header is spent, so `header_meta` is validated.
    require_header(
        &header_current,
        &owner_id,
        &agent_meta.address,
        header_meta,
        &address_tree_v2(),
    )?;

    let mut header = LightAccount::<StructHeader>::new_mut(&crate::ID, header_meta, header_current)?;
    header.append_policy = new_policy;
    header.policy_ref = *new_policy_ref;

    let head = next_header_head(&state.head, cell_op::SET_APPEND_POLICY, &header, op_seq);

    state.seq = op_seq.checked_add(1).ok_or(LathError::Overflow)?;
    state.head = head;
    state.updated_at = timestamp;

    let cpi_accounts = CpiAccounts::new(
        ctx.accounts.authority.as_ref(),
        ctx.remaining_accounts,
        LIGHT_CPI_SIGNER,
    );
    LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
        .with_light_account(header)?
        .with_light_account(state)?
        .invoke(cpi_accounts)?;

    emit!(AppendPolicySet {
        owner_id,
        struct_id,
        previous_policy,
        previous_policy_ref,
        append_policy: new_policy,
        policy_ref: *new_policy_ref,
        op_seq,
        head,
    });
    Ok(())
}

/// Body of `create_cell`. See the note there on why it is a separate function.
#[inline(never)]
fn create_cell_inner<'info>(
    ctx: &Context<'_, '_, '_, 'info, LightAccounts<'info>>,
    proof: ValidityProof,
    current: AgentState,
    agent_meta: &CompressedAccountMeta,
    header_current: StructHeader,
    header_meta: &CompressedAccountMeta,
    cell_tree_info: &PackedAddressTreeInfo,
    cell_output_state_tree_index: u8,
    input: &CellInput,
) -> Result<()> {
    check_timestamp(input.timestamp)?;

    let signer = ctx.accounts.authority.key();
    match header_current.append_policy {
        append_policy::OWNER_ONLY => {
            require_keys_eq!(current.authority, signer, LathError::Unauthorized)
        }
        append_policy::ALLOW_LIST => require!(
            signer == current.authority
                || merkle_root_of(&hashv(&[signer.as_ref()]).to_bytes(), &input.allow_list_proof)
                    == header_current.policy_ref,
            LathError::AppendNotAllowed
        ),
        _ => {}
    }

    let mut state = LightAccount::<AgentState>::new_mut(&crate::ID, agent_meta, current)?;
    let owner_id = state.agent_id;
    let op_seq = state.seq;
    let struct_id = header_current.struct_id;
    let is_log = header_current.kind == struct_kind::LOG;
    let index = if is_log { header_current.len_or_count } else { 0 };

    let cpi_accounts = CpiAccounts::new(
        ctx.accounts.authority.as_ref(),
        ctx.remaining_accounts,
        LIGHT_CPI_SIGNER,
    );
    let address_tree = checked_address_tree(cell_tree_info, &cpi_accounts)?;
    require_header(&header_current, &owner_id, &agent_meta.address, header_meta, &address_tree)?;

    let (cell_address, seed) = derive_cell_address(
        &header_current,
        &agent_meta.address,
        index,
        &input.key_slot,
        &address_tree,
    );
    let new_address_params = cell_tree_info.into_new_address_params_assigned_packed(seed, Some(0));

    let mut header = LightAccount::<StructHeader>::new_mut(&crate::ID, header_meta, header_current)?;
    header.len_or_count = header.len_or_count.checked_add(1).ok_or(LathError::Overflow)?;

    let mut cell =
        LightAccount::<Cell>::new_init(&crate::ID, Some(cell_address), cell_output_state_tree_index);
    cell.owner_id = owner_id;
    cell.struct_id = struct_id;
    cell.index_or_version = index;
    cell.op_seq = op_seq;
    cell.timestamp = input.timestamp;
    cell.tag = input.tag;
    cell.status = input.status;
    cell.key_slot = input.key_slot;
    cell.value_slot = input.value_slot;
    let head = next_cell_head(&state.head, cell_op::CREATE, &cell);
    cell.head = head;

    state.seq = op_seq.checked_add(1).ok_or(LathError::Overflow)?;
    state.head = head;
    state.updated_at = input.timestamp;

    invoke_create_cell(cpi_accounts, proof, cell, header, state, new_address_params)?;

    emit!(CellWritten {
        owner_id,
        struct_id,
        index_or_version: index,
        op_seq,
        op: cell_op::CREATE,
        head,
    });
    Ok(())
}

/// The CPI half of `create_cell`, in its own frame — the builder and the serialized accounts
/// are what push the instruction over the 4 KB SBF stack limit.
#[inline(never)]
fn invoke_create_cell<'info>(
    cpi_accounts: CpiAccounts<'_, 'info>,
    proof: ValidityProof,
    cell: LightAccount<Cell>,
    header: LightAccount<StructHeader>,
    state: LightAccount<AgentState>,
    new_address_params: light_sdk::address::NewAddressParamsAssignedPacked,
) -> Result<()> {
    LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
        .with_light_account(cell)?
        .with_light_account(header)?
        .with_light_account(state)?
        .with_new_addresses(&[new_address_params])
        .invoke(cpi_accounts)?;
    Ok(())
}

/// The address tree named by a `PackedAddressTreeInfo`, checked against `ADDRESS_TREE_V2`.
#[inline(never)]
fn checked_address_tree(
    info: &PackedAddressTreeInfo,
    cpi_accounts: &CpiAccounts,
) -> Result<Pubkey> {
    let tree = info
        .get_tree_pubkey(cpi_accounts)
        .map_err(|_| error!(LathError::InvalidAddressTree))?;
    require!(
        tree.to_bytes() == ADDRESS_TREE_V2,
        LathError::InvalidAddressTree
    );
    Ok(tree)
}

/// `replace_cell` and `close_cell` create no addresses, so they carry no
/// `PackedAddressTreeInfo` to read a tree from. They still need one to re-derive the header's
/// and the cell's addresses — and there is only one legal answer, since every address this
/// program creates is pinned to `ADDRESS_TREE_V2` at creation.
fn address_tree_v2() -> Pubkey {
    Pubkey::new_from_array(ADDRESS_TREE_V2)
}

/// The header must be *this* owner's header for *this* `struct_id`.
///
/// `header_current` is instruction data, so the caller could hand over any header they can
/// prove exists — including one from a structure with a laxer `append_policy`. Re-deriving the
/// address it claims to live at, and comparing against the meta the Light system program
/// validates, is what binds it (the same technique `HEADER_SEED` relies on).
#[inline(never)]
fn require_header(
    header: &StructHeader,
    owner_id: &[u8; 32],
    owner_address: &[u8; 32],
    meta: &CompressedAccountMeta,
    address_tree: &Pubkey,
) -> Result<()> {
    require!(header.owner_id == *owner_id, LathError::HeaderMismatch);
    let (address, _) = derive_address(
        &[HEADER_SEED, owner_address, &header.struct_id],
        address_tree,
        &crate::ID,
    );
    require!(meta.address == address, LathError::HeaderMismatch);
    Ok(())
}

/// Whether a cell sits at an address that permits closing: a `Map` key, or an index in a
/// consumable `Log`. A plain `Log` cell matches neither, which is what makes it permanent.
#[inline(never)]
fn closable(owner_address: &[u8; 32], cell: &Cell, address: &[u8; 32]) -> bool {
    let tree = address_tree_v2();
    let (map_address, _) = derive_address(
        &[MAP_SEED, owner_address, &cell.struct_id, &cell.key_slot],
        &tree,
        &crate::ID,
    );
    if *address == map_address {
        return true;
    }
    let (queue_address, _) = derive_address(
        &[
            CONSUMABLE_LOG_SEED,
            owner_address,
            &cell.struct_id,
            &cell.index_or_version.to_le_bytes(),
        ],
        &tree,
        &crate::ID,
    );
    *address == queue_address
}

/// `Log` cells are addressed by index, `Map` cells by key slot.
#[inline(never)]
fn derive_cell_address(
    header: &StructHeader,
    owner_address: &[u8; 32],
    index: u64,
    key_slot: &[u8; 32],
    address_tree: &Pubkey,
) -> ([u8; 32], light_sdk::address::AddressSeed) {
    if header.kind == struct_kind::LOG {
        let seed = if header.consumable { CONSUMABLE_LOG_SEED } else { LOG_SEED };
        derive_address(
            &[seed, owner_address, &header.struct_id, &index.to_le_bytes()],
            address_tree,
            &crate::ID,
        )
    } else {
        derive_address(
            &[MAP_SEED, owner_address, &header.struct_id, key_slot],
            address_tree,
            &crate::ID,
        )
    }
}

/// Folds one cell write into the owner's chain (SPEC §12):
/// `head_{n+1} = sha256(head_n ‖ struct_id ‖ op ‖ cell_bytes_without_head)`.
///
/// Additive: the v0.1 `next_head` still governs `log_event*`, so chains written before cells
/// existed verify byte-for-byte.
#[inline(never)]
pub fn next_cell_head(prev: &[u8; 32], op: u8, c: &Cell) -> [u8; 32] {
    hashv(&[prev, &c.struct_id, &[op], &cell_preimage(c)]).to_bytes()
}

/// Every cell field except `head`, in declaration order.
#[inline(never)]
fn cell_preimage(c: &Cell) -> Vec<u8> {
    let mut out = Vec::with_capacity(187);
    out.extend_from_slice(&c.owner_id);
    out.extend_from_slice(&c.struct_id);
    out.extend_from_slice(&c.index_or_version.to_le_bytes());
    out.extend_from_slice(&c.op_seq.to_le_bytes());
    out.extend_from_slice(&c.timestamp.to_le_bytes());
    out.push(c.tag);
    out.extend_from_slice(&c.status.to_le_bytes());
    out.extend_from_slice(&c.key_slot);
    out.extend_from_slice(&c.value_slot);
    out
}

/// Folds one header write into the owner's chain — its creation (`CREATE_STRUCT`) or a policy
/// rewrite (`SET_APPEND_POLICY`): `head_{n+1} = sha256(head_n ‖ struct_id ‖ op ‖ header_preimage)`.
/// Must match `computeStructHead` in `sdk/src/cells.ts` byte-for-byte; the creation fold is the
/// same bytes it always was, only spelled once.
#[inline(never)]
pub fn next_header_head(prev: &[u8; 32], op: u8, h: &StructHeader, op_seq: u64) -> [u8; 32] {
    hashv(&[prev, &h.struct_id, &[op], &header_preimage(h, op_seq)]).to_bytes()
}

/// The header's policy fields (108 bytes: owner_id, struct_id, op_seq, kind, mode, consumable,
/// append_policy, policy_ref), folded through the same `sha256(prev ‖ struct_id ‖ op ‖ bytes)`
/// shape as a cell. Its length differs from every other fold preimage (SPEC §12), so the two
/// cannot collide. `len_or_count` is left out — always 0 at creation, and a policy rewrite is
/// not a write to the cells it counts; `op_seq` is the owner's counter at the write being
/// folded, which is `created_op_seq` only for the creation. The capacity is the header account's
/// size, not this preimage's.
#[inline(never)]
fn header_preimage(h: &StructHeader, op_seq: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(116);
    out.extend_from_slice(&h.owner_id);
    out.extend_from_slice(&h.struct_id);
    out.extend_from_slice(&op_seq.to_le_bytes());
    out.push(h.kind);
    out.push(h.mode);
    out.push(h.consumable as u8);
    out.push(h.append_policy);
    out.extend_from_slice(&h.policy_ref);
    out
}

/// Merkle root implied by a leaf and its sibling path, pairing sorted so the proof carries no
/// direction bits. Same convention as the SDK's epoch rollup (`sdk/src/rollup.ts`).
#[inline(never)]
fn merkle_root_of(leaf: &[u8; 32], proof: &[[u8; 32]]) -> [u8; 32] {
    let mut node = *leaf;
    for sibling in proof {
        node = if node <= *sibling {
            hashv(&[&node, sibling]).to_bytes()
        } else {
            hashv(&[sibling, &node]).to_bytes()
        };
    }
    node
}

/// The bounds `commit_epoch` checks before it folds: a non-empty span, starting at the agent's
/// current `seq`, no longer than `MAX_EPOCH_SPAN`. A function so a unit test can pin all three.
pub fn check_epoch_bounds(seq: u64, start_seq: u64, end_seq: u64) -> Result<()> {
    require!(end_seq > start_seq, LathError::InvalidEpochBounds);
    require!(start_seq == seq, LathError::EpochSeqMismatch);
    require!(end_seq - start_seq <= MAX_EPOCH_SPAN, LathError::EpochTooLong);
    Ok(())
}

/// Rejects a write whose client-attested timestamp is further than `MAX_TIMESTAMP_SKEW_MS`
/// ahead of the cluster clock. Called by every appending instruction.
pub fn check_timestamp(timestamp: i64) -> Result<()> {
    let now_ms = Clock::get()?
        .unix_timestamp
        .checked_mul(1000)
        .ok_or(LathError::Overflow)?;
    let limit = now_ms
        .checked_add(MAX_TIMESTAMP_SKEW_MS)
        .ok_or(LathError::Overflow)?;
    require!(timestamp <= limit, LathError::TimestampTooFarInFuture);
    Ok(())
}

/// Chain step. Must match `computeHead` in the TypeScript SDK byte-for-byte.
pub fn next_head(prev: &[u8; 32], agent_id: &[u8; 32], seq: u64, e: &EventInput) -> [u8; 32] {
    hashv(&[
        prev,
        agent_id,
        &seq.to_le_bytes(),
        &e.timestamp.to_le_bytes(),
        &[e.kind],
        &e.status.to_le_bytes(),
        &e.reference,
        &e.payload_hash,
    ])
    .to_bytes()
}

/// Hash chain step for an epoch commit. Domain-separated from `next_head` by the
/// `"lattice.epoch"` tag, so an epoch anchor and an individual event with colliding fields
/// never produce the same digest. Must match `computeEpochHead` in the TypeScript SDK.
///
/// The tag is frozen: it is hashed into every epoch head on devnet, and `computeEpochHead` hashes
/// the same bytes, so changing it would break the audit of every chain already written.
pub fn epoch_head(
    prev: &[u8; 32],
    agent_id: &[u8; 32],
    epoch_root: &[u8; 32],
    start_seq: u64,
    end_seq: u64,
) -> [u8; 32] {
    hashv(&[
        prev,
        agent_id,
        b"lattice.epoch",
        &start_seq.to_le_bytes(),
        &end_seq.to_le_bytes(),
        epoch_root,
    ])
    .to_bytes()
}

#[derive(Accounts)]
pub struct LightAccounts<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
}

/// Instruction payload for one event. 75 bytes (SPEC §4.3).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default)]
pub struct EventInput {
    /// Client-attested unix timestamp (ms).
    pub timestamp: i64,
    /// One of `kind::*`.
    pub kind: u8,
    /// ACTION: tool status code. RESOLUTION: 0 success / 1 failed / 2 aborted. Else 0.
    pub status: u16,
    /// Indexable 32-byte link whose meaning depends on `kind` (see `kind` docs).
    pub reference: [u8; 32],
    /// sha256 of the canonical typed payload (see SDK `hashPayload`).
    pub payload_hash: [u8; 32],
}

/// Per-agent compressed account (120 bytes of data).
#[event]
#[derive(Clone, Debug, Default, LightDiscriminator)]
pub struct AgentState {
    pub authority: Pubkey,
    pub agent_id: [u8; 32],
    pub seq: u64,
    pub head: [u8; 32],
    pub created_at: i64,
    pub updated_at: i64,
}

/// Per-event compressed account (147 bytes of data). Address = derive(["event", agent_id, seq_le]).
#[event]
#[derive(Clone, Debug, Default, LightDiscriminator)]
pub struct EventRecord {
    pub agent_id: [u8; 32],
    pub seq: u64,
    pub timestamp: i64,
    pub kind: u8,
    pub status: u16,
    pub reference: [u8; 32],
    pub payload_hash: [u8; 32],
    pub head: [u8; 32],
}

#[event]
pub struct AgentRegistered {
    pub agent_id: [u8; 32],
    pub authority: Pubkey,
}

#[event]
pub struct AuthorityChanged {
    pub agent_id: [u8; 32],
    pub previous: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct AgentClosed {
    pub agent_id: [u8; 32],
    pub final_seq: u64,
    pub final_head: [u8; 32],
}

#[event]
pub struct EventLogged {
    pub agent_id: [u8; 32],
    pub seq: u64,
    pub kind: u8,
    pub head: [u8; 32],
}

#[event]
pub struct EpochCommitted {
    pub agent_id: [u8; 32],
    pub epoch_root: [u8; 32],
    pub start_seq: u64,
    pub end_seq: u64,
    pub head: [u8; 32],
}

/// Parameters for `create_struct`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default)]
pub struct StructParams {
    pub struct_id: [u8; 32],
    /// One of `struct_kind::*`.
    pub kind: u8,
    /// One of `struct_mode::*`.
    pub mode: u8,
    /// `Log` only: may cells be closed (a mailbox is a consumable Log; an audit log is not).
    pub consumable: bool,
    /// One of `append_policy::*`.
    pub append_policy: u8,
    /// One 32-byte slot whose meaning is the structure's: `sha256(map_secret)` in private mode
    /// (so a holder of the secret is checkable without it being on-chain), or the allow-list
    /// Merkle root under `ALLOW_LIST`. Zero when neither applies. One field rather than two
    /// because the SBF stack frame of `create_cell` is the binding constraint here.
    pub policy_ref: [u8; 32],
    pub created_at: i64,
}

/// The caller-supplied half of a cell. `owner_id`, `struct_id`, `index_or_version`, `op_seq`
/// and `head` are all derived by the program, never taken from the caller.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CellInput {
    /// Client-attested unix ms, bounded by `check_timestamp` like every other write.
    pub timestamp: i64,
    /// User-level type tag (event `kind`, edge label, message type…).
    pub tag: u8,
    pub status: u16,
    /// `Map`: `sha256(key)` public / `sha256(map_secret ‖ key)` private — it *is* the address
    /// component. `Log`: a `reference`-style link, indexable but not addressing.
    pub key_slot: [u8; 32],
    /// Raw value (public, ≤ 32 B, caller-padded) or `sha256(salt ‖ value)` (private). Values
    /// that do not fit are committed by hash and kept in the `TraceStore`.
    pub value_slot: [u8; 32],
    /// `ALLOW_LIST` policy only: sibling hashes from the signer's leaf up to `allow_list_root`.
    pub allow_list_proof: Vec<[u8; 32]>,
}

/// Structure header (116 bytes of data). Address = `derive(["hdr", owner_address, struct_id])`,
/// where `owner_address` is the owner's `AgentState` compressed address, not its id (see
/// `HEADER_SEED` for why).
#[event]
#[derive(Clone, Debug, Default, LightDiscriminator)]
pub struct StructHeader {
    pub owner_id: [u8; 32],
    pub struct_id: [u8; 32],
    pub kind: u8,
    pub mode: u8,
    /// `Log`: the next index, i.e. the length. `Map`: how many `put`s the structure has seen.
    ///
    /// It counts creates, not live cells: `close_cell` deliberately takes no header (see
    /// there), so a close cannot decrement it. Live membership is a question for the indexer.
    pub len_or_count: u64,
    /// The owner's `op_seq` at creation, so a replay can place the structure's creation in the
    /// owner's operation order without reading transaction history.
    pub created_op_seq: u64,
    pub consumable: bool,
    pub append_policy: u8,
    /// See `StructParams::policy_ref`.
    pub policy_ref: [u8; 32],
}

/// One cell of a `Log` or `Map` (187 bytes of data).
///
/// Fixed width, and the byte offsets are ABI: Photon `memcmp` at `owner_id`\@0,
/// `struct_id`\@32, `tag`\@88 and `key_slot`\@91 is the only way to enumerate cells
/// (SPEC §12 #4).
#[event]
#[derive(Clone, Debug, LightDiscriminator)]
pub struct Cell {
    pub owner_id: [u8; 32],
    pub struct_id: [u8; 32],
    /// `Log`: the cell's index. `Map`: how many times this key has been written (0 = created).
    pub index_or_version: u64,
    /// The owner's operation counter at this write — `AgentState.seq`, which every write to
    /// any structure advances. Dense per owner, so a replay can order events and cells from
    /// different structures against each other, and a gap is detectable.
    pub op_seq: u64,
    pub timestamp: i64,
    pub tag: u8,
    pub status: u16,
    pub key_slot: [u8; 32],
    pub value_slot: [u8; 32],
    /// The owner's chain head after this write.
    pub head: [u8; 32],
}

/// Spelled out rather than derived, and kept explicit so the zero value is visible beside the
/// layout.
impl Default for CellInput {
    fn default() -> Self {
        Self {
            timestamp: 0,
            tag: 0,
            status: 0,
            key_slot: [0u8; 32],
            value_slot: [0u8; 32],
            allow_list_proof: Vec::new(),
        }
    }
}

impl Default for Cell {
    fn default() -> Self {
        Self {
            owner_id: [0u8; 32],
            struct_id: [0u8; 32],
            index_or_version: 0,
            op_seq: 0,
            timestamp: 0,
            tag: 0,
            status: 0,
            key_slot: [0u8; 32],
            value_slot: [0u8; 32],
            head: [0u8; 32],
        }
    }
}

#[event]
pub struct StructCreated {
    pub owner_id: [u8; 32],
    pub struct_id: [u8; 32],
    pub kind: u8,
    pub mode: u8,
    pub op_seq: u64,
    pub head: [u8; 32],
}

#[event]
pub struct CellWritten {
    pub owner_id: [u8; 32],
    pub struct_id: [u8; 32],
    pub index_or_version: u64,
    pub op_seq: u64,
    /// One of `cell_op::*`.
    pub op: u8,
    pub head: [u8; 32],
}

/// One `set_append_policy`. The header keeps only the policy it has now, so the policy it
/// *had* lives here and nowhere else on chain: a replay that recomputes the structure's
/// `CREATE_STRUCT` fold from the account must put `previous_policy` / `previous_policy_ref` back
/// first, and `head` is what the rewrite itself folded to at `op_seq`.
#[event]
pub struct AppendPolicySet {
    pub owner_id: [u8; 32],
    pub struct_id: [u8; 32],
    pub previous_policy: u8,
    pub previous_policy_ref: [u8; 32],
    pub append_policy: u8,
    pub policy_ref: [u8; 32],
    pub op_seq: u64,
    pub head: [u8; 32],
}

#[error_code]
pub enum LathError {
    #[msg("Signer is not the agent authority")]
    Unauthorized,
    #[msg("Unknown event kind")]
    InvalidKind,
    #[msg("Address tree must be the v2 address tree")]
    InvalidAddressTree,
    #[msg("Sequence overflow")]
    Overflow,
    #[msg("Timestamp is more than 5 minutes ahead of the cluster clock")]
    TimestampTooFarInFuture,
    #[msg("Batch must hold between 1 and MAX_EVENTS_PER_TX events")]
    InvalidBatchSize,
    #[msg("New authority must not be the default pubkey")]
    InvalidAuthority,
    #[msg("Unknown structure kind")]
    InvalidStructKind,
    #[msg("Unknown structure mode")]
    InvalidStructMode,
    #[msg("Unknown append policy")]
    InvalidAppendPolicy,
    #[msg("Header does not belong to this owner and struct_id")]
    HeaderMismatch,
    #[msg("Cell does not belong to this header")]
    CellMismatch,
    #[msg("Log cells are append-only and cannot be replaced")]
    LogNotReplaceable,
    #[msg("This Log is not consumable, so its cells cannot be closed")]
    NotConsumable,
    #[msg("Signer is not allowed to append to this structure")]
    AppendNotAllowed,
    #[msg("Log index must be the header length")]
    IndexMismatch,
    #[msg("Epoch end_seq must be greater than start_seq")]
    InvalidEpochBounds,
    #[msg("Epoch start_seq must equal current agent seq")]
    EpochSeqMismatch,
    /// At the end so no existing code shifts: 6018.
    #[msg("Epoch spans more than MAX_EPOCH_SPAN (u32::MAX) steps")]
    EpochTooLong,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pinned vector shared with sdk/src tests (tests/lath.ts "hash chain vector").
    #[test]
    fn next_head_vector() {
        let e = EventInput {
            timestamp: 1_700_000_000_000,
            kind: kind::ACTION,
            status: 200,
            reference: [2u8; 32],
            payload_hash: [3u8; 32],
        };
        let h = next_head(&[0u8; 32], &[1u8; 32], 7, &e);
        assert_eq!(hex::encode(h), "d7150e18459267717b9d158e4052f69bbd12097a0d659c713c3d477669243ac5");
    }

    /// Pinned vector shared with the SDK (`tests/cells.ts` "cell chain vector"). The extended
    /// formula must agree byte-for-byte with `computeCellHead` in `sdk/src/cells.ts`.
    #[test]
    fn next_cell_head_vector() {
        let c = Cell {
            owner_id: [1u8; 32],
            struct_id: [2u8; 32],
            index_or_version: 3,
            op_seq: 9,
            timestamp: 1_700_000_000_000,
            tag: 4,
            status: 200,
            key_slot: [5u8; 32],
            value_slot: [6u8; 32],
            head: [0u8; 32],
        };
        let h = next_cell_head(&[7u8; 32], cell_op::CREATE, &c);
        assert_eq!(hex::encode(h), "1d23332128dcd07a83b9ae64738987f1dfa93568bfc30718350e4ae0bb8cb014");
    }

    /// Pinned vector shared with the SDK (`tests/lath.ts` "hash chain vector", the
    /// `set_append_policy` case). The header is a legacy `ANYONE` mailbox taken to `OWNER_ONLY`
    /// at the owner's seq 11, five cells in: what `set_append_policy` folds. `len_or_count` and
    /// `created_op_seq` are set to values that would change the digest were they in the
    /// preimage, so the vector also pins that they are not.
    #[test]
    fn set_append_policy_head_vector() {
        let h = StructHeader {
            owner_id: [1u8; 32],
            struct_id: [2u8; 32],
            kind: struct_kind::LOG,
            mode: struct_mode::PUBLIC,
            len_or_count: 5,
            created_op_seq: 3,
            consumable: true,
            append_policy: append_policy::OWNER_ONLY,
            policy_ref: [0u8; 32],
        };
        let head = next_header_head(&[7u8; 32], cell_op::SET_APPEND_POLICY, &h, 11);
        assert_eq!(hex::encode(head), "44eb1be4eb52eea8a4bee92fdffe7a4d7d9aa9929013a31814692f8f8c6cde15");
        // The same bytes under the creation op are a different digest: the op byte is what keeps
        // a rewrite from hashing identically to a creation of the same header.
        assert_ne!(next_header_head(&[7u8; 32], cell_op::CREATE_STRUCT, &h, 11), head);
    }

    /// A sorted-pair Merkle path, the shape `create_cell` checks an allow-list against.
    #[test]
    fn merkle_root_of_pairs_sorted() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        let root = hashv(&[&a, &b]).to_bytes();
        assert_eq!(merkle_root_of(&a, &[b]), root);
        assert_eq!(merkle_root_of(&b, &[a]), root, "pairing is order-insensitive");
        assert_eq!(merkle_root_of(&a, &[]), a, "an empty path is the leaf itself");
    }

    fn error_code(r: Result<()>) -> u32 {
        match r.unwrap_err() {
            Error::AnchorError(e) => e.error_code_number,
            e => panic!("expected an AnchorError, got {e:?}"),
        }
    }

    /// `commit_epoch`'s bounds: a span of exactly `u32::MAX` is the longest a LEP1 blob can
    /// count, and one more step is refused before it can push `seq` towards `u64::MAX`.
    #[test]
    fn epoch_bounds_cap_the_span_at_u32_max() {
        let seq = 40;
        check_epoch_bounds(seq, seq, seq + 1).unwrap();
        check_epoch_bounds(seq, seq, seq + MAX_EPOCH_SPAN).unwrap();
        assert_eq!(error_code(check_epoch_bounds(seq, seq, seq + MAX_EPOCH_SPAN + 1)), 6018);
        assert_eq!(
            error_code(check_epoch_bounds(seq, seq, u64::MAX)),
            u32::from(LathError::EpochTooLong),
            "the commit that would strand the agent at u64::MAX"
        );
        assert_eq!(error_code(check_epoch_bounds(seq, seq, seq)), u32::from(LathError::InvalidEpochBounds));
        assert_eq!(error_code(check_epoch_bounds(seq, seq, seq - 1)), u32::from(LathError::InvalidEpochBounds));
        assert_eq!(error_code(check_epoch_bounds(seq, seq + 1, seq + 2)), u32::from(LathError::EpochSeqMismatch));
    }

    /// Pinned vector shared with the SDK (`tests/rollup.ts` "epoch chain vector").
    /// The domain-separated formula must agree byte-for-byte with `computeEpochHead`.
    #[test]
    fn epoch_head_vector() {
        let h = epoch_head(&[0u8; 32], &[1u8; 32], &[2u8; 32], 0, 1000);
        assert_eq!(hex::encode(h), "3ac60f0c6856784e6168ab9725fabf285d37f3323629b99622e79052ca5acf53");
    }
}
