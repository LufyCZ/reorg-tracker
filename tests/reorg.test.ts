import { ReorgFilterProvider } from "../src/ReorgFilterProvider";
import { createAnvil } from "@viem/anvil";
import {
  Address,
  Block,
  PublicClient,
  WalletClient,
  createPublicClient,
  createWalletClient,
  http,
} from "viem";
import { expect } from "chai";
import { getState, mineBlocks, setState } from "./helpers";

let anvil = createAnvil({
  noMining: true,
  port: 29988,
  pruneHistory: false,
});

const anvilUrl = `http://${anvil.host}:${anvil.port}`;

describe("Reorg tests", function () {
  let publicClient: PublicClient;
  let walletClient: WalletClient;

  let provider: ReorgFilterProvider;

  let snapshotId: string;

  let accounts: Address[];

  this.timeout(10000);

  before(async () => {
    await anvil.start();

    publicClient = createPublicClient({
      transport: http(anvilUrl),
      pollingInterval: 0,
    });

    walletClient = createWalletClient({
      transport: http(anvilUrl),
    });

    accounts = await walletClient.getAddresses();

    snapshotId = await getState(publicClient);
  });

  beforeEach(async () => {
    snapshotId = await setState(publicClient, snapshotId);
    provider = new ReorgFilterProvider(anvilUrl, {});
  });

  it("Loads 2 blocks when 2 blocks are mined", async () => {
    // Apparently, when mining blocks manually, the events are not emmited
    await mineBlocks(publicClient, 1);
    await provider.onBlock(await publicClient.getBlock({ blockTag: "latest" }));

    await mineBlocks(publicClient, 1);
    await provider.onBlock(await publicClient.getBlock({ blockTag: "latest" }));

    expect(provider.hashMap.size).to.equal(2);
    expect(provider.numberMap.size).to.equal(2);
  });

  it("Backfills blocks when they are skipped", async () => {
    // Apparently, when mining blocks manually, the events are not emmited
    await mineBlocks(publicClient, 1);
    await provider.onBlock(await publicClient.getBlock({ blockTag: "latest" }));

    await mineBlocks(publicClient, 2);

    await mineBlocks(publicClient, 1);
    await provider.onBlock(await publicClient.getBlock({ blockTag: "latest" }));

    expect(provider.hashMap.size).to.equal(4);
    expect(provider.numberMap.size).to.equal(4);
  });

  it("Correctly reorgs 1 forked block", async () => {
    await mineBlocks(publicClient, 1);
    await provider.onBlock(await publicClient.getBlock({ blockTag: "latest" }));

    // Reset back to the base state
    snapshotId = await setState(publicClient, snapshotId);

    // Make sure the block's different
    await walletClient.sendTransaction({
      account: accounts[0],
      to: accounts[1],
      value: 10n,
      chain: null,
    });
    await mineBlocks(publicClient, 1);
    const canonBlock = await publicClient.getBlock({ blockTag: "latest" });

    await mineBlocks(publicClient, 3);
    await provider.onBlock(await publicClient.getBlock({ blockTag: "latest" }));

    expect(provider.hashMap.size).to.equal(5);
    expect(provider.numberMap.size).to.equal(4);

    expect(Array.from(provider.numberMap.values())[0].hash === canonBlock.hash);
  });

  it("Correctly reorgs 3 forked block with 1 cannon block missing", async () => {
    const forkedBlocks: Block[] = [];

    for (let i = 0; i < 3; i++) {
      await mineBlocks(publicClient, 1);
      forkedBlocks.push(await publicClient.getBlock({ blockTag: "latest" }));
      await provider.onBlock(forkedBlocks[i]);
    }

    // Reset back to the base state
    snapshotId = await setState(publicClient, snapshotId);

    // Make sure the block's different
    await walletClient.sendTransaction({
      account: accounts[0],
      to: accounts[1],
      value: 10n,
      chain: null,
    });

    const canonBlocks: Block[] = [];

    for (let i = 0; i < 4; i++) {
      await mineBlocks(publicClient, 1);
      canonBlocks[i] = await publicClient.getBlock({ blockTag: "latest" });

      if (i === 2) continue;
      await provider.onBlock(canonBlocks[i]);
    }

    expect(
      Array.from(provider.numberMap.values()).some((canonBlock) =>
        forkedBlocks.find((forkedBlock) => canonBlock.hash === forkedBlock.hash)
      )
    ).to.be.false;

    expect(
      Array.from(provider.numberMap.values()).every((block) =>
        canonBlocks.find((canonBlock) => block.hash === canonBlock.hash)
      )
    ).to.be.true;
  });

  after(async () => {
    await provider.unwatch();
    await anvil.stop();
  });
});
