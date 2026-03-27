# Solana Crowdfunding Program

A crowdfunding smart contract on Solana where users can create campaigns, accept donations via a PDA vault, and either claim funds (if the goal is met) or issue refunds (if the campaign fails).

## Architecture

```
Creator ──► create_campaign() ──► Campaign Account + Vault PDA

Donor   ──► contribute()      ──► SOL → Vault PDA
                                   Contribution PDA (per-donor tracker)

Creator ──► withdraw()         ──► Vault PDA → Creator (if goal met + deadline passed)

Donor   ──► refund()           ──► Vault PDA → Donor (if goal NOT met + deadline passed)
```

### Accounts

| Account | Type | Description |
|---------|------|-------------|
| **Campaign** | Program account | Stores goal, raised amount, deadline, creator, and claimed status |
| **Vault** | PDA (`[b"vault", campaign]`) | Holds all donated SOL. Program-controlled, no private key |
| **Contribution** | PDA (`[b"contribution", campaign, donor]`) | Tracks each donor's cumulative contribution for refunds |

### Instructions

| Instruction | Who | What |
|-------------|-----|------|
| `create_campaign(goal, deadline)` | Creator | Set up a new campaign. Goal must be > 0, deadline must be in the future |
| `contribute(amount)` | Donor | Send SOL to the vault. Can be called multiple times (amount accumulates) |
| `withdraw()` | Creator | Claim all vault funds. Requires: goal reached AND deadline passed AND not already claimed |
| `refund()` | Donor | Reclaim contribution. Requires: goal NOT reached AND deadline passed. Closes the contribution account (rent returned to donor) |

### Events

- `CampaignCreated` — emitted on campaign creation
- `ContributionMade` — emitted on each donation (includes running total)
- `FundsWithdrawn` — emitted when creator claims funds
- `ContributionRefunded` — emitted when donor gets a refund

## Prerequisites

- [Rust](https://rustup.rs/)
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools)
- [Anchor](https://www.anchor-lang.com/docs/installation)
- Node.js + Yarn

## Setup

```bash
# Install dependencies
yarn install

# Generate a keypair (if you don't have one)
solana-keygen new

# Build the program
anchor build

# Run tests (starts a local validator automatically)
anchor test
```

## Deploy to Devnet

```bash
solana config set --url devnet
solana airdrop 2
anchor deploy --provider.cluster devnet
```

The program ID is printed after deployment. Update `declare_id!()` in `lib.rs` and `Anchor.toml` if it changes.

## Program ID

```
EHu6sPptBWXmRCWYeaC36UhCsze99DjYWwJL3rqKDyW5
```

## Test Coverage

| Test | Status |
|------|--------|
| Create campaign with valid goal + deadline | Pass |
| Reject campaign with zero goal | Pass |
| Reject campaign with past deadline | Pass |
| Accept contribution | Pass |
| Accumulate multiple contributions from same donor | Pass |
| Reject zero-amount contribution | Pass |
| Reject withdraw before deadline | Pass |
| Reject refund before deadline | Pass |
| Withdraw after successful campaign | Pass |
| Reject double withdrawal | Pass |
| Reject withdraw by non-creator | Pass |
| Refund after failed campaign + close contribution account | Pass |
| Reject refund when goal reached | Pass |
| Reject withdraw when goal not reached | Pass |

## Security Considerations

- **PDA vault**: Donations go to a program-controlled address, not directly to the creator
- **Signer checks**: All privileged operations require the correct signer (creator for withdraw, donor for refund)
- **Account validation**: Anchor constraints verify PDA seeds, ownership, and `has_one` relationships
- **Arithmetic safety**: All addition/subtraction uses `checked_*` with explicit error returns (no `.unwrap()`)
- **Double-claim prevention**: `claimed` flag checked before withdrawal
- **Double-refund prevention**: Contribution account is closed on refund via Anchor's `close` constraint
- **Rent reclamation**: Contribution accounts are closed on refund, returning rent to the donor
