//! Lath billing — USDC escrow vault, per-agent allowances, metered deduction.
//!
//! Users deposit USDC into one program-owned vault and grant each agent authority an
//! `Allowance` (a capped, expiring capability). An agent charges per step, and the charge is
//! composed into the **same transaction** as the Lath `log_event` that justifies it, so
//! there is no window in which one landed and the other did not.
//!
//! Deliberately **regular** accounts, not compressed ones: balances and allowances are hot
//! keys, and updating a compressed account means nullify + re-create under a validity proof
//! (SPEC §12 #2) — roughly 5 000 lamports and a proof round-trip per debit. Rent for one PDA
//! per user is cheaper and simpler.
//!
//! Money model, all amounts in micro-USDC (the mint's native units, 6 decimals):
//!
//! ```text
//! spendable(user)  = deposited − spent − reserved         // charge and reserve both check it
//! committed(grant) = allowance.spent + allowance.reserved // ≤ cap; what the grant has promised
//! sweepable        = treasury.total_spent − total_swept   // the only USDC the sweeper may move
//! ```
//!
//! A hold is per **grant**, not merely per balance: `UserBalance.reserved` is the scalar that
//! stops two agents spending the same USDC twice, and `Allowance.reserved` records which grant
//! placed how much of it. Without the second number a hold is unbounded (nothing on the
//! allowance moves when one is taken, so the cap check passes again next call) and unattributed
//! (any approved agent can release or settle another's hold) — which is how an agent capped at
//! one micro-USDC could pin a whole deposit and leave it unwithdrawable.
//!
//! `spent` is accounting, not movement: charged USDC stays in the vault until `sweep` sends it
//! to the provider. The invariant `total_swept ≤ total_spent` is what keeps unspent user
//! deposits out of the sweeper's reach.
//!
//! **The vault is deposit-only.** USDC enters through `deposit` and leaves only through
//! `sweep`, which is bounded by what agents metered. There is no `withdraw` or `settle`: no
//! instruction by which a user takes unspent USDC back out, or moves it to another user's row.
//! Unspent deposits stay in the vault. The `Withdrawn` and `Settled` events stay declared so older
//! history that carries them still decodes.
use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

declare_id!("CkZfjbgWBDu4q9YVuxDVnSxnKLukaGkwZuQG7LenKDSA");

/// Treasuries are namespaced by their admin (`["treasury", admin]`) rather than being a
/// process-wide singleton, and every account below is scoped to one treasury. One deployment
/// can therefore serve several independent operators — and a test suite can stand up a fresh
/// treasury without a fresh validator.
pub const TREASURY_SEED: &[u8] = b"treasury";
pub const VAULT_SEED: &[u8] = b"vault";
pub const BALANCE_SEED: &[u8] = b"balance";
pub const ALLOWANCE_SEED: &[u8] = b"allow";

/// Length of the fixed sweep window: `swept_today` resets at the first sweep at least this long
/// after `day_start`, so two windows can abut and up to 2 × `max_sweep_per_day` can move inside
/// any 24 h span. A true rolling window needs per-sweep history, which the `Treasury` layout does
/// not carry and cannot grow without moving offsets; the damage is bounded anyway by
/// `total_swept ≤ total_spent` and the pinned destination — the only effect is a faster payout.
pub const DAY_SECONDS: i64 = 24 * 60 * 60;

#[program]
pub mod lath_billing {
    use super::*;

    /// Creates this admin's treasury (`["treasury", admin]`) and its vault token account
    /// (`["vault", treasury]`). Once per admin, not once per deployment — see `TREASURY_SEED`.
    pub fn init_treasury(
        ctx: Context<InitTreasury>,
        sweeper: Pubkey,
        max_sweep_per_call: u64,
        max_sweep_per_day: u64,
    ) -> Result<()> {
        let t = &mut ctx.accounts.treasury;
        t.admin = ctx.accounts.admin.key();
        t.usdc_mint = ctx.accounts.usdc_mint.key();
        t.vault = ctx.accounts.vault.key();
        t.sweep_destination = ctx.accounts.sweep_destination.key();
        t.sweeper = sweeper;
        t.total_deposited = 0;
        t.total_spent = 0;
        t.total_swept = 0;
        t.max_sweep_per_call = max_sweep_per_call;
        t.max_sweep_per_day = max_sweep_per_day;
        t.swept_today = 0;
        t.day_start = Clock::get()?.unix_timestamp;
        t.bump = ctx.bumps.treasury;
        t.vault_bump = ctx.bumps.vault;
        emit!(TreasuryInitialised { admin: t.admin, usdc_mint: t.usdc_mint, sweeper });
        Ok(())
    }

    /// Replaces the sweeper key and its caps. Admin only — the sweeper is a hot key, so
    /// rotating it and tightening its caps must not require redeploying.
    pub fn set_sweeper(
        ctx: Context<AdminOnly>,
        sweeper: Pubkey,
        max_sweep_per_call: u64,
        max_sweep_per_day: u64,
    ) -> Result<()> {
        let t = &mut ctx.accounts.treasury;
        t.sweeper = sweeper;
        t.max_sweep_per_call = max_sweep_per_call;
        t.max_sweep_per_day = max_sweep_per_day;
        t.sweep_destination = ctx.accounts.sweep_destination.key();
        Ok(())
    }

    /// Moves USDC from the user's token account into the vault and credits their balance.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, BillingError::ZeroAmount);
        let decimals = ctx.accounts.usdc_mint.decimals;
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_token.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
            decimals,
        )?;

        let b = &mut ctx.accounts.balance;
        b.user = ctx.accounts.user.key();
        b.bump = ctx.bumps.balance;
        b.deposited = b.deposited.checked_add(amount).ok_or(BillingError::Overflow)?;
        let t = &mut ctx.accounts.treasury;
        t.total_deposited = t.total_deposited.checked_add(amount).ok_or(BillingError::Overflow)?;

        emit!(Deposited { user: b.user, amount, deposited: b.deposited });
        Ok(())
    }

    /// Grants (or re-grants) an agent authority the right to charge this user up to `cap`.
    ///
    /// A re-grant is a **new** grant: `spent` resets to zero, so `cap` is the full budget the
    /// agent may spend from this moment on — past spending is not deducted from it. The
    /// alternative (carry `spent` forward) makes a lowered cap silently unrevocable.
    ///
    /// `reserved` is the one field a re-grant leaves alone. It is not history: it is money the
    /// user's balance is holding right now on this agent's behalf, and zeroing it would leave
    /// `UserBalance.reserved` with no grant able to release it — the stranding this field exists
    /// to close. It counts against the new cap, as a live hold should.
    pub fn approve_agent(
        ctx: Context<ApproveAgent>,
        agent_authority: Pubkey,
        cap: u64,
        expires_at: i64,
        policy_version_hash: [u8; 32],
    ) -> Result<()> {
        require!(expires_at > Clock::get()?.unix_timestamp, BillingError::AllowanceExpired);
        let user = ctx.accounts.user.key();
        let bump = ctx.bumps.allowance;
        ctx.accounts.allowance.regrant(user, agent_authority, cap, expires_at, policy_version_hash, bump);
        emit!(AgentApproved { user, agent_authority, cap, expires_at });
        Ok(())
    }

    /// Revokes a grant by closing the account; rent returns to the user. Already-charged
    /// amounts stand — revocation stops future charges, it does not refund past ones.
    ///
    /// An **outstanding hold is released first**. Closing the allowance is what would make a hold
    /// unrecoverable — `release` needs the grant's PDA, and a closed PDA cannot be reopened with
    /// its `reserved` intact — so a crashed agent that never released would otherwise take that
    /// much of the user's balance out of circulation for good. Revocation is the user's unwind,
    /// so it has to do the unwinding.
    pub fn revoke_agent(ctx: Context<RevokeAgent>, agent_authority: Pubkey) -> Result<()> {
        let user = ctx.accounts.user.key();
        let held = ctx.accounts.allowance.reserved;
        match &mut ctx.accounts.balance {
            Some(b) => {
                // Saturating, not checked: the owner's unwind in `release` is bounded by the
                // balance rather than by one grant, so the scalar can already have been taken
                // down through another allowance. Erroring here would make this grant
                // unrevocable — the very failure the saturating unwind prevents.
                b.reserved = b.reserved.saturating_sub(held);
                if held > 0 {
                    emit!(Released { user, agent_authority, amount: held, reserved: b.reserved });
                }
            }
            // No balance row means no deposits, so there is nothing a hold could be against —
            // but a grant that records one must not be closed over it in silence.
            None => require!(held == 0, BillingError::BalanceRequired),
        }
        emit!(AgentRevoked { user, agent_authority, spent: ctx.accounts.allowance.spent, released: held });
        Ok(())
    }

    /// Grows an older grant, written without `Allowance.reserved`, to the current layout.
    ///
    /// `reserved` is the account's last field. Anchor deserialises an account's bytes exactly, so
    /// a grant written without it is eight bytes short and *every* instruction that
    /// takes it as an `Allowance` — `charge` and `revoke_agent` included — fails with
    /// `AccountDidNotDeserialize` (3003) until those bytes exist. This is the one instruction
    /// that reads such an account as raw bytes: it checks the owner, the discriminator and the
    /// PDA seeds itself, then appends eight zero bytes — a hold of zero. Nothing else about the
    /// grant changes, and no grant is bricked by the field.
    ///
    /// Any signer may pay the ~0.00006 SOL of extra rent, so an agent authority can repair the
    /// grant it is about to charge without a round trip to the user's wallet. Paying for eight
    /// zero bytes on a PDA that is already the user's grants nobody anything.
    pub fn migrate_allowance(ctx: Context<MigrateAllowance>, agent_authority: Pubkey) -> Result<()> {
        let info = ctx.accounts.allowance.to_account_info();
        require_keys_eq!(*info.owner, crate::ID, BillingError::Unauthorized);

        let need = 8 + Allowance::INIT_SPACE;
        let len = info.data_len();
        // Idempotent by refusal rather than by silence: a client that prepended this to every
        // write would otherwise pay for a no-op it could not see.
        require!(len < need, BillingError::AllowanceNotOutdated);
        {
            let data = info.try_borrow_data()?;
            require!(data.len() >= 8 && data[..8] == *Allowance::DISCRIMINATOR, BillingError::Unauthorized);
        }

        // Rent first: the runtime fails the whole transaction if a written account is left
        // rent-paying, and eight more bytes raise the minimum.
        let minimum = Rent::get()?.minimum_balance(need);
        let lamports = info.lamports();
        if lamports < minimum {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: info.clone(),
                    },
                ),
                minimum - lamports,
            )?;
        }

        info.resize(need)?;
        // Written explicitly rather than trusted to the resize zeroing the tail: the new field has
        // to read as "no hold", and that is one `u64` of zeroes at a known offset.
        info.try_borrow_mut_data()?[len..need].fill(0);

        emit!(AllowanceMigrated { user: ctx.accounts.user.key(), agent_authority, size: need as u16 });
        Ok(())
    }

    /// Debits `amount` from the user's balance against the signing agent's allowance.
    ///
    /// Composed in the same transaction as the Lath `log_event*` that this cost is for
    /// (design §3.3). Both bounds are enforced: the allowance cap (what the *user* authorised
    /// this agent to spend) and the spendable balance (what the user actually has).
    pub fn charge(ctx: Context<Charge>, amount: u64) -> Result<()> {
        require!(amount > 0, BillingError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        let a = &mut ctx.accounts.allowance;
        require!(now < a.expires_at, BillingError::AllowanceExpired);
        // Against `committed`, not `spent`: a hold this agent is still carrying has already been
        // promised out of the cap, and a charge must not spend the room the hold stands on.
        a.check_cap(amount)?;
        let allow_spent = a.spent.checked_add(amount).ok_or(BillingError::Overflow)?;

        let b = &mut ctx.accounts.balance;
        require!(b.spendable()? >= amount, BillingError::InsufficientBalance);

        a.spent = allow_spent;
        b.spent = b.spent.checked_add(amount).ok_or(BillingError::Overflow)?;
        b.nonce = b.nonce.wrapping_add(1);
        let t = &mut ctx.accounts.treasury;
        t.total_spent = t.total_spent.checked_add(amount).ok_or(BillingError::Overflow)?;

        emit!(Charged {
            user: b.user,
            agent_authority: ctx.accounts.agent_authority.key(),
            amount,
            spent: b.spent,
            allowance_spent: a.spent,
        });
        Ok(())
    }

    /// Holds `amount` of the user's balance for this agent's session, so two agents running
    /// concurrently against the same balance cannot both pass the `charge` check on funds
    /// only one of them can have. A hold is not a debit — `release` returns it untouched.
    pub fn reserve(ctx: Context<Charge>, amount: u64) -> Result<()> {
        require!(amount > 0, BillingError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        let a = &mut ctx.accounts.allowance;
        require!(now < a.expires_at, BillingError::AllowanceExpired);
        // A hold is bounded by the same cap as a charge and — because `place_hold` writes it
        // down — by every hold this grant is already carrying. Checking the cap without
        // recording the hold is what let an agent capped at 1 pin a whole deposit, one call at
        // a time, with nothing on chain saying it had.
        a.place_hold(amount)?;

        let b = &mut ctx.accounts.balance;
        require!(b.spendable()? >= amount, BillingError::InsufficientBalance);
        b.reserved = b.reserved.checked_add(amount).ok_or(BillingError::Overflow)?;

        emit!(Reserved { user: b.user, agent_authority: ctx.accounts.agent_authority.key(), amount, reserved: b.reserved });
        Ok(())
    }

    /// Releases a hold taken by `reserve`. **Either** the agent that placed it or the user whose
    /// money it is may sign, and the two are bounded differently on purpose.
    ///
    /// An agent may only give back what its own grant holds (`Allowance.reserved`): the
    /// balance-level scalar is shared by every agent the user approved, so an agent bounded by
    /// that alone could release — and so free for its own spending — a hold another agent placed.
    ///
    /// The user is bounded by the balance instead. It is their money, the worst they can do is
    /// unwind their own agents' sessions, and it is the only recovery that reaches a hold taken
    /// by a **previous deploy**, when grants did not record holds at all. Saturating the grant's
    /// own number there is deliberate: the scalar is the real bound, and an owner's unwind must
    /// not fail because the two disagree.
    ///
    /// Neither path checks expiry. A hold that outlived its grant is the one that most needs
    /// returning.
    pub fn release(ctx: Context<Release>, amount: u64) -> Result<()> {
        require!(amount > 0, BillingError::ZeroAmount);
        let signer = ctx.accounts.signer.key();
        let user = ctx.accounts.user.key();
        let agent_authority = ctx.accounts.agent_authority.key();
        let by_user = signer == user;
        require!(by_user || signer == agent_authority, BillingError::Unauthorized);

        ctx.accounts.allowance.take_hold(amount, by_user)?;

        let b = &mut ctx.accounts.balance;
        require!(b.reserved >= amount, BillingError::NothingReserved);
        b.reserved -= amount;
        emit!(Released { user: b.user, agent_authority, amount, reserved: b.reserved });
        Ok(())
    }

    /// Moves already-metered USDC from the vault to the provider's deposit account.
    ///
    /// Three bounds, because the sweeper key is hot and provider credits are not refundable:
    /// never sweep past what agents have actually charged (`total_swept + amount ≤
    /// total_spent`), never more than `max_sweep_per_call` at once, and never more than
    /// `max_sweep_per_day` per fixed window starting at `day_start` — so at most 2 ×
    /// `max_sweep_per_day` inside any 24 h span, when two windows abut (see `DAY_SECONDS`).
    pub fn sweep(ctx: Context<Sweep>, amount: u64) -> Result<()> {
        require!(amount > 0, BillingError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        let t = &mut ctx.accounts.treasury;

        let swept = t.total_swept.checked_add(amount).ok_or(BillingError::Overflow)?;
        require!(swept <= t.total_spent, BillingError::SweepExceedsSpent);
        require!(t.max_sweep_per_call == 0 || amount <= t.max_sweep_per_call, BillingError::SweepCapExceeded);

        t.admit_sweep(now, amount)?;

        let decimals = ctx.accounts.usdc_mint.decimals;
        let admin = t.admin;
        let seeds: &[&[u8]] = &[TREASURY_SEED, admin.as_ref(), &[t.bump]];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: t.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            decimals,
        )?;

        t.total_swept = swept;
        emit!(Swept { amount, total_swept: t.total_swept, total_spent: t.total_spent, destination: ctx.accounts.destination.key() });
        Ok(())
    }
}

// -------------------------------------------------------------------------------------------
// Accounts
// -------------------------------------------------------------------------------------------

#[account]
#[derive(InitSpace, Debug)]
pub struct Treasury {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    /// Vault token account (PDA at `["vault", treasury]`, authority = this treasury PDA).
    pub vault: Pubkey,
    /// Token account `sweep` is allowed to send to (the provider's deposit address).
    pub sweep_destination: Pubkey,
    /// The only key allowed to call `sweep`.
    pub sweeper: Pubkey,
    pub total_deposited: u64,
    /// Lifetime metered spend. The ceiling on `total_swept`.
    pub total_spent: u64,
    pub total_swept: u64,
    /// 0 = unlimited.
    pub max_sweep_per_call: u64,
    /// 0 = unlimited. Enforced per fixed window starting at `day_start` (see `DAY_SECONDS`).
    pub max_sweep_per_day: u64,
    pub swept_today: u64,
    pub day_start: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace, Debug)]
pub struct UserBalance {
    pub user: Pubkey,
    /// Lifetime deposits, less any withdrawal an older account recorded; the vault is deposit-only.
    pub deposited: u64,
    /// Lifetime metered spend.
    pub spent: u64,
    /// Currently held by running sessions.
    pub reserved: u64,
    /// Incremented on every charge; lets a client detect a concurrent debit.
    pub nonce: u64,
    pub bump: u8,
}

impl Treasury {
    /// Counts `amount` against the daily sweep cap and writes it down, opening a new window first
    /// when the current one has run out. The window is **fixed**, not rolling: it resets at the
    /// first sweep at least `DAY_SECONDS` after `day_start`, so a sweep at the last second of one
    /// window and another at the first second of the next can move 2 × the cap within a second.
    /// That bound is the documented one; this is a function so a test can pin it.
    ///
    /// Writing `swept_today` before the transfer rather than after it is the same thing: a failed
    /// transfer fails the transaction, and nothing written here survives it.
    pub fn admit_sweep(&mut self, now: i64, amount: u64) -> Result<()> {
        if now.saturating_sub(self.day_start) >= DAY_SECONDS {
            self.day_start = now;
            self.swept_today = 0;
        }
        let today = self.swept_today.checked_add(amount).ok_or(BillingError::Overflow)?;
        require!(self.max_sweep_per_day == 0 || today <= self.max_sweep_per_day, BillingError::DailySweepCapExceeded);
        self.swept_today = today;
        Ok(())
    }
}

impl UserBalance {
    /// `deposited − spent − reserved`. Saturating would hide an accounting bug, so it errors.
    pub fn spendable(&self) -> Result<u64> {
        Ok(self
            .deposited
            .checked_sub(self.spent)
            .and_then(|v| v.checked_sub(self.reserved))
            .ok_or(BillingError::Overflow)?)
    }
}

/// One capability grant: this user lets this agent authority spend up to `cap`, until
/// `expires_at`, under the policy committed by `policy_version_hash`.
#[account]
#[derive(InitSpace, Debug)]
pub struct Allowance {
    pub user: Pubkey,
    pub agent_authority: Pubkey,
    pub cap: u64,
    pub spent: u64,
    pub expires_at: i64,
    /// The runtime policy this grant is scoped to (`sha256(canonical {model, temperature,
    /// toolAllowList, maxCost})`). Advisory on-chain: the program cannot see what the agent
    /// ran, but the genesis event's `policy_version_hash` must match for the pair to audit.
    pub policy_version_hash: [u8; 32],
    pub bump: u8,
    /// Held by this agent's live sessions and not yet settled or released. Deliberately after
    /// `bump`: every offset above it is ABI (Photon and `getProgramAccounts` read them by
    /// `memcmp`), so the field goes at the end. Older grants without it are eight bytes short and
    /// are grown, in place and to a hold of zero, by `migrate_allowance`.
    pub reserved: u64,
}

impl Allowance {
    /// What `approve_agent` writes: a new grant over the same PDA. `spent` resets to zero, so the
    /// cap is the whole budget from now on; `reserved` is left alone, because it is money the
    /// user's balance is holding right now on this agent's behalf, and zeroing it would leave
    /// `UserBalance.reserved` with no grant able to release it (see `approve_agent`).
    #[allow(clippy::too_many_arguments)]
    pub fn regrant(
        &mut self,
        user: Pubkey,
        agent_authority: Pubkey,
        cap: u64,
        expires_at: i64,
        policy_version_hash: [u8; 32],
        bump: u8,
    ) {
        self.user = user;
        self.agent_authority = agent_authority;
        self.cap = cap;
        self.spent = 0;
        self.expires_at = expires_at;
        self.policy_version_hash = policy_version_hash;
        self.bump = bump;
    }

    /// What this grant has already promised: metered spend plus holds still standing. It is
    /// `committed`, not `spent`, that the cap bounds — a hold the user's balance is carrying is
    /// money this agent has already laid claim to, whether or not it has been paid out yet.
    pub fn committed(&self) -> Result<u64> {
        Ok(self.spent.checked_add(self.reserved).ok_or(BillingError::Overflow)?)
    }

    /// The check every debit and every hold passes: `committed + amount ≤ cap`.
    pub fn check_cap(&self, amount: u64) -> Result<()> {
        let after = self.committed()?.checked_add(amount).ok_or(BillingError::Overflow)?;
        require!(after <= self.cap, BillingError::AllowanceCapExceeded);
        Ok(())
    }

    /// Takes a hold against the cap **and writes it down**. The write is the whole point: a cap
    /// check that leaves no trace passes again on the next call with the same numbers.
    pub fn place_hold(&mut self, amount: u64) -> Result<()> {
        self.check_cap(amount)?;
        self.reserved = self.reserved.checked_add(amount).ok_or(BillingError::Overflow)?;
        Ok(())
    }

    /// Gives a hold back. `by_user` is the owner's unwind, which saturates rather than failing
    /// (see `release`); an agent is held strictly to what its own grant is carrying.
    pub fn take_hold(&mut self, amount: u64, by_user: bool) -> Result<()> {
        if by_user {
            self.reserved = self.reserved.saturating_sub(amount);
        } else {
            require!(self.reserved >= amount, BillingError::NothingReserved);
            self.reserved -= amount;
        }
        Ok(())
    }

}

#[derive(Accounts)]
pub struct InitTreasury<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Treasury::INIT_SPACE,
        seeds = [TREASURY_SEED, admin.key().as_ref()],
        bump
    )]
    pub treasury: Account<'info, Treasury>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        seeds = [VAULT_SEED, treasury.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = treasury
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(constraint = sweep_destination.mint == usdc_mint.key() @ BillingError::WrongMint)]
    pub sweep_destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [TREASURY_SEED, admin.key().as_ref()], bump = treasury.bump, has_one = admin @ BillingError::Unauthorized)]
    pub treasury: Account<'info, Treasury>,
    #[account(constraint = sweep_destination.mint == treasury.usdc_mint @ BillingError::WrongMint)]
    pub sweep_destination: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [TREASURY_SEED, treasury.admin.as_ref()], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserBalance::INIT_SPACE,
        seeds = [BALANCE_SEED, treasury.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub balance: Account<'info, UserBalance>,
    #[account(mut, address = treasury.usdc_mint @ BillingError::WrongMint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut, constraint = user_token.mint == treasury.usdc_mint @ BillingError::WrongMint)]
    pub user_token: Account<'info, TokenAccount>,
    #[account(mut, address = treasury.vault @ BillingError::WrongVault)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(agent_authority: Pubkey)]
pub struct ApproveAgent<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [TREASURY_SEED, treasury.admin.as_ref()], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + Allowance::INIT_SPACE,
        seeds = [ALLOWANCE_SEED, treasury.key().as_ref(), user.key().as_ref(), agent_authority.as_ref()],
        bump
    )]
    pub allowance: Account<'info, Allowance>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(agent_authority: Pubkey)]
pub struct RevokeAgent<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [TREASURY_SEED, treasury.admin.as_ref()], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    /// Optional, because a user can grant an allowance before ever depositing and must still be
    /// able to revoke it. When the grant holds nothing there is nothing to give back; when it
    /// holds something the balance row necessarily exists (a hold cannot be placed without one),
    /// and omitting it then fails with `BalanceRequired` rather than closing over the hold.
    #[account(
        mut,
        seeds = [BALANCE_SEED, treasury.key().as_ref(), user.key().as_ref()],
        bump,
        has_one = user @ BillingError::Unauthorized
    )]
    pub balance: Option<Account<'info, UserBalance>>,
    #[account(
        mut,
        close = user,
        seeds = [ALLOWANCE_SEED, treasury.key().as_ref(), user.key().as_ref(), agent_authority.as_ref()],
        bump = allowance.bump,
        has_one = user @ BillingError::Unauthorized
    )]
    pub allowance: Account<'info, Allowance>,
}

/// `migrate_allowance`: the allowance is an `UncheckedAccount` because the whole point is that it
/// is too short to deserialise as one. Its address is still pinned by the PDA seeds, and the body
/// checks the owner and the discriminator before touching a byte.
#[derive(Accounts)]
#[instruction(agent_authority: Pubkey)]
pub struct MigrateAllowance<'info> {
    /// Pays for eight more bytes of rent. Any signer will do — see `migrate_allowance`.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: not a signer — the grant's owner, and a seed of the PDA below, so a substituted
    /// `user` derives a different allowance address and fails the seeds constraint.
    pub user: UncheckedAccount<'info>,
    #[account(seeds = [TREASURY_SEED, treasury.admin.as_ref()], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    /// CHECK: raw bytes on purpose; validated by seeds here and by owner + discriminator in the
    /// instruction body.
    #[account(
        mut,
        seeds = [ALLOWANCE_SEED, treasury.key().as_ref(), user.key().as_ref(), agent_authority.as_ref()],
        bump
    )]
    pub allowance: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Shared by `charge` and `reserve`: the agent authority signs, and the allowance PDA seeds
/// bind the (user, agent) pair — a forged allowance account cannot be substituted. `release`
/// uses `Release` instead, because the user must be able to sign it too.
#[derive(Accounts)]
pub struct Charge<'info> {
    pub agent_authority: Signer<'info>,
    /// CHECK: not a signer — the account whose balance and allowance PDAs are being spent.
    /// Both PDAs are derived from this key, so a substituted `user` derives different PDAs
    /// and fails the seeds constraint.
    pub user: UncheckedAccount<'info>,
    #[account(mut, seeds = [TREASURY_SEED, treasury.admin.as_ref()], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(
        mut,
        seeds = [BALANCE_SEED, treasury.key().as_ref(), user.key().as_ref()],
        bump = balance.bump,
        has_one = user @ BillingError::Unauthorized
    )]
    pub balance: Account<'info, UserBalance>,
    #[account(
        mut,
        seeds = [ALLOWANCE_SEED, treasury.key().as_ref(), user.key().as_ref(), agent_authority.key().as_ref()],
        bump = allowance.bump,
        has_one = user @ BillingError::Unauthorized
    )]
    pub allowance: Account<'info, Allowance>,
}

/// `release`: the same accounts as `Charge`, except that the signer is either the agent that
/// placed the hold or the user whose balance is carrying it. The agent is therefore a plain
/// account rather than the signer, and it is still a seed of the allowance PDA, so the grant
/// being unwound is always the one the hold was taken under.
#[derive(Accounts)]
pub struct Release<'info> {
    pub signer: Signer<'info>,
    /// CHECK: not a signer unless it is the one unwinding its own hold. Both PDAs below are
    /// derived from this key, so a substituted `user` derives different PDAs and fails.
    pub user: UncheckedAccount<'info>,
    /// CHECK: not a signer unless it is the agent releasing its own hold. A seed of the
    /// allowance PDA, so it cannot name one grant and unwind another.
    pub agent_authority: UncheckedAccount<'info>,
    #[account(seeds = [TREASURY_SEED, treasury.admin.as_ref()], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(
        mut,
        seeds = [BALANCE_SEED, treasury.key().as_ref(), user.key().as_ref()],
        bump = balance.bump,
        has_one = user @ BillingError::Unauthorized
    )]
    pub balance: Account<'info, UserBalance>,
    #[account(
        mut,
        seeds = [ALLOWANCE_SEED, treasury.key().as_ref(), user.key().as_ref(), agent_authority.key().as_ref()],
        bump = allowance.bump,
        has_one = user @ BillingError::Unauthorized
    )]
    pub allowance: Account<'info, Allowance>,
}

#[derive(Accounts)]
pub struct Sweep<'info> {
    pub sweeper: Signer<'info>,
    #[account(
        mut,
        seeds = [TREASURY_SEED, treasury.admin.as_ref()],
        bump = treasury.bump,
        constraint = treasury.sweeper == sweeper.key() @ BillingError::Unauthorized
    )]
    pub treasury: Account<'info, Treasury>,
    #[account(mut, address = treasury.usdc_mint @ BillingError::WrongMint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut, address = treasury.vault @ BillingError::WrongVault)]
    pub vault: Account<'info, TokenAccount>,
    /// Pinned to the admin-configured address: a hot sweeper key cannot redirect funds.
    #[account(mut, address = treasury.sweep_destination @ BillingError::WrongDestination)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// -------------------------------------------------------------------------------------------
// Events and errors
// -------------------------------------------------------------------------------------------

#[event]
pub struct TreasuryInitialised {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub sweeper: Pubkey,
}

#[event]
pub struct Deposited {
    pub user: Pubkey,
    pub amount: u64,
    pub deposited: u64,
}

#[event]
pub struct AgentApproved {
    pub user: Pubkey,
    pub agent_authority: Pubkey,
    pub cap: u64,
    pub expires_at: i64,
}

#[event]
pub struct AgentRevoked {
    pub user: Pubkey,
    pub agent_authority: Pubkey,
    pub spent: u64,
    /// Outstanding hold handed back to the user by the revocation; 0 for the usual case.
    pub released: u64,
}

/// One older grant grown to the layout that carries `reserved`.
#[event]
pub struct AllowanceMigrated {
    pub user: Pubkey,
    pub agent_authority: Pubkey,
    /// The account's new size in bytes, discriminator included.
    pub size: u16,
}

#[event]
pub struct Charged {
    pub user: Pubkey,
    pub agent_authority: Pubkey,
    pub amount: u64,
    pub spent: u64,
    pub allowance_spent: u64,
}

#[event]
pub struct Reserved {
    pub user: Pubkey,
    pub agent_authority: Pubkey,
    pub amount: u64,
    pub reserved: u64,
}

#[event]
pub struct Released {
    pub user: Pubkey,
    pub agent_authority: Pubkey,
    pub amount: u64,
    pub reserved: u64,
}

/// One payment by an older `settle` instruction, which this program does not have.
/// Kept so those events decode.
#[event]
pub struct Settled {
    pub user: Pubkey,
    pub provider: Pubkey,
    pub agent_authority: Pubkey,
    pub amount: u64,
}

/// Unspent USDC returned by an older `withdraw` instruction, which this program does not have.
/// Kept so those events decode.
#[event]
pub struct Withdrawn {
    pub user: Pubkey,
    pub amount: u64,
    pub deposited: u64,
}

#[event]
pub struct Swept {
    pub amount: u64,
    pub total_swept: u64,
    pub total_spent: u64,
    pub destination: Pubkey,
}

#[error_code]
pub enum BillingError {
    #[msg("Signer is not authorised for this account")]
    Unauthorized,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Allowance has expired")]
    AllowanceExpired,
    #[msg("Charge would exceed the allowance cap")]
    AllowanceCapExceeded,
    #[msg("Insufficient spendable balance (deposited - spent - reserved)")]
    InsufficientBalance,
    #[msg("Nothing reserved to release under this allowance")]
    NothingReserved,
    #[msg("This grant holds funds; pass the user's balance account so they can be returned")]
    BalanceRequired,
    #[msg("Allowance already carries the current layout")]
    AllowanceNotOutdated,
    #[msg("Sweep would exceed total metered spend")]
    SweepExceedsSpent,
    #[msg("Sweep exceeds the per-call cap")]
    SweepCapExceeded,
    #[msg("Sweep exceeds the per-day cap")]
    DailySweepCapExceeded,
    #[msg("Token account or mint does not match the treasury")]
    WrongMint,
    #[msg("Vault account does not match the treasury")]
    WrongVault,
    #[msg("Sweep destination does not match the treasury")]
    WrongDestination,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn balance(deposited: u64, spent: u64, reserved: u64) -> UserBalance {
        UserBalance { user: Pubkey::default(), deposited, spent, reserved, nonce: 0, bump: 255 }
    }

    fn allowance(cap: u64, spent: u64, reserved: u64) -> Allowance {
        Allowance {
            user: Pubkey::default(),
            agent_authority: Pubkey::default(),
            cap,
            spent,
            expires_at: i64::MAX,
            policy_version_hash: [0u8; 32],
            bump: 255,
            reserved,
        }
    }

    #[test]
    fn spendable_subtracts_spend_and_holds() {
        assert_eq!(balance(100, 30, 20).spendable().unwrap(), 50);
        assert_eq!(balance(100, 100, 0).spendable().unwrap(), 0);
    }

    /// An impossible balance must surface as an error, not wrap around into a huge one.
    #[test]
    fn spendable_errors_instead_of_underflowing() {
        assert!(balance(10, 20, 0).spendable().is_err());
        assert!(balance(10, 5, 10).spendable().is_err());
    }

    /// What this field closes: a `reserve` that checked the cap and wrote nothing would pass the
    /// same check again on the next call. A grant capped at 1 could hold 1 as many times as it
    /// liked — and every hold would come off the user's spendable balance.
    #[test]
    fn a_second_hold_does_not_fit_under_a_cap_the_first_one_filled() {
        let mut a = allowance(1, 0, 0);
        a.place_hold(1).unwrap();
        assert_eq!(a.reserved, 1);
        assert!(a.place_hold(1).is_err(), "the cap is spoken for by the hold that is still standing");
        // And a charge cannot spend the room the hold stands on either.
        assert!(a.check_cap(1).is_err());
        assert_eq!(a.committed().unwrap(), 1);
    }

    /// `UserBalance.reserved` is one scalar for every agent a user has approved, so the grant is
    /// the only place a hold is attributed. An agent that placed nothing may give nothing back.
    #[test]
    fn an_agent_cannot_release_a_hold_it_did_not_place() {
        let mut placer = allowance(100, 0, 0);
        placer.place_hold(40).unwrap();
        let mut bystander = allowance(100, 10, 0); // has spent, holds nothing

        assert!(bystander.take_hold(40, false).is_err());
        // Not even up to its own spend: releasing what it charged would hand back cap it used.
        assert!(bystander.take_hold(10, false).is_err());
        assert_eq!(bystander.committed().unwrap(), 10);

        placer.take_hold(40, false).unwrap();
        assert_eq!(placer.reserved, 0);
    }

    /// The owner's unwind always works, including against a grant written before holds were
    /// recorded (`reserved == 0` while the balance is still carrying the hold). It saturates
    /// rather than failing, because `UserBalance.reserved` is the bound that matters and the
    /// user must never be left unable to free their own money.
    #[test]
    fn the_user_can_always_release_their_own_hold() {
        let mut agent = allowance(100, 0, 0);
        agent.place_hold(30).unwrap();
        agent.take_hold(30, true).unwrap();
        assert_eq!(agent.reserved, 0);

        let mut legacy = allowance(100, 0, 0); // a pre-migration grant: holds nothing on chain
        legacy.take_hold(30, true).unwrap();
        assert_eq!(legacy.reserved, 0, "saturating, so the owner's unwind cannot fail");
        assert!(legacy.take_hold(30, false).is_err(), "the agent's path stays strict");
    }

    /// A re-grant is a new budget but not a new hold: `approve_agent` resets `spent` and leaves
    /// `reserved` alone, so money the balance is carrying keeps the grant that can release it.
    /// This calls `Allowance::regrant`, which is what `approve_agent` calls.
    #[test]
    fn a_re_grant_keeps_the_live_hold_it_cannot_otherwise_return() {
        let mut a = allowance(10, 8, 0);
        a.place_hold(2).unwrap();
        let (user, agent) = (Pubkey::new_unique(), Pubkey::new_unique());
        a.regrant(user, agent, 5, 1_000, [7u8; 32], 254);
        assert_eq!(a.spent, 0, "a re-grant is a new budget");
        assert_eq!(a.reserved, 2, "and not a new hold");
        assert_eq!((a.user, a.agent_authority, a.cap, a.expires_at), (user, agent, 5, 1_000));
        assert_eq!((a.policy_version_hash, a.bump), ([7u8; 32], 254));
        assert_eq!(a.committed().unwrap(), 2);
        a.place_hold(3).unwrap();
        assert!(a.place_hold(1).is_err());
        // The agent can still give back the hold it placed before the re-grant.
        a.take_hold(5, false).unwrap();
        assert_eq!(a.reserved, 0);
    }

    fn treasury(max_sweep_per_day: u64, day_start: i64) -> Treasury {
        Treasury {
            admin: Pubkey::default(),
            usdc_mint: Pubkey::default(),
            vault: Pubkey::default(),
            sweep_destination: Pubkey::default(),
            sweeper: Pubkey::default(),
            total_deposited: 0,
            total_spent: 0,
            total_swept: 0,
            max_sweep_per_call: 0,
            max_sweep_per_day,
            swept_today: 0,
            day_start,
            bump: 255,
            vault_bump: 255,
        }
    }

    /// The sweep window is fixed, not rolling: a full cap at the last second of one window
    /// and another at the first second of the next both pass, which is the documented 2 × bound
    /// inside any 24 h span. Within one window the cap holds.
    #[test]
    fn the_sweep_window_is_fixed_so_two_windows_can_abut() {
        const T: i64 = 1_000_000;
        const D: u64 = 50;

        let mut t = treasury(D, T);
        t.admit_sweep(T + DAY_SECONDS - 1, D).unwrap();
        t.admit_sweep(T + DAY_SECONDS, D).unwrap();
        assert_eq!((t.day_start, t.swept_today), (T + DAY_SECONDS, D));

        let mut t = treasury(D, T);
        t.admit_sweep(T + DAY_SECONDS - 1, D).unwrap();
        assert!(t.admit_sweep(T + DAY_SECONDS - 1, D).is_err(), "the cap holds inside one window");
        assert!(t.admit_sweep(T + DAY_SECONDS - 1, 1).is_err());

        let mut t = treasury(0, T); // 0 = unlimited
        t.admit_sweep(T, u64::MAX).unwrap();
    }
}
