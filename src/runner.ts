import { chains } from "./chains.js";
import { createPublicClient, http, Block } from "viem";
import { saveMap } from "./map.js";
import { BlockWithEvents } from "./types.js";

const chain = "ethereum";
const mapPath =
  process.argv[1].split("/").slice(0, -2).join("/") +
  `/data/${chain}/blocks.json`;

const client = createPublicClient({
  chain: chains[chain].chain,
  transport: http(chains[chain].httpTransport),
});

const numberMap: Map<number, BlockWithEvents> = new Map();
const hashMap: Map<string, BlockWithEvents> = new Map();

async function fetchEvents(blockHash: `0x${string}`) {
  return client.getLogs({ blockHash });
}

async function detectReorg(block: Block) {
  // Shoudldn't happen
  if (!block.hash || !block.number) return false;

  // First block
  if (numberMap.size < 2) return false;

  const prevBlock = numberMap.get(Number(block.number) - 1);

  if (!prevBlock?.hash) {
    await onBlock(await client.getBlock({ blockNumber: block.number - 1n }));
    return false;
  }

  if (prevBlock.hash === block.parentHash) return false;

  return true;
}

async function handleReorg(block: BlockWithEvents) {
  // Shoudldn't happen
  if (!block.hash || !block.number) return false;

  const blockClone = structuredClone(block);
  blockClone.events = blockClone.events.map((event) => ({
    ...event,
    invalid: true,
  }));
  hashMap.set(block.hash, blockClone);

  const prevBlock = await getBlockByHashWithEvents(block.parentHash);
  await onBlock(prevBlock);
}

async function getBlockByHashWithEvents(blockHash: `0x${string}`) {
  const [events, block] = await Promise.all([
    fetchEvents(blockHash),
    client.getBlock({ blockHash }),
  ]);

  const blockWithEvents: BlockWithEvents = {
    ...block,
    events: events.map((event) => ({ ...event, invalid: false })),
  };

  return blockWithEvents;
}

async function onBlock(block: Block) {
  // Pending
  if (!block.hash || !block.number) return;

  const events = await fetchEvents(block.hash);

  const blockWithEvents: BlockWithEvents = {
    ...block,
    events: events.map((event) => ({ ...event, invalid: false })),
  };

  hashMap.set(block.hash, blockWithEvents);
  numberMap.set(Number(block.number), blockWithEvents);

  let reorged = await detectReorg(block);
  if (reorged) {
    await handleReorg(blockWithEvents);
  }

  saveMap(hashMap, mapPath);
  console.log(
    "Saved",
    "Block Count:",
    hashMap.size,
    "Block Number:",
    block.number,
    "Detected Reorg:",
    reorged
  );
}

const unwatch = client.watchBlocks({ onBlock });

process.on("SIGINT", function () {
  unwatch();
  process.exit();
});
