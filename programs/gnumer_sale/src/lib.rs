use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program_option::COption,
    system_program,
};

use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::spl_token_2022::instruction::AuthorityType,
    token_interface::{
        self, Mint, MintTo, SetAuthority, TokenAccount, TokenInterface,
    },
};

declare_id!("9rckADaKzwyoRDmLDzQWANLTzFM3WX9rdRuspkUVymCX");


const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

const TOKEN_DECIMALS: u8 = 9;

const GNUMER_PER_SOL: u64 = 10_000;
const GNUMER_BASE_UNITS_PER_SOL: u64 = GNUMER_PER_SOL * 1_000_000_000;

const MIN_BUY_SOL: u64 = 1;
const MIN_BUY_LAMPORTS: u64 = MIN_BUY_SOL * LAMPORTS_PER_SOL;

const MAX_BUY_SOL: u64 = 1_000;
const MAX_BUY_LAMPORTS: u64 = MAX_BUY_SOL * LAMPORTS_PER_SOL;

// Sale closes when treasury_wallet actual SOL balance >= 3000 SOL.
const SALE_CAP_SOL: u64 = 3_000;
const SALE_CAP_LAMPORTS: u64 = SALE_CAP_SOL * LAMPORTS_PER_SOL;

const INITIALIZER_WALLET: Pubkey =
    pubkey!("4fXxndc4h2Zsi35YxVKYSJxFdJ5nTqAZ1Bk64M6acRpC");

#[program]
pub mod gnumer_sale {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        treasury_wallet: Pubkey,
    ) -> Result<()> {
        require!(
            ctx.accounts.initializer.key() == INITIALIZER_WALLET,
            SaleError::UnauthorizedInitializer
        );

        require!(
            treasury_wallet != Pubkey::default(),
            SaleError::InvalidTreasuryWallet
        );

        require!(
            ctx.accounts.gnumer_mint.decimals == TOKEN_DECIMALS,
            SaleError::InvalidMintDecimals
        );

        require!(
            ctx.accounts.gnumer_mint.mint_authority
                == COption::Some(ctx.accounts.mint_authority.key()),
            SaleError::InvalidMintAuthority
        );

        require!(
            ctx.accounts.gnumer_mint.freeze_authority == COption::None,
            SaleError::InvalidFreezeAuthority
        );

        let state = &mut ctx.accounts.sale_state;

        state.initializer = ctx.accounts.initializer.key();
        state.gnumer_mint = ctx.accounts.gnumer_mint.key();
        state.mint_authority = ctx.accounts.mint_authority.key();
        state.treasury_wallet = treasury_wallet;

        state.total_raised_lamports = 0;
        state.treasury_balance_lamports = 0;
        state.total_spent_lamports = 0;

        state.is_closed = false;
        state.mint_authority_revoked = false;
        state.sale_state_closed = false;

        state.state_bump = ctx.bumps.sale_state;
        state.mint_authority_bump = ctx.bumps.mint_authority;

        emit!(Initialized {
            initializer: ctx.accounts.initializer.key(),
            gnumer_mint: ctx.accounts.gnumer_mint.key(),
            mint_authority: ctx.accounts.mint_authority.key(),
            treasury_wallet,
            sale_cap_lamports: SALE_CAP_LAMPORTS,
        });

        Ok(())
    }

    pub fn buy(mut ctx: Context<Buy>, pay_lamports: u64) -> Result<()> {
        let new_total_raised_lamports;
        let mint_authority_bump;

        {
            let state = &ctx.accounts.sale_state;

            require!(!state.is_closed, SaleError::SaleClosed);
            require!(!state.sale_state_closed, SaleError::SaleClosed);
            require!(
                !state.mint_authority_revoked,
                SaleError::MintAuthorityAlreadyRevoked
            );

            require!(
                pay_lamports >= MIN_BUY_LAMPORTS,
                SaleError::AmountTooSmall
            );

            require!(
                pay_lamports <= MAX_BUY_LAMPORTS,
                SaleError::AmountTooLarge
            );

            require!(
                ctx.accounts.treasury_wallet.key() == state.treasury_wallet,
                SaleError::InvalidTreasuryWallet
            );

            require!(
                ctx.accounts.gnumer_mint.mint_authority
                    == COption::Some(ctx.accounts.mint_authority.key()),
                SaleError::InvalidMintAuthority
            );

            require!(
                ctx.accounts.gnumer_mint.freeze_authority == COption::None,
                SaleError::InvalidFreezeAuthority
            );

            new_total_raised_lamports = state
                .total_raised_lamports
                .checked_add(pay_lamports)
                .ok_or(SaleError::MathOverflow)?;

            mint_authority_bump = state.mint_authority_bump;
        }

        // Transfer SOL directly from buyer to multisig treasury wallet.
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.treasury_wallet.to_account_info(),
                },
            ),
            pay_lamports,
        )?;

        let treasury_balance_after = ctx
            .accounts
            .treasury_wallet
            .to_account_info()
            .lamports();

        let total_spent_lamports =
            new_total_raised_lamports.saturating_sub(treasury_balance_after);

        let mint_amount_u128 = (pay_lamports as u128)
                                .checked_mul(GNUMER_BASE_UNITS_PER_SOL as u128)
                                .ok_or(SaleError::MathOverflow)?
                                .checked_div(LAMPORTS_PER_SOL as u128)
                                .ok_or(SaleError::MathOverflow)?;

        require!(
                mint_amount_u128 <= u64::MAX as u128,
                SaleError::MathOverflow
        );

let mint_amount = mint_amount_u128 as u64;

        let mint_authority_seeds: &[&[u8]] =
            &[b"mint_authority", &[mint_authority_bump]];

        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.gnumer_mint.to_account_info(),
                    to: ctx.accounts.buyer_gnumer_ata.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                &[mint_authority_seeds],
            ),
            mint_amount,
        )?;

        {
            let state = &mut ctx.accounts.sale_state;

            state.total_raised_lamports = new_total_raised_lamports;
            state.treasury_balance_lamports = treasury_balance_after;
            state.total_spent_lamports = total_spent_lamports;
        }

        emit!(Bought {
            buyer: ctx.accounts.buyer.key(),
            treasury_wallet: ctx.accounts.treasury_wallet.key(),
            sol_paid_lamports: pay_lamports,
            gnumer_minted: mint_amount,
            total_raised_lamports: new_total_raised_lamports,
            treasury_balance_lamports: treasury_balance_after,
            total_spent_lamports,
        });

        // New close condition:
        // sale closes when the treasury wallet actual balance reaches 3000 SOL.
        if treasury_balance_after >= SALE_CAP_LAMPORTS {
            finalize_sale_and_close_all_pdas(
                &mut ctx,
                mint_authority_bump,
                new_total_raised_lamports,
            )?;
        }

        Ok(())
    }
}

// ============================================================
// Accounts
// ============================================================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = initializer,
        space = 8 + SaleState::INIT_SPACE,
        seeds = [b"sale_state"],
        bump
    )]
    pub sale_state: Account<'info, SaleState>,

    #[account(mut)]
    pub initializer: Signer<'info>,

    #[account(
        seeds = [b"mint_authority"],
        bump
    )]
    /// CHECK:
    /// PDA mint authority.
    /// It does not store data.
    /// It only signs Token-2022 CPI calls.
    pub mint_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub gnumer_mint: InterfaceAccount<'info, Mint>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"sale_state"],
        bump = sale_state.state_bump,
        has_one = gnumer_mint,
        has_one = mint_authority
    )]
    pub sale_state: Account<'info, SaleState>,

    #[account(
        mut,
        seeds = [b"mint_authority"],
        bump = sale_state.mint_authority_bump
    )]
    /// CHECK:
    /// PDA mint authority.
    /// It signs Token-2022 mint_to and set_authority CPI calls.
    pub mint_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub gnumer_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = gnumer_mint,
        associated_token::authority = buyer,
        associated_token::token_program = token_program
    )]
    pub buyer_gnumer_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    /// CHECK:
    /// Multisig treasury wallet.
    /// It is checked against sale_state.treasury_wallet.
    /// SOL is transferred directly into this account.
    pub treasury_wallet: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,

    pub associated_token_program: Program<'info, AssociatedToken>,

    pub system_program: Program<'info, System>,
}

// ============================================================
// State
// ============================================================

#[account]
pub struct SaleState {
    pub initializer: Pubkey,
    pub gnumer_mint: Pubkey,
    pub mint_authority: Pubkey,

    // Multisig treasury wallet receiving SOL directly.
    pub treasury_wallet: Pubkey,

    // Total SOL paid through this contract.
    pub total_raised_lamports: u64,

    // Last observed treasury wallet balance after buy().
    pub treasury_balance_lamports: u64,

    // Accounting approximation:
    // total_spent_lamports = total_raised_lamports - treasury_balance_lamports,
    // using saturating_sub.
    //
    // If the treasury wallet receives external SOL, this value may be lower.
    // If the treasury wallet is used for other funds, this field becomes less meaningful.
    // For accurate reporting, use a dedicated treasury wallet for this sale.
    pub total_spent_lamports: u64,

    pub is_closed: bool,
    pub mint_authority_revoked: bool,
    pub sale_state_closed: bool,

    pub state_bump: u8,
    pub mint_authority_bump: u8,
}

impl SaleState {
    pub const INIT_SPACE: usize =
        32 + // initializer
        32 + // gnumer_mint
        32 + // mint_authority
        32 + // treasury_wallet
        8 +  // total_raised_lamports
        8 +  // treasury_balance_lamports
        8 +  // total_spent_lamports
        1 +  // is_closed
        1 +  // mint_authority_revoked
        1 +  // sale_state_closed
        1 +  // state_bump
        1;   // mint_authority_bump
}

// ============================================================
// Internal finalize helpers
// ============================================================

fn finalize_sale_and_close_all_pdas(
    ctx: &mut Context<Buy>,
    mint_authority_bump: u8,
    total_raised_lamports: u64,
) -> Result<()> {
    revoke_mint_authority(
        &ctx.accounts.gnumer_mint.to_account_info(),
        &ctx.accounts.mint_authority.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        mint_authority_bump,
    )?;

    emit!(MintAuthorityRevoked {
        gnumer_mint: ctx.accounts.gnumer_mint.key(),
    });

    let recovered_lamports = recover_mint_authority_pda_sol_if_possible(
        &ctx.accounts.mint_authority.to_account_info(),
        &ctx.accounts.treasury_wallet.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        mint_authority_bump,
    )?;

    emit!(MintAuthorityPdaRecovered {
        treasury_wallet: ctx.accounts.treasury_wallet.key(),
        amount_lamports: recovered_lamports,
    });

    let treasury_balance_lamports = ctx
        .accounts
        .treasury_wallet
        .to_account_info()
        .lamports();

    let total_spent_lamports =
        total_raised_lamports.saturating_sub(treasury_balance_lamports);

    {
        let state = &mut ctx.accounts.sale_state;

        state.is_closed = true;
        state.mint_authority_revoked = true;
        state.treasury_balance_lamports = treasury_balance_lamports;
        state.total_spent_lamports = total_spent_lamports;
        state.sale_state_closed = true;
    }

    emit!(SaleClosed {
        total_raised_lamports,
        treasury_balance_lamports,
        total_spent_lamports,
    });

    let sale_state_lamports = ctx.accounts.sale_state.to_account_info().lamports();

    let treasury_wallet_key = ctx.accounts.treasury_wallet.key();

    close_program_owned_account_to_destination(
        &ctx.accounts.sale_state.to_account_info(),
        &ctx.accounts.treasury_wallet.to_account_info(),
    )?;

    emit!(SaleStateClosed {
        treasury_wallet: treasury_wallet_key,
        amount_lamports: sale_state_lamports,
    });

    Ok(())
}

fn revoke_mint_authority<'info>(
    mint: &AccountInfo<'info>,
    mint_authority: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    mint_authority_bump: u8,
) -> Result<()> {
    let signer_seeds: &[&[u8]] =
        &[b"mint_authority", &[mint_authority_bump]];

    token_interface::set_authority(
        CpiContext::new_with_signer(
            token_program.clone(),
            SetAuthority {
                current_authority: mint_authority.clone(),
                account_or_mint: mint.clone(),
            },
            &[signer_seeds],
        ),
        AuthorityType::MintTokens,
        None,
    )?;

    Ok(())
}

fn recover_mint_authority_pda_sol_if_possible<'info>(
    mint_authority: &AccountInfo<'info>,
    treasury_wallet: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    mint_authority_bump: u8,
) -> Result<u64> {
    let amount = mint_authority.lamports();

    if amount == 0 {
        return Ok(0);
    }

    require!(
        mint_authority.owner == &system_program::ID,
        SaleError::InvalidPdaOwner
    );

    let signer_seeds: &[&[u8]] =
        &[b"mint_authority", &[mint_authority_bump]];

    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            system_program.clone(),
            anchor_lang::system_program::Transfer {
                from: mint_authority.clone(),
                to: treasury_wallet.clone(),
            },
            &[signer_seeds],
        ),
        amount,
    )?;

    Ok(amount)
}

fn close_program_owned_account_to_destination<'info>(
    account: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
) -> Result<()> {
    require!(
        account.owner == &crate::ID,
        SaleError::InvalidPdaOwner
    );

    let account_lamports = account.lamports();

    if account_lamports > 0 {
        **destination.try_borrow_mut_lamports()? = destination
            .lamports()
            .checked_add(account_lamports)
            .ok_or(SaleError::MathOverflow)?;

        **account.try_borrow_mut_lamports()? = 0;
    }

    account.assign(&system_program::ID);
    account.resize(0)?;

    Ok(())
}

// ============================================================
// Events
// ============================================================

#[event]
pub struct Initialized {
    pub initializer: Pubkey,
    pub gnumer_mint: Pubkey,
    pub mint_authority: Pubkey,
    pub treasury_wallet: Pubkey,
    pub sale_cap_lamports: u64,
}

#[event]
pub struct Bought {
    pub buyer: Pubkey,
    pub treasury_wallet: Pubkey,
    pub sol_paid_lamports: u64,
    pub gnumer_minted: u64,
    pub total_raised_lamports: u64,
    pub treasury_balance_lamports: u64,
    pub total_spent_lamports: u64,
}

#[event]
pub struct MintAuthorityRevoked {
    pub gnumer_mint: Pubkey,
}

#[event]
pub struct MintAuthorityPdaRecovered {
    pub treasury_wallet: Pubkey,
    pub amount_lamports: u64,
}

#[event]
pub struct SaleClosed {
    pub total_raised_lamports: u64,
    pub treasury_balance_lamports: u64,
    pub total_spent_lamports: u64,
}

#[event]
pub struct SaleStateClosed {
    pub treasury_wallet: Pubkey,
    pub amount_lamports: u64,
}

// ============================================================
// Errors
// ============================================================

#[error_code]
pub enum SaleError {
    #[msg("Unauthorized initializer.")]
    UnauthorizedInitializer,

    #[msg("Sale is already closed.")]
    SaleClosed,

    #[msg("Payment amount is too small. Minimum buy is 1 SOL.")]
    AmountTooSmall,

    #[msg("Payment amount is too large.")]
    AmountTooLarge,

    #[msg("Sale cap has already been reached.")]
    SaleCapReached,

    #[msg("Math overflow.")]
    MathOverflow,

    #[msg("Invalid mint decimals.")]
    InvalidMintDecimals,

    #[msg("Invalid mint authority.")]
    InvalidMintAuthority,

    #[msg("Invalid freeze authority. Freeze authority must be disabled.")]
    InvalidFreezeAuthority,

    #[msg("Mint authority has already been revoked.")]
    MintAuthorityAlreadyRevoked,

    #[msg("Invalid treasury wallet.")]
    InvalidTreasuryWallet,

    #[msg("Invalid PDA owner.")]
    InvalidPdaOwner,
}
