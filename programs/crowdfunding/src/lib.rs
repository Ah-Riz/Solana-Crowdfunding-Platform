use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("EHu6sPptBWXmRCWYeaC36UhCsze99DjYWwJL3rqKDyW5");

// PDA seed constants — single source of truth for all seed derivations
pub const VAULT_SEED: &[u8] = b"vault";
pub const CONTRIBUTION_SEED: &[u8] = b"contribution";

#[program]
pub mod crowdfunding {
    use super::*;

    /// Creates a new crowdfunding campaign with a funding goal and deadline.
    ///
    /// The creator sets how much SOL they want to raise (goal) and when the
    /// campaign ends (deadline). A PDA vault is derived to hold all donations.
    pub fn create_campaign(ctx: Context<CreateCampaign>, goal: u64, deadline: i64) -> Result<()> {
        require!(goal > 0, CrowdfundError::ZeroGoal);

        let clock = Clock::get()?;
        require!(deadline > clock.unix_timestamp, CrowdfundError::DeadlineInPast);

        let campaign = &mut ctx.accounts.campaign;
        campaign.creator = ctx.accounts.creator.key();
        campaign.goal = goal;
        campaign.raised = 0;
        campaign.deadline = deadline;
        campaign.claimed = false;
        campaign.bump = ctx.bumps.vault;

        emit!(CampaignCreated {
            campaign: ctx.accounts.campaign.key(),
            creator: ctx.accounts.creator.key(),
            goal,
            deadline,
        });

        msg!("Campaign created: goal={}, deadline={}", goal, deadline);
        Ok(())
    }

    /// Donates SOL to an active campaign.
    ///
    /// Transfers `amount` lamports from the donor to the campaign's PDA vault.
    /// A per-donor contribution account tracks the total donated for refund purposes.
    /// Donors may call this multiple times to increase their contribution.
    pub fn contribute(ctx: Context<Contribute>, amount: u64) -> Result<()> {
        require!(amount > 0, CrowdfundError::ZeroContribution);

        let clock = Clock::get()?;
        let campaign = &ctx.accounts.campaign;
        require!(clock.unix_timestamp < campaign.deadline, CrowdfundError::CampaignEnded);

        // Transfer SOL from donor to vault PDA
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.donor.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            amount,
        )?;

        // Track individual contribution for refunds.
        // Only set donor/campaign on first init (when amount is still zero).
        let contribution = &mut ctx.accounts.contribution;
        if contribution.amount == 0 {
            contribution.donor = ctx.accounts.donor.key();
            contribution.campaign = ctx.accounts.campaign.key();
        }
        contribution.amount = contribution
            .amount
            .checked_add(amount)
            .ok_or(CrowdfundError::ArithmeticOverflow)?;

        // Update campaign total
        let campaign = &mut ctx.accounts.campaign;
        campaign.raised = campaign
            .raised
            .checked_add(amount)
            .ok_or(CrowdfundError::ArithmeticOverflow)?;

        let campaign_key = campaign.key();
        let donor_key = ctx.accounts.donor.key();
        let total_raised = campaign.raised;

        emit!(ContributionMade {
            campaign: campaign_key,
            donor: donor_key,
            amount,
            total_raised,
        });

        msg!("Contributed: {} lamports, total={}", amount, total_raised);
        Ok(())
    }

    /// Allows the campaign creator to withdraw all funds after a successful campaign.
    ///
    /// Requires: deadline has passed, goal was reached, and funds haven't been claimed yet.
    /// Transfers the entire vault balance to the creator.
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let campaign = &ctx.accounts.campaign;

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= campaign.deadline,
            CrowdfundError::CampaignNotEnded
        );
        require!(campaign.raised >= campaign.goal, CrowdfundError::GoalNotReached);

        let amount = campaign.raised;
        let campaign_key = ctx.accounts.campaign.key();

        transfer_from_vault(
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.creator.to_account_info(),
            amount,
        )?;

        // Mark as claimed
        let campaign = &mut ctx.accounts.campaign;
        campaign.claimed = true;

        emit!(FundsWithdrawn {
            campaign: campaign_key,
            creator: ctx.accounts.creator.key(),
            amount,
        });

        msg!("Withdrawn: {} lamports", amount);
        Ok(())
    }

    /// Refunds a donor's contribution from a failed campaign.
    ///
    /// Requires: deadline has passed and goal was NOT reached.
    /// Returns the donor's full contribution and closes the contribution account
    /// (reclaiming rent back to the donor).
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let campaign = &ctx.accounts.campaign;

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= campaign.deadline,
            CrowdfundError::CampaignNotEnded
        );
        require!(campaign.raised < campaign.goal, CrowdfundError::GoalReached);

        let amount = ctx.accounts.contribution.amount;
        require!(amount > 0, CrowdfundError::NoContribution);

        let campaign_key = ctx.accounts.campaign.key();

        transfer_from_vault(
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.donor.to_account_info(),
            amount,
        )?;

        // Update campaign raised amount
        let campaign = &mut ctx.accounts.campaign;
        campaign.raised = campaign
            .raised
            .checked_sub(amount)
            .ok_or(CrowdfundError::ArithmeticOverflow)?;

        emit!(ContributionRefunded {
            campaign: campaign_key,
            donor: ctx.accounts.donor.key(),
            amount,
        });

        msg!("Refunded: {} lamports", amount);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Transfers lamports from the vault PDA to a recipient via direct lamport manipulation.
///
/// Because the vault is a program-owned account (not a SystemAccount), we can
/// directly adjust lamport balances without a CPI to the System Program. This
/// avoids the rent-exempt minimum check that `system_program::transfer` enforces,
/// allowing us to fully drain the vault on withdraw/refund.
fn transfer_from_vault<'info>(
    vault: &AccountInfo<'info>,
    recipient: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    **vault.try_borrow_mut_lamports()? -= amount;
    **recipient.try_borrow_mut_lamports()? += amount;
    Ok(())
}

// ---------------------------------------------------------------------------
// Account validation structs
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct CreateCampaign<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + Campaign::INIT_SPACE,
    )]
    pub campaign: Account<'info, Campaign>,

    /// Vault PDA that holds campaign funds. Derived from the campaign key.
    /// Program-owned so we can fully drain it via direct lamport manipulation.
    #[account(
        init,
        payer = creator,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, campaign.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Contribute<'info> {
    #[account(
        mut,
        constraint = !campaign.claimed @ CrowdfundError::AlreadyClaimed,
    )]
    pub campaign: Account<'info, Campaign>,

    /// Per-donor contribution tracker. Created on first contribution,
    /// updated (amount accumulated) on subsequent contributions.
    ///
    /// SAFETY: `init_if_needed` is safe here because contribute requires
    /// `clock < deadline`, while refund (which closes this account) requires
    /// `clock >= deadline`. A donor cannot re-initialize after a refund.
    #[account(
        init_if_needed,
        payer = donor,
        space = 8 + Contribution::INIT_SPACE,
        seeds = [CONTRIBUTION_SEED, campaign.key().as_ref(), donor.key().as_ref()],
        bump,
    )]
    pub contribution: Account<'info, Contribution>,

    /// Vault PDA that holds campaign funds.
    #[account(
        mut,
        seeds = [VAULT_SEED, campaign.key().as_ref()],
        bump = campaign.bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub donor: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        has_one = creator,
        constraint = !campaign.claimed @ CrowdfundError::AlreadyClaimed,
    )]
    pub campaign: Account<'info, Campaign>,

    /// Vault PDA — program-owned, so no System Program needed for transfers out.
    #[account(
        mut,
        seeds = [VAULT_SEED, campaign.key().as_ref()],
        bump = campaign.bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub creator: Signer<'info>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub campaign: Account<'info, Campaign>,

    /// Contribution account is closed on refund; rent returns to the donor.
    #[account(
        mut,
        seeds = [CONTRIBUTION_SEED, campaign.key().as_ref(), donor.key().as_ref()],
        bump,
        has_one = donor,
        has_one = campaign,
        close = donor,
    )]
    pub contribution: Account<'info, Contribution>,

    /// Vault PDA — program-owned, so no System Program needed for transfers out.
    #[account(
        mut,
        seeds = [VAULT_SEED, campaign.key().as_ref()],
        bump = campaign.bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub donor: Signer<'info>,
}

// ---------------------------------------------------------------------------
// State accounts
// ---------------------------------------------------------------------------

/// Empty program-owned account used as the campaign vault.
///
/// By making this a program-owned account (rather than a SystemAccount),
/// we can transfer lamports out via direct manipulation (`try_borrow_mut_lamports`)
/// without the System Program's rent-exempt minimum check. This lets us
/// fully drain the vault on withdraw and refund.
#[account]
#[derive(InitSpace)]
pub struct Vault {}

/// On-chain state for a crowdfunding campaign.
#[account]
#[derive(InitSpace)]
pub struct Campaign {
    /// The wallet that created (and can withdraw from) the campaign.
    pub creator: Pubkey,
    /// Funding target in lamports.
    pub goal: u64,
    /// Total lamports received so far.
    pub raised: u64,
    /// Unix timestamp after which the campaign outcome is final.
    pub deadline: i64,
    /// Whether the creator has already withdrawn funds.
    pub claimed: bool,
    /// Bump seed for the vault PDA.
    pub bump: u8,
}

/// Tracks a single donor's cumulative contribution to a campaign.
#[account]
#[derive(InitSpace)]
pub struct Contribution {
    /// The donor's wallet address.
    pub donor: Pubkey,
    /// The campaign this contribution belongs to.
    pub campaign: Pubkey,
    /// Total lamports donated by this donor.
    pub amount: u64,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct CampaignCreated {
    pub campaign: Pubkey,
    pub creator: Pubkey,
    pub goal: u64,
    pub deadline: i64,
}

#[event]
pub struct ContributionMade {
    pub campaign: Pubkey,
    pub donor: Pubkey,
    pub amount: u64,
    pub total_raised: u64,
}

#[event]
pub struct FundsWithdrawn {
    pub campaign: Pubkey,
    pub creator: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ContributionRefunded {
    pub campaign: Pubkey,
    pub donor: Pubkey,
    pub amount: u64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum CrowdfundError {
    #[msg("Campaign goal must be greater than zero")]
    ZeroGoal,
    #[msg("Deadline must be in the future")]
    DeadlineInPast,
    #[msg("Campaign has already ended")]
    CampaignEnded,
    #[msg("Contribution amount must be greater than zero")]
    ZeroContribution,
    #[msg("Campaign has not ended yet")]
    CampaignNotEnded,
    #[msg("Campaign goal was not reached")]
    GoalNotReached,
    #[msg("Campaign goal was reached, no refunds available")]
    GoalReached,
    #[msg("Funds have already been claimed")]
    AlreadyClaimed,
    #[msg("No contribution to refund")]
    NoContribution,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
}
