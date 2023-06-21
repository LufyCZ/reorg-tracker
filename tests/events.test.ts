import { ReorgFilterProvider } from "../src/ReorgFilterProvider";
import { createAnvil } from "@viem/anvil";
import {
  Address,
  Block,
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
import { getState, mineBlocks, setState } from "./helpers";

const anvil = createAnvil({
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
    provider = new ReorgFilterProvider({ rpcUrl: anvilUrl });
  });

  it("Captures no events on empty blocks", async () => {
    const filterId = provider.createFilter({
      address: token.address,
    });

    await mineBlocks(publicClient, 1);
    await provider.onBlock(await publicClient.getBlock({ blockTag: "latest" }));

    expect(provider.getFilterChanges(filterId)).to.be.empty;
  });

  it("Captures events on a non-empty block, prints them only once", async () => {
    const filterId = provider.createFilter({
      address: token.address,
    });

    await writeContract(walletClient, {
      ...token,
      account: accounts[0],
      functionName: "transfer",
      args: [accounts[1], 100n],
      chain: null,
    });

    await mineBlocks(publicClient, 1);
    await provider.onBlock(await publicClient.getBlock({ blockTag: "latest" }));

    const changes = provider.getFilterChanges(filterId);

    expect(changes).to.have.length(1);
    expect(changes[0].address).to.equal(token.address);
    expect(changes[0].blockNumber).to.equal(
      await publicClient.getBlockNumber()
    );
    expect(changes[0].removed).to.be.false;

    expect(provider.getFilterChanges(filterId)).to.be.empty;

    await mineBlocks(publicClient, 1);
    await provider.onBlock(await publicClient.getBlock({ blockTag: "latest" }));

    expect(provider.getFilterChanges(filterId)).to.be.empty;
  });

  it("Captures events on a non-empty block, then does it again", async () => {
    const filterId = provider.createFilter({
      address: token.address,
    });

    await writeContract(walletClient, {
      ...token,
      account: accounts[0],
      functionName: "transfer",
      args: [accounts[1], 100n],
      chain: null,
    });

    await mineBlocks(publicClient, 1);
    await provider.onBlock(await publicClient.getBlock({ blockTag: "latest" }));

    expect(provider.getFilterChanges(filterId)).to.have.length(1);

    await mineBlocks(publicClient, 1);
    await provider.onBlock(await publicClient.getBlock({ blockTag: "latest" }));

    expect(provider.getFilterChanges(filterId)).to.be.empty;

    await writeContract(walletClient, {
      ...token,
      account: accounts[0],
      functionName: "transfer",
      args: [accounts[1], 100n],
      chain: null,
    });

    await mineBlocks(publicClient, 1);
    await provider.onBlock(await publicClient.getBlock({ blockTag: "latest" }));

    expect(provider.getFilterChanges(filterId)).to.have.length(1);
  });

  it("Captures events on non-empty blocks", async () => {
    const filterId = provider.createFilter({
      address: token.address,
    });

    await writeContract(walletClient, {
      ...token,
      account: accounts[0],
      functionName: "transfer",
      args: [accounts[1], 100n],
      chain: null,
    });

    await writeContract(walletClient, {
      ...token,
      account: accounts[0],
      functionName: "transfer",
      args: [accounts[1], 200n],
      chain: null,
    });

    await mineBlocks(publicClient, 1);
    await provider.onBlock(await publicClient.getBlock({ blockTag: "latest" }));

    await writeContract(walletClient, {
      ...token,
      account: accounts[0],
      functionName: "transfer",
      args: [accounts[1], 300n],
      chain: null,
    });

    await mineBlocks(publicClient, 1);
    await provider.onBlock(await publicClient.getBlock({ blockTag: "latest" }));

    const changes = provider.getFilterChanges(filterId);

    expect(changes).to.have.length(3);
  });

  it("Marks forked events as removed", async () => {
    await mineBlocks(publicClient, 1);
    await provider.onBlock(await publicClient.getBlock({ blockTag: "latest" }));
    const filterId = provider.createFilter({
      address: token.address,
    });

    const forkedAmount = 100;

    await writeContract(walletClient, {
      ...token,
      account: accounts[0],
      functionName: "transfer",
      args: [accounts[1], BigInt(forkedAmount)],
      chain: null,
    });

    await mineBlocks(publicClient, 1);
    await provider.onBlock(await publicClient.getBlock({ blockTag: "latest" }));

    // Reset
    snapshotId = await setState(publicClient, snapshotId);
    await mineBlocks(publicClient, 1);
    await provider.onBlock(await publicClient.getBlock({ blockTag: "latest" }));

    const canonAmount = 200;

    await writeContract(walletClient, {
      ...token,
      account: accounts[0],
      functionName: "transfer",
      args: [accounts[1], BigInt(canonAmount)],
      chain: null,
    });

    await mineBlocks(publicClient, 2);
    await provider.onBlock(await publicClient.getBlock({ blockTag: "latest" }));

    const changes = provider.getFilterChanges(filterId);

    expect(changes).to.have.length(3);

    const forkedEvents = changes.filter(
      (e) => parseInt(e.data, 16) === forkedAmount
    );
    const canonEvent = changes.find(
      (e) => parseInt(e.data, 16) === canonAmount
    );

    expect(forkedEvents).to.have.length(2);
    expect(canonEvent).to.exist;

    // Same event added, then removed
    expect(forkedEvents.some((e) => !e.removed)).to.be.true;
    expect(forkedEvents.some((e) => e.removed)).to.be.true;

    expect(canonEvent!.removed).to.be.false;
  });

  after(async () => {
    await provider.unwatch();
    await anvil.stop();
  });
});
