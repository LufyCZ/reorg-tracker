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
import { isMatchedLogInBloomFilter } from "./bloom.js";

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

  public filterChangesMap: Map<number, { filters?: Filter; newEvents: Log[] }> =
    new Map();

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
      filters: args,
      newEvents: [],
    });
    return id;
  }

  public getFilterChanges(id: number): Log[] {
    if (!this.filterChangesMap.has(id))
      throw new Error(`Filter ${id} not found`);

    const { filters, newEvents } = this.filterChangesMap.get(id)!;

    this.filterChangesMap.set(id, {
      filters,
      newEvents: [],
    });

    return newEvents;
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

  private handleEventChanges = async (block: BlockWithEvents) => {
    for (const { filters, newEvents } of this.filterChangesMap.values()) {
      if (
        !filters ||
        isMatchedLogInBloomFilter({
          bloom: block.logsBloom!,
          logFilters: [filters],
        })
      ) {
        if (filters) {
          newEvents.push(...filterLogs(block.events, filters));
        }
        newEvents.push(...block.events);
      }
    }
  };

  public onBlock = async (block: Block) => {
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

    // Recursively backfill missing blocks
    if (block.number > this.blockFirst) {
      if (!this.numberMap.has(Number(block.number) - 1)) {
        await this.onBlock(
          await this.client.getBlock({ blockNumber: block.number - 1n })
        );
      }
    }

    this.handleEventChanges(blockWithEvents);
  };
}
