import { ReorgFilterProvider } from "../src/ReorgFilterProvider";
import { createAnvil } from "@viem/anvil";
import {
  Address,
  Block,
  Client,
  GetContractReturnType,
  PublicClient,
  WalletClient,
  createPublicClient,
  createWalletClient,
  getContract,
  http,
} from "viem";
import { deployContract, writeContract } from "viem/contract";
import { erc20 } from "./contracts/erc20";
import { expect } from "chai";
import { BlockWithEvents } from "../src/types";

const anvil = createAnvil({
  noMining: true,
  port: 29988,
  pruneHistory: false,
});

const anvilUrl = `http://${anvil.host}:${anvil.port}`;

async function mineBlocks(client: Client, blocks: number) {
  return client.request<any>({ method: "anvil_mine", params: [blocks] });
}

async function getState(client: Client) {
  return client.request<any>({ method: "evm_snapshot" });
}

async function setState(client: Client, id: string) {
  await client.request<any>({ method: "evm_revert", params: [id] });
  return getState(client);
}

describe("Reorg tests", function () {
  let publicClient: PublicClient;
  let walletClient: WalletClient;

  let provider: ReorgFilterProvider;

  let snapshotId: string;

  let accounts: Address[];
  let token: GetContractReturnType<typeof erc20.abi>;

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

    const deployHash = await deployContract(walletClient, {
      abi: erc20.abi,
      bytecode: erc20.bytecode,
      account: accounts[0],
      chain: null,
    });

    await mineBlocks(walletClient, 1);

    const deployTx = await publicClient.getTransactionReceipt({
      hash: deployHash,
    });

    token = getContract({
      abi: erc20.abi,
      address: deployTx.contractAddress!,
      walletClient,
    });

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
    const forkedBlock = await publicClient.getBlock({ blockTag: "latest" });
    await provider.onBlock(await publicClient.getBlock({ blockTag: "latest" }));

    // Reset back to the base state
    snapshotId = await setState(publicClient, snapshotId);

    // Make sure the block's different
    await writeContract(walletClient, {
      ...token,
      chain: null,
      account: accounts[0],
      functionName: "approve",
      args: [accounts[0], 1000n],
    });
    await mineBlocks(publicClient, 1);
    const canonBlock = await publicClient.getBlock({ blockTag: "latest" });
    await provider.onBlock(canonBlock);

    await mineBlocks(publicClient, 1);
    await provider.onBlock(await publicClient.getBlock({ blockTag: "latest" }));

    expect(provider.hashMap.size).to.equal(3);
    expect(provider.numberMap.size).to.equal(2);

    expect(
      Array.from(provider.numberMap.values())[0].canon.hash === canonBlock.hash
    );
    expect(
      Array.from(provider.numberMap.values())[0].forked[0].hash ===
        forkedBlock.hash
    );
  });

  it("Correctly reorgs 3 forked block", async () => {
    const forkedBlocks: Block[] = [];

    for (let i = 0; i < 3; i++) {
      await mineBlocks(publicClient, 1);
      forkedBlocks.push(await publicClient.getBlock({ blockTag: "latest" }));
      await provider.onBlock(forkedBlocks[i]);
    }

    // Reset back to the base state
    snapshotId = await setState(publicClient, snapshotId);

    // Make sure the block's different
    await writeContract(walletClient, {
      ...token,
      chain: null,
      account: accounts[0],
      functionName: "approve",
      args: [accounts[0], 1000n],
    });

    const canonBlocks: Block[] = [];

    for (let i = 0; i < 4; i++) {
      await mineBlocks(publicClient, 1);
      canonBlocks.push(await publicClient.getBlock({ blockTag: "latest" }));
      await provider.onBlock(canonBlocks[i]);
    }

    forkedBlocks.forEach((forkedBlock, index) => {
      const canonBlock = canonBlocks[index];

      expect(
        Array.from(provider.numberMap.values())[index].canon.hash ===
          canonBlock.hash
      );
      expect(
        Array.from(provider.numberMap.values())[index].forked[0].hash ===
          forkedBlock.hash
      );
    });
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
    await writeContract(walletClient, {
      ...token,
      chain: null,
      account: accounts[0],
      functionName: "approve",
      args: [accounts[0], 1000n],
    });

    const canonBlocks: Block[] = [];

    for (let i = 0; i < 4; i++) {
      if (i === 2) continue;

      await mineBlocks(publicClient, 1);
      canonBlocks[i] = await publicClient.getBlock({ blockTag: "latest" });
      await provider.onBlock(canonBlocks[i]);
    }

    forkedBlocks.forEach((forkedBlock, index) => {
      if (index === 2) return;

      const canonBlock = canonBlocks[index];

      expect(
        Array.from(provider.numberMap.values())[index].canon.hash ===
          canonBlock.hash
      );
      expect(
        Array.from(provider.numberMap.values())[index].forked[0].hash ===
          forkedBlock.hash
      );
    });
  });

  after(async () => {
    await provider.unwatch();
    await anvil.stop();
  });
});
