import {
  Block,
  createPublicClient,
  http,
  GetLogsParameters,
  GetFilterChangesReturnType,
  Log,
  Address,
} from "viem";

import { BlockWithEvents } from "./types.js";

interface Filter {
  address?: Address[];
  topics?: Address[];
  fromBlock?: number;
  toBlock?: number;
}

function filterLogs(allLogs: Log[], filter: Filter) {
  return allLogs.filter((log) => {
    let matches = true;
    matches &&=
      !filter.address ||
      (Array.isArray(filter.address)
        ? filter.address
        : [filter.address]
      ).includes(log.address);
    matches &&=
      !filter.fromBlock || Number(filter.fromBlock) <= Number(log.blockNumber);
    matches &&=
      !filter.fromBlock || Number(filter.toBlock) >= Number(log.blockNumber);
    matches &&=
      !filter.topics ||
      filter.topics.every((topic, index) => log.topics[index] === topic);

    return matches;
  });
}

export class ReorgFilterProvider {
  private client;
  public unwatch;

  public filters;

  public hashMap: Map<string, BlockWithEvents> = new Map();
  public numberMap: Map<
    number,
    { canon: BlockWithEvents; forked: BlockWithEvents[] }
  > = new Map();

  public blockFirst = -1;
  public blockHead = -1;

  public filterChangesMap: Map<
    number,
    { blockHash?: string; filters?: Filter }
  > = new Map();

  constructor(
    rpcUrl: string,
    filters: Omit<GetLogsParameters, "fromBlock" | "toBlock">
  ) {
    this.filters = filters;

    this.client = createPublicClient({
      transport: http(rpcUrl),
    });

    this.unwatch = this.client.watchBlocks({ onBlock: this.onBlock });
  }

  public createFilter(args?: Filter): number {
    const id = this.filterChangesMap.size;
    this.filterChangesMap.set(id, {
      blockHash: this.numberMap.get(this.blockHead)?.canon.hash ?? undefined,
      filters: args,
    });
    return id;
  }

  public getFilterChanges(id: number): Log[] {
    if (!this.filterChangesMap.has(id))
      throw new Error(`Filter ${id} not found`);

    // Return all events *after* this block hash
    const { blockHash: prevBlockHash, filters } =
      this.filterChangesMap.get(id)!;

    let prevBlockNumber = 0;

    if (prevBlockHash) {
      prevBlockNumber = Number(this.hashMap.get(prevBlockHash)!.number!);
    }

    const allBlocks = Array.from(this.numberMap.entries())
      .filter(([blockNumber]) => blockNumber > prevBlockNumber)
      .reduce((acc, [_, { canon, forked }]) => {
        acc.push(canon, ...forked);
        return acc;
      }, [] as BlockWithEvents[]);

    const allLogs = allBlocks.reduce((acc, block) => {
      acc.push(...block.events);
      return acc;
    }, [] as Log[]);

    this.filterChangesMap.set(id, {
      blockHash: this.numberMap.get(this.blockHead)?.canon.hash ?? undefined,
      filters,
    });

    return filters ? filterLogs(allLogs, filters) : allLogs;
  }

  private detectReorg = async (block: Block) => {
    // Shoudldn't happen
    if (!block.hash || !block.number) return false;

    // First block
    if (this.numberMap.size < 2) return false;

    const prevBlock = this.numberMap.get(Number(block.number) - 1);

    if (!prevBlock?.canon.hash) {
      await this.onBlock(
        await this.client.getBlock({ blockNumber: block.number - 1n })
      );
      return false;
    }

    if (prevBlock.canon.hash === block.parentHash) return false;

    return true;
  };

  private handleReorg = async (block: BlockWithEvents) => {
    // Shoudldn't happen
    if (!block.hash || !block.number) return;

    const prevBlock = this.numberMap.get(Number(block.number) - 1)!.canon;
    prevBlock.events = prevBlock.events.map((event) => ({
      ...event,
      removed: true,
    }));
    this.hashMap.set(prevBlock.hash!, prevBlock);

    await this.onBlock(await this.getBlockByHashWithEvents(block.parentHash));
  };

  private getBlockByHashWithEvents = async (blockHash: `0x${string}`) => {
    const [events, block] = await Promise.all([
      this.client.getLogs({ ...this.filters, blockHash }),
      this.client.getBlock({ blockHash }),
    ]);

    const blockWithEvents: BlockWithEvents = {
      ...block,
      events: events.map((event) => ({ ...event, removed: false })),
    };

    return blockWithEvents;
  };

  private onBlock = async (block: Block) => {
    // Pending
    if (!block.hash || !block.number) return;

    const events = await this.client.getLogs({
      blockHash: block.hash,
      ...this.filters,
    });

    const blockWithEvents: BlockWithEvents = {
      ...block,
      events: events.map((event) => ({ ...event, removed: false })),
    };

    this.hashMap.set(block.hash, blockWithEvents);

    if (!this.numberMap.has(Number(block.number))) {
      this.numberMap.set(Number(block.number), {
        canon: blockWithEvents,
        forked: [],
      });
    } else {
      // Presume that new block is the canonical one
      this.numberMap.set(Number(block.number), {
        canon: blockWithEvents,
        forked: [
          ...this.numberMap.get(Number(block.number))!.forked,
          this.numberMap.get(Number(block.number))!.canon,
        ],
      });
    }

    if (this.blockHead < Number(block.number)) {
      this.blockHead = Number(block.number);
    }

    if (this.blockFirst === -1) {
      this.blockFirst = Number(block.number);
    }

    if (await this.detectReorg(block)) {
      await this.handleReorg(blockWithEvents);
    }

    if (block.number > this.blockFirst) {
      if (!this.numberMap.has(Number(block.number) - 1)) {
        await this.onBlock(
          await this.client.getBlock({ blockNumber: block.number - 1n })
        );
      }
    }
  };
}
