import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Crowdfunding } from "../target/types/crowdfunding";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { assert } from "chai";

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.crowdfunding as Program<Crowdfunding>;
const connection = provider.connection;
const creator = provider.wallet;

// ---------------------------------------------------------------------------
// PDA helpers
// ---------------------------------------------------------------------------

function deriveVault(campaignKey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), campaignKey.toBuffer()],
    program.programId
  );
}

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
// Transaction helpers
// ---------------------------------------------------------------------------

async function airdrop(to: PublicKey, amount: number) {
  const sig = await connection.requestAirdrop(to, amount);
  await connection.confirmTransaction(sig);
}

async function getCurrentBlockTime(): Promise<number> {
  const slot = await connection.getSlot();
  return (await connection.getBlockTime(slot))!;
}

/** Creates a campaign and returns the derived vault PDA. */
async function setupCampaign(
  campaignKp: Keypair,
  goal: anchor.BN,
  deadlineOffset: number
): Promise<{ vault: PublicKey; deadline: anchor.BN }> {
  const [vault] = deriveVault(campaignKp.publicKey);
  const blockTime = await getCurrentBlockTime();
  const deadline = new anchor.BN(blockTime + deadlineOffset);

  await program.methods
    .createCampaign(goal, deadline)
    .accounts({
      campaign: campaignKp.publicKey,
      vault,
      creator: creator.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([campaignKp])
    .rpc();

  return { vault, deadline };
}

/** Contributes to a campaign on behalf of a donor. */
async function fundCampaign(
  campaignKey: PublicKey,
  vault: PublicKey,
  donor: Keypair,
  amount: anchor.BN
): Promise<PublicKey> {
  const [contribution] = deriveContribution(campaignKey, donor.publicKey);

  await program.methods
    .contribute(amount)
    .accounts({
      campaign: campaignKey,
      contribution,
      vault,
      donor: donor.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([donor])
    .rpc();

  return contribution;
}

/** Asserts that an RPC call rejects with the expected error code string. */
async function expectError(fn: () => Promise<unknown>, errorCode: string) {
  try {
    await fn();
    assert.fail(`Expected error '${errorCode}' but call succeeded`);
  } catch (err) {
    assert.include(err.toString(), errorCode);
  }
}

/** Wait for N seconds (use after setting short deadlines in tests). */
const sleep = (seconds: number) =>
  new Promise((r) => setTimeout(r, seconds * 1000));

// ---------------------------------------------------------------------------
// Tests – basic campaign lifecycle
// ---------------------------------------------------------------------------

describe("crowdfunding", () => {
  const campaignKp = Keypair.generate();
  const donor = Keypair.generate();
  const goal = new anchor.BN(1000 * LAMPORTS_PER_SOL);

  let vault: PublicKey;
  let contribution: PublicKey;

  before(async () => {
    await airdrop(donor.publicKey, 2000 * LAMPORTS_PER_SOL);
  });

  it("Creates a campaign", async () => {
    const result = await setupCampaign(campaignKp, goal, 10);
    vault = result.vault;
    [contribution] = deriveContribution(campaignKp.publicKey, donor.publicKey);

    const acct = await program.account.campaign.fetch(campaignKp.publicKey);
    assert.ok(acct.creator.equals(creator.publicKey));
    assert.ok(acct.goal.eq(goal));
    assert.equal(acct.raised.toNumber(), 0);
    assert.equal(acct.claimed, false);
  });

  it("Rejects campaign with zero goal", async () => {
    const kp = Keypair.generate();
    const [v] = deriveVault(kp.publicKey);
    const blockTime = await getCurrentBlockTime();

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
      "ZeroGoal"
    );
  });

  it("Rejects campaign with past deadline", async () => {
    const kp = Keypair.generate();
    const [v] = deriveVault(kp.publicKey);

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
    const amount = new anchor.BN(600 * LAMPORTS_PER_SOL);

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

    const acct = await program.account.campaign.fetch(campaignKp.publicKey);
    assert.ok(acct.raised.eq(amount));

    const contrib = await program.account.contribution.fetch(contribution);
    assert.ok(contrib.amount.eq(amount));
    assert.ok(contrib.donor.equals(donor.publicKey));
  });

  it("Accepts a second contribution from the same donor (accumulates)", async () => {
    const amount = new anchor.BN(200 * LAMPORTS_PER_SOL);

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

    const acct = await program.account.campaign.fetch(campaignKp.publicKey);
    assert.ok(acct.raised.eq(new anchor.BN(800 * LAMPORTS_PER_SOL)));

    const contrib = await program.account.contribution.fetch(contribution);
    assert.ok(contrib.amount.eq(new anchor.BN(800 * LAMPORTS_PER_SOL)));
  });

  it("Rejects zero-amount contribution", async () => {
    const zeroDonor = Keypair.generate();
    await airdrop(zeroDonor.publicKey, 10 * LAMPORTS_PER_SOL);
    const [zeroContribution] = deriveContribution(
      campaignKp.publicKey,
      zeroDonor.publicKey
    );

    await expectError(
      () =>
        program.methods
          .contribute(new anchor.BN(0))
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
    await expectError(
      () =>
        program.methods
          .withdraw()
          .accounts({
            campaign: campaignKp.publicKey,
            vault,
            creator: creator.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .rpc(),
      "CampaignNotEnded"
    );
  });

  it("Rejects refund before deadline", async () => {
    await expectError(
      () =>
        program.methods
          .refund()
          .accounts({
            campaign: campaignKp.publicKey,
            contribution,
            vault,
            donor: donor.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([donor])
          .rpc(),
      "CampaignNotEnded"
    );
  });
});

// ---------------------------------------------------------------------------
// Tests – successful campaign → withdraw
// ---------------------------------------------------------------------------

describe("crowdfunding – successful campaign (withdraw)", () => {
  const campaignKp = Keypair.generate();
  const donor = Keypair.generate();
  const goal = new anchor.BN(100 * LAMPORTS_PER_SOL);

  let vault: PublicKey;

  before(async () => {
    await airdrop(donor.publicKey, 200 * LAMPORTS_PER_SOL);
  });

  it("Funds campaign above goal, then creator withdraws after deadline", async () => {
    const result = await setupCampaign(campaignKp, goal, 2);
    vault = result.vault;

    await fundCampaign(
      campaignKp.publicKey,
      vault,
      donor,
      new anchor.BN(150 * LAMPORTS_PER_SOL)
    );

    await sleep(3);

    const balBefore = await connection.getBalance(creator.publicKey);

    await program.methods
      .withdraw()
      .accounts({
        campaign: campaignKp.publicKey,
        vault,
        creator: creator.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const balAfter = await connection.getBalance(creator.publicKey);
    assert.isAbove(balAfter, balBefore);

    const acct = await program.account.campaign.fetch(campaignKp.publicKey);
    assert.equal(acct.claimed, true);
  });

  it("Rejects double withdrawal", async () => {
    await expectError(
      () =>
        program.methods
          .withdraw()
          .accounts({
            campaign: campaignKp.publicKey,
            vault,
            creator: creator.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .rpc(),
      "AlreadyClaimed"
    );
  });

  it("Rejects withdraw by non-creator", async () => {
    const freshCampaign = Keypair.generate();
    const imposter = Keypair.generate();

    await airdrop(imposter.publicKey, 200 * LAMPORTS_PER_SOL);

    const { vault: freshVault } = await setupCampaign(
      freshCampaign,
      new anchor.BN(10 * LAMPORTS_PER_SOL),
      2
    );
    await fundCampaign(
      freshCampaign.publicKey,
      freshVault,
      imposter,
      new anchor.BN(20 * LAMPORTS_PER_SOL)
    );

    await sleep(3);

    // Imposter tries to withdraw — should fail (has_one = creator)
    await expectError(
      () =>
        program.methods
          .withdraw()
          .accounts({
            campaign: freshCampaign.publicKey,
            vault: freshVault,
            creator: imposter.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([imposter])
          .rpc(),
      "ConstraintHasOne"
    );
  });
});

// ---------------------------------------------------------------------------
// Tests – failed campaign → refund
// ---------------------------------------------------------------------------

describe("crowdfunding – failed campaign (refund)", () => {
  const campaignKp = Keypair.generate();
  const donor = Keypair.generate();
  const goal = new anchor.BN(1000 * LAMPORTS_PER_SOL);

  let vault: PublicKey;
  let contribution: PublicKey;

  before(async () => {
    await airdrop(donor.publicKey, 200 * LAMPORTS_PER_SOL);
  });

  it("Refunds donor after failed campaign and closes contribution account", async () => {
    const result = await setupCampaign(campaignKp, goal, 2);
    vault = result.vault;

    contribution = await fundCampaign(
      campaignKp.publicKey,
      vault,
      donor,
      new anchor.BN(100 * LAMPORTS_PER_SOL)
    );

    await sleep(3);

    const balBefore = await connection.getBalance(donor.publicKey);

    await program.methods
      .refund()
      .accounts({
        campaign: campaignKp.publicKey,
        contribution,
        vault,
        donor: donor.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([donor])
      .rpc();

    const balAfter = await connection.getBalance(donor.publicKey);
    assert.isAbove(balAfter, balBefore);

    // Contribution account should be closed
    const info = await connection.getAccountInfo(contribution);
    assert.isNull(info, "Contribution account should be closed after refund");

    // Campaign raised should be updated
    const acct = await program.account.campaign.fetch(campaignKp.publicKey);
    assert.equal(acct.raised.toNumber(), 0);
  });

  it("Rejects refund when goal is reached", async () => {
    const fundedCampaign = Keypair.generate();
    const fundedDonor = Keypair.generate();

    await airdrop(fundedDonor.publicKey, 50 * LAMPORTS_PER_SOL);

    const { vault: fundedVault } = await setupCampaign(
      fundedCampaign,
      new anchor.BN(10 * LAMPORTS_PER_SOL),
      2
    );
    const fundedContribution = await fundCampaign(
      fundedCampaign.publicKey,
      fundedVault,
      fundedDonor,
      new anchor.BN(20 * LAMPORTS_PER_SOL)
    );

    await sleep(3);

    await expectError(
      () =>
        program.methods
          .refund()
          .accounts({
            campaign: fundedCampaign.publicKey,
            contribution: fundedContribution,
            vault: fundedVault,
            donor: fundedDonor.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([fundedDonor])
          .rpc(),
      "GoalReached"
    );
  });

  it("Rejects withdraw when goal not reached", async () => {
    await expectError(
      () =>
        program.methods
          .withdraw()
          .accounts({
            campaign: campaignKp.publicKey,
            vault,
            creator: creator.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .rpc(),
      "GoalNotReached"
    );
  });
});
