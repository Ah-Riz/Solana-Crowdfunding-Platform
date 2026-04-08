// ---------------------------------------------------------------------------
// IMPORTS
// ---------------------------------------------------------------------------
// anchor: The main testing library for Solana Anchor programs.
// It connects to the blockchain and lets us call our program's instructions.
import * as anchor from "@coral-xyz/anchor";

// Program: A TypeScript type that gives us auto-complete and type safety
// when calling our program's instructions.
import { Program } from "@coral-xyz/anchor";

// Crowdfunding: Auto-generated TypeScript type from our compiled Rust program.
// Anchor reads our Rust code and generates this type so TypeScript "knows"
// what instructions and accounts our program has.
import { Crowdfunding } from "../target/types/crowdfunding";

// Keypair: A wallet (public key + private key pair). Used to create test users.
// LAMPORTS_PER_SOL: A constant = 1,000,000,000. Since SOL is stored as
//   tiny units called "lamports", we multiply by this to convert SOL to lamports.
// PublicKey: The "address" of an account on Solana (like a bank account number).
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

// assert: A function that checks if a condition is true. If false, the test fails.
import { assert } from "chai";

// ---------------------------------------------------------------------------
// SHARED SETUP
// ---------------------------------------------------------------------------

// AnchorProvider.env() reads the ANCHOR_PROVIDER_URL and ANCHOR_WALLET
// environment variables to know which cluster (localnet/devnet) to connect to
// and which wallet (keypair file) to use as the "creator/payer".
const provider = anchor.AnchorProvider.env();

// Set this provider as the global one so all program calls use it.
anchor.setProvider(provider);

// Load our deployed program. Anchor finds it by name from the workspace config.
// The `as Program<Crowdfunding>` part gives us TypeScript auto-complete.
const program = anchor.workspace.crowdfunding as Program<Crowdfunding>;

// A low-level connection object. Used for things like checking balances
// and fetching raw account data directly from the RPC node.
const connection = provider.connection;

// The "creator" wallet — this is your local keypair (id.json).
// It pays for all account creation (rent) and signs transactions by default.
const creator = provider.wallet;

// ---------------------------------------------------------------------------
// PDA HELPERS
// ---------------------------------------------------------------------------
// PDAs (Program Derived Addresses) are special account addresses that are
// "owned" by your program. Instead of a random keypair, they are calculated
// from known "seeds". This makes them deterministic — anyone can recalculate
// the same address given the same inputs.

// Calculates the vault PDA address for a given campaign.
// Seeds: ["vault", campaignKey] — same seeds as in the Rust program.
// Returns the address AND the "bump" (a small number used to make the address valid).
function deriveVault(campaignKey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    // The seeds must EXACTLY match what's in the Rust program (VAULT_SEED = b"vault")
    [Buffer.from("vault"), campaignKey.toBuffer()],
    program.programId // The program that "owns" this PDA
  );
}

// Calculates the contribution PDA address for a specific donor on a specific campaign.
// Seeds: ["contribution", campaignKey, donorKey]
// This means each donor gets their OWN unique contribution account per campaign.
function deriveContribution(
  campaignKey: PublicKey,
  donorKey: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("contribution"),
      campaignKey.toBuffer(),
      donorKey.toBuffer(),
    ],
    program.programId
  );
}

// ---------------------------------------------------------------------------
// TRANSACTION HELPERS
// ---------------------------------------------------------------------------

// Sends SOL from the provider wallet (your main keypair) to a test account.
// On Devnet, we use our own wallet instead of the public faucet to avoid
// "429 Too Many Requests" rate limit errors.
async function airdrop(to: PublicKey, amount: number) {
  // Build a simple SOL transfer transaction
  const transaction = new anchor.web3.Transaction().add(
    anchor.web3.SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey, // Your funded wallet sends the SOL
      toPubkey: to,                          // The test account receives it
      lamports: amount,                      // Amount in lamports (not SOL)
    })
  );
  // Sign and send the transaction, then wait for confirmation
  await provider.sendAndConfirm(transaction);
}

// Gets the current "wall clock time" of the blockchain.
// Solana doesn't use your computer's clock — it uses the cluster's timestamp.
// We use this to set campaign deadlines relative to the current block time.
async function getCurrentBlockTime(): Promise<number> {
  const slot = await connection.getSlot(); // Get the current block number
  return (await connection.getBlockTime(slot))!; // Get the timestamp of that block
}

/** Creates a campaign and returns the derived vault PDA. */
// This is a reusable helper so we don't repeat campaign setup in every test.
async function setupCampaign(
  campaignKp: Keypair,    // A fresh keypair for the campaign account
  goal: anchor.BN,        // Funding goal in lamports (BN = "Big Number" library)
  deadlineOffset: number  // How many seconds from NOW the campaign should end
): Promise<{ vault: PublicKey; deadline: anchor.BN }> {
  // Derive the vault PDA — the "locked safe" that will hold the donated SOL
  const [vault] = deriveVault(campaignKp.publicKey);

  // Get the current cluster time, then add the offset to set the deadline
  const blockTime = await getCurrentBlockTime();
  const deadline = new anchor.BN(blockTime + deadlineOffset);

  // Call our Rust program's `create_campaign` instruction
  await program.methods
    .createCampaign(goal, deadline) // These map to the Rust function arguments
    .accounts({
      // These map to the CreateCampaign struct fields in our Rust program
      campaign: campaignKp.publicKey,
      vault,
      creator: creator.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([campaignKp]) // The campaign account must sign because it's being `init`-ed
    .rpc();                // Actually send the transaction to the blockchain

  return { vault, deadline };
}

/** Contributes to a campaign on behalf of a donor. */
// Another reusable helper to avoid repeating donation code in every test.
async function fundCampaign(
  campaignKey: PublicKey,
  vault: PublicKey,
  donor: Keypair,    // The person donating (they sign the transaction)
  amount: anchor.BN  // How many lamports to donate
): Promise<PublicKey> {
  // Derive the donor's personal contribution tracking account
  const [contribution] = deriveContribution(campaignKey, donor.publicKey);

  // Call our Rust program's `contribute` instruction
  await program.methods
    .contribute(amount)
    .accounts({
      campaign: campaignKey,
      contribution, // The donor's "receipt" account (created on first donation)
      vault,        // The locked safe that receives the SOL
      donor: donor.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([donor]) // The donor must sign to authorize moving their SOL
    .rpc();

  return contribution; // Return the contribution account address for assertions
}

/** Asserts that an RPC call rejects with the expected error code string. */
// Used to test "sad paths" — cases where the program SHOULD fail.
// If the call SUCCEEDS when it should have failed, the test itself fails.
async function expectError(fn: () => Promise<unknown>, errorCode: string) {
  try {
    await fn(); // Try to run the instruction
    // If we reach here, the instruction didn't throw — that's a test failure!
    assert.fail(`Expected error '${errorCode}' but call succeeded`);
  } catch (err) {
    // Check that the error message contains our expected error code string
    assert.include(err.toString(), errorCode);
  }
}

/** Wait for N seconds (use after setting short deadlines in tests). */
// On Devnet, we can't "fast-forward" time, so we actually wait.
// This lets campaign deadlines expire so we can test withdraw/refund.
const sleep = (seconds: number) =>
  new Promise((r) => setTimeout(r, seconds * 1000));

// ---------------------------------------------------------------------------
// TESTS – basic campaign lifecycle
// ---------------------------------------------------------------------------
// `describe` groups related tests together under one label.
// These tests cover the basic "happy path" of creating a campaign and donating.

describe("crowdfunding", () => {
  // Generate fresh random keypairs for each test run.
  // This ensures tests don't interfere with each other.
  const campaignKp = Keypair.generate();
  const donor = Keypair.generate();

  // Set a small goal (0.1 SOL) to fit within our Devnet budget
  const goal = new anchor.BN(0.1 * LAMPORTS_PER_SOL);

  // These will be filled in during the tests and reused across multiple tests
  let vault: PublicKey;
  let contribution: PublicKey;

  // `before` runs ONCE before all tests in this describe block.
  // We fund the donor's wallet so they can afford to donate.
  before(async () => {
    await airdrop(donor.publicKey, 0.2 * LAMPORTS_PER_SOL); // Give donor 0.2 SOL
  });

  it("Creates a campaign", async () => {
    // Set deadline to 60 seconds from now. Needs to be long enough for all
    // 8 tests in this describe block to run on Devnet (each takes ~0.5-2s).
    const result = await setupCampaign(campaignKp, goal, 60);
    vault = result.vault; // Save vault address for use in later tests
    [contribution] = deriveContribution(campaignKp.publicKey, donor.publicKey);

    // VERIFICATION: Fetch the campaign account from the blockchain and check its data
    const acct = await program.account.campaign.fetch(campaignKp.publicKey);
    assert.ok(acct.creator.equals(creator.publicKey)); // Creator address is correct
    assert.ok(acct.goal.eq(goal));                     // Goal is what we set
    assert.equal(acct.raised.toNumber(), 0);            // Nothing raised yet
    assert.equal(acct.claimed, false);                  // Not yet withdrawn
  });

  it("Rejects campaign with zero goal", async () => {
    const kp = Keypair.generate();
    const [v] = deriveVault(kp.publicKey);
    const blockTime = await getCurrentBlockTime();

    // This should FAIL because our Rust code has: require!(goal > 0, ZeroGoal)
    await expectError(
      () =>
        program.methods
          .createCampaign(new anchor.BN(0), new anchor.BN(blockTime + 60))
          .accounts({
            campaign: kp.publicKey,
            vault: v,
            creator: creator.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([kp])
          .rpc(),
      "ZeroGoal" // The error code we expect from our Rust program
    );
  });

  it("Rejects campaign with past deadline", async () => {
    const kp = Keypair.generate();
    const [v] = deriveVault(kp.publicKey);

    // Timestamp 1000 is Jan 1970 — way in the past.
    // This should FAIL because: require!(deadline > clock.unix_timestamp, DeadlineInPast)
    await expectError(
      () =>
        program.methods
          .createCampaign(goal, new anchor.BN(1000))
          .accounts({
            campaign: kp.publicKey,
            vault: v,
            creator: creator.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([kp])
          .rpc(),
      "DeadlineInPast"
    );
  });

  it("Accepts a contribution", async () => {
    const amount = new anchor.BN(0.05 * LAMPORTS_PER_SOL); // Donate 0.05 SOL

    await program.methods
      .contribute(amount)
      .accounts({
        campaign: campaignKp.publicKey,
        contribution,
        vault,
        donor: donor.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([donor])
      .rpc();

    // VERIFICATION: Check both the campaign total AND the individual receipt
    const acct = await program.account.campaign.fetch(campaignKp.publicKey);
    assert.ok(acct.raised.eq(amount)); // Campaign raised = 0.05 SOL

    const contrib = await program.account.contribution.fetch(contribution);
    assert.ok(contrib.amount.eq(amount));          // Donor's receipt = 0.05 SOL
    assert.ok(contrib.donor.equals(donor.publicKey)); // Receipt is linked to this donor
  });

  it("Accepts a second contribution from the same donor (accumulates)", async () => {
    // Same donor donates AGAIN — the contribution account should accumulate, not reset.
    // This tests the `init_if_needed` logic in our Rust contribute instruction.
    const amount = new anchor.BN(0.05 * LAMPORTS_PER_SOL); // Another 0.05 SOL

    await program.methods
      .contribute(amount)
      .accounts({
        campaign: campaignKp.publicKey,
        contribution, // Same contribution account — it already exists
        vault,
        donor: donor.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([donor])
      .rpc();

    // VERIFICATION: Total should be 0.05 + 0.05 = 0.1 SOL
    const acct = await program.account.campaign.fetch(campaignKp.publicKey);
    assert.ok(acct.raised.eq(new anchor.BN(0.1 * LAMPORTS_PER_SOL)));

    const contrib = await program.account.contribution.fetch(contribution);
    assert.ok(contrib.amount.eq(new anchor.BN(0.1 * LAMPORTS_PER_SOL)));
  });

  it("Rejects zero-amount contribution", async () => {
    const zeroDonor = Keypair.generate();
    await airdrop(zeroDonor.publicKey, 0.2 * LAMPORTS_PER_SOL);
    const [zeroContribution] = deriveContribution(
      campaignKp.publicKey,
      zeroDonor.publicKey
    );

    // Should FAIL because: require!(amount > 0, ZeroContribution)
    await expectError(
      () =>
        program.methods
          .contribute(new anchor.BN(0)) // Zero donation attempt
          .accounts({
            campaign: campaignKp.publicKey,
            contribution: zeroContribution,
            vault,
            donor: zeroDonor.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([zeroDonor])
          .rpc(),
      "ZeroContribution"
    );
  });

  it("Rejects withdraw before deadline", async () => {
    // Campaign is still active (60s deadline not reached yet).
    // Should FAIL because: require!(clock.unix_timestamp >= campaign.deadline, ...)
    await expectError(
      () =>
        program.methods
          .withdraw()
          .accounts({
            campaign: campaignKp.publicKey,
            vault,
            creator: creator.publicKey,
          })
          .signers([]) // Tells Anchor to use the provider wallet for signing
          .rpc(),
      "CampaignNotEnded"
    );
  });

  it("Rejects refund before deadline", async () => {
    // Campaign is still active — refunds are only allowed AFTER the deadline.
    // Should FAIL because: require!(clock.unix_timestamp >= campaign.deadline, ...)
    await expectError(
      () =>
        program.methods
          .refund()
          .accounts({
            campaign: campaignKp.publicKey,
            contribution,
            vault,
            donor: donor.publicKey,
          })
          .signers([donor])
          .rpc(),
      "CampaignNotEnded"
    );
  });
});

// ---------------------------------------------------------------------------
// TESTS – successful campaign → withdraw
// ---------------------------------------------------------------------------
// These tests verify the "happy path" for a creator:
// Campaign reaches its goal → creator withdraws all funds.

describe("crowdfunding – successful campaign (withdraw)", () => {
  const campaignKp = Keypair.generate();
  const donor = Keypair.generate();
  const goal = new anchor.BN(0.1 * LAMPORTS_PER_SOL); // Goal: 0.1 SOL

  let vault: PublicKey;

  before(async () => {
    await airdrop(donor.publicKey, 0.2 * LAMPORTS_PER_SOL); // Fund the donor
  });

  it("Funds campaign above goal, then creator withdraws after deadline", async () => {
    // Create campaign with 15-second deadline (long enough to donate on Devnet)
    const result = await setupCampaign(campaignKp, goal, 15);
    vault = result.vault;

    // Donate 0.15 SOL — this is ABOVE the 0.1 SOL goal, so withdrawal should pass
    await fundCampaign(
      campaignKp.publicKey,
      vault,
      donor,
      new anchor.BN(0.15 * LAMPORTS_PER_SOL)
    );

    // Wait 16 seconds for the 15-second deadline to pass on Devnet
    await sleep(16);

    // Record the creator's balance BEFORE withdrawing to prove it increased
    const balBefore = await connection.getBalance(creator.publicKey);

    // Call withdraw — this should succeed because:
    // 1. Deadline has passed (clock >= deadline)
    // 2. Goal was reached (raised >= goal)
    // 3. Not yet claimed (campaign.claimed == false)
    await program.methods
      .withdraw()
      .accounts({
        campaign: campaignKp.publicKey,
        vault,
        creator: creator.publicKey,
      })
      .signers([]) // Provider wallet signs (it's the creator)
      .rpc();

    // VERIFICATION: Creator's balance should have gone up
    const balAfter = await connection.getBalance(creator.publicKey);
    assert.isAbove(balAfter, balBefore);

    // VERIFICATION: campaign.claimed should now be `true` (prevents double withdrawal)
    const acct = await program.account.campaign.fetch(campaignKp.publicKey);
    assert.equal(acct.claimed, true);
  });

  it("Rejects double withdrawal", async () => {
    // campaign.claimed is now `true` from the previous test.
    // Should FAIL because: constraint = !campaign.claimed @ AlreadyClaimed
    await expectError(
      () =>
        program.methods
          .withdraw()
          .accounts({
            campaign: campaignKp.publicKey,
            vault,
            creator: creator.publicKey,
          })
          .signers([])
          .rpc(),
      "AlreadyClaimed" // The "flip the switch" protection worked!
    );
  });

  it("Rejects withdraw by non-creator", async () => {
    // Create a completely fresh campaign to test the `has_one = creator` constraint
    const freshCampaign = Keypair.generate();
    const imposter = Keypair.generate(); // Someone who is NOT the creator

    await airdrop(imposter.publicKey, 0.2 * LAMPORTS_PER_SOL);

    // Create the campaign (our main provider wallet = creator)
    const { vault: freshVault } = await setupCampaign(
      freshCampaign,
      new anchor.BN(0.1 * LAMPORTS_PER_SOL),
      15
    );

    // Imposter donates to it (this is fine, anyone can donate)
    await fundCampaign(
      freshCampaign.publicKey,
      freshVault,
      imposter,
      new anchor.BN(0.1 * LAMPORTS_PER_SOL)
    );

    await sleep(16); // Wait for deadline

    // Imposter tries to pass THEMSELVES as "creator" to steal the funds.
    // Should FAIL because has_one = creator checks the stored creator address
    // against the signer — they don't match.
    await expectError(
      () =>
        program.methods
          .withdraw()
          .accounts({
            campaign: freshCampaign.publicKey,
            vault: freshVault,
            creator: imposter.publicKey, // Imposter claims to be creator — rejected!
          })
          .signers([imposter])
          .rpc(),
      "ConstraintHasOne" // Anchor's built-in error for has_one violations
    );
  });
});

// ---------------------------------------------------------------------------
// TESTS – failed campaign → refund
// ---------------------------------------------------------------------------
// These tests verify the "sad path" for donors:
// Campaign FAILS to reach its goal → donors get their SOL back.

describe("crowdfunding – failed campaign (refund)", () => {
  const campaignKp = Keypair.generate();
  const donor = Keypair.generate();

  // Goal is 1 SOL, but donor only has 0.2 SOL → campaign will FAIL to reach goal
  const goal = new anchor.BN(1 * LAMPORTS_PER_SOL);

  let vault: PublicKey;
  let contribution: PublicKey;

  before(async () => {
    await airdrop(donor.publicKey, 0.2 * LAMPORTS_PER_SOL);
  });

  it("Refunds donor after failed campaign and closes contribution account", async () => {
    const result = await setupCampaign(campaignKp, goal, 15);
    vault = result.vault;

    // Donor gives 0.1 SOL — far less than the 1 SOL goal
    contribution = await fundCampaign(
      campaignKp.publicKey,
      vault,
      donor,
      new anchor.BN(0.1 * LAMPORTS_PER_SOL)
    );

    await sleep(16); // Wait for deadline to pass

    // Record donor's balance before refund
    const balBefore = await connection.getBalance(donor.publicKey);

    // Call refund — succeeds because:
    // 1. Deadline passed (clock >= deadline)
    // 2. Goal was NOT reached (raised < goal)
    await program.methods
      .refund()
      .accounts({
        campaign: campaignKp.publicKey,
        contribution,
        vault,
        donor: donor.publicKey,
      })
      .signers([donor]) // Donor signs their own refund request
      .rpc();

    // VERIFICATION: Donor got their SOL back (balance went up)
    const balAfter = await connection.getBalance(donor.publicKey);
    assert.isAbove(balAfter, balBefore);

    // VERIFICATION: The contribution account is now CLOSED (deleted from blockchain).
    // `getAccountInfo` returns null for accounts that don't exist.
    // This also means the donor got their storage rent back!
    const info = await connection.getAccountInfo(contribution);
    assert.isNull(info, "Contribution account should be closed after refund");

    // VERIFICATION: Campaign's raised total decreased back to 0
    const acct = await program.account.campaign.fetch(campaignKp.publicKey);
    assert.equal(acct.raised.toNumber(), 0);
  });

  it("Rejects refund when goal is reached", async () => {
    // Create a NEW campaign where the goal IS met — refund should be blocked.
    const fundedCampaign = Keypair.generate();
    const fundedDonor = Keypair.generate();

    await airdrop(fundedDonor.publicKey, 0.2 * LAMPORTS_PER_SOL);

    // Small goal: 0.05 SOL — easy to exceed
    const { vault: fundedVault } = await setupCampaign(
      fundedCampaign,
      new anchor.BN(0.05 * LAMPORTS_PER_SOL),
      15
    );

    // Donate 0.06 SOL — MORE than the 0.05 SOL goal → campaign SUCCEEDS
    const fundedContribution = await fundCampaign(
      fundedCampaign.publicKey,
      fundedVault,
      fundedDonor,
      new anchor.BN(0.06 * LAMPORTS_PER_SOL)
    );

    await sleep(16); // Wait for deadline

    // Donor tries to get a refund even though the campaign SUCCEEDED.
    // Should FAIL because: require!(campaign.raised < campaign.goal, GoalReached)
    await expectError(
      () =>
        program.methods
          .refund()
          .accounts({
            campaign: fundedCampaign.publicKey,
            contribution: fundedContribution,
            vault: fundedVault,
            donor: fundedDonor.publicKey,
          })
          .signers([fundedDonor])
          .rpc(),
      "GoalReached" // Can't refund a successful campaign!
    );
  });

  it("Rejects withdraw when goal not reached", async () => {
    // The creator tries to withdraw from the FAILED campaign (from the first test above).
    // Should FAIL because: require!(campaign.raised >= campaign.goal, GoalNotReached)
    await expectError(
      () =>
        program.methods
          .withdraw()
          .accounts({
            campaign: campaignKp.publicKey, // The failed campaign
            vault,
            creator: creator.publicKey,
          })
          .signers([])
          .rpc(),
      "GoalNotReached" // Creator can't take money from a failed campaign
    );
  });
});
