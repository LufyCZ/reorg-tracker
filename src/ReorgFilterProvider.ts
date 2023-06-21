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
  address?: Address | Address[];
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

interface ReorgFilterProviderProps {
  rpcUrl: string;
  filters?: Omit<GetLogsParameters, "fromBlock" | "toBlock">;
  keepBlocks?: number;
}

export class ReorgFilterProvider {
  private client;
  public unwatch;

  public filters;

  public hashMap: Map<string, BlockWithEvents> = new Map();
  public numberMap: Map<number, BlockWithEvents> = new Map();

  public blockFirst = -1;
  public blockHead = -1;
  public keepBlocks;

  public filterChangesMap: Map<number, { filters?: Filter; newLogs: Log[] }> =
    new Map();

  constructor({ rpcUrl, filters, keepBlocks }: ReorgFilterProviderProps) {
    this.filters = filters;
    this.keepBlocks = keepBlocks;

    this.client = createPublicClient({
      transport: http(rpcUrl),
    });

    this.unwatch = this.client.watchBlocks({
      onBlock: (block) => this.onBlock(block),
    });
  }

  public createFilter(args?: Filter): number {
    const id = this.filterChangesMap.size;
    this.filterChangesMap.set(id, {
      filters: args,
      newLogs: [],
    });
    return id;
  }

  public getFilterChanges(id: number): Log[] {
    if (!this.filterChangesMap.has(id))
      throw new Error(`Filter ${id} not found`);

    const { filters, newLogs } = this.filterChangesMap.get(id)!;

    this.filterChangesMap.set(id, {
      filters,
      newLogs: [],
    });

    return newLogs;
  }

  private purgeBlocks = () => {
    if (this.keepBlocks === undefined) return;

    if (this.blockHead - this.blockFirst < this.keepBlocks) return;

    const newBlockFirst = this.blockHead - this.keepBlocks;

    for (let i = this.blockFirst; i < newBlockFirst; i++) {
      const block = this.numberMap.get(i)!;
      this.numberMap.delete(i);
      this.hashMap.delete(block.hash!);
    }

    if (this.numberMap.size !== this.hashMap.size) {
      for (const blockHash of this.hashMap.keys()) {
        if (this.hashMap.get(blockHash)!.number! < newBlockFirst) {
          this.hashMap.delete(blockHash);
        }
      }
    }

    this.blockFirst = newBlockFirst;
  };

  private detectReorg = async (block: Block) => {
    // Shoudldn't happen
    if (!block.hash || !block.number) return false;

    // First block
    if (this.numberMap.size < 2) return false;
    if (this.blockFirst >= block.number) return false;

    let prevBlock = this.numberMap.get(Number(block.number) - 1);

    if (!prevBlock?.hash) {
      prevBlock = await this.onBlock(
        await this.client.getBlock({ blockNumber: block.number - 1n })
      );
    }

    if (prevBlock!.hash === block.parentHash) return false;

    return true;
  };

  private handleReorg = async (block: BlockWithEvents) => {
    // Shoudldn't happen
    if (!block.hash || !block.number) return;

    const prevBlock = this.numberMap.get(Number(block.number) - 1)!;

    prevBlock.events = prevBlock.events.map((event) => ({
      ...event,
      removed: true,
    }));
    this.hashMap.set(prevBlock.hash!, prevBlock);

    this.handleEventChanges(prevBlock);

    await this.onBlock(
      await this.client.getBlock({ blockNumber: block.number - 1n })
    );
  };

  private handleEventChanges = (block: BlockWithEvents) => {
    for (const { filters, newLogs } of this.filterChangesMap.values()) {
      if (
        !filters ||
        isMatchedLogInBloomFilter({
          bloom: block.logsBloom!,
          logFilters: [filters],
        })
      ) {
        const logs = filters ? filterLogs(block.events, filters) : block.events;
        newLogs.push(...logs);
      }
    }
  };

  public onBlock = async (block: Block) => {
    // Pending
    if (!block.hash || !block.number) return;

    const events = await this.client.getLogs({
      ...this.filters,
      blockHash: block.hash,
    });

    const blockWithEvents: BlockWithEvents = {
      ...block,
      events: events.map((event) => ({ ...event, removed: false })),
    };

    if (this.blockHead < Number(block.number)) {
      this.blockHead = Number(block.number);
    }

    if (this.blockFirst === -1) {
      this.blockFirst = Number(block.number);
    }

    this.hashMap.set(block.hash, blockWithEvents);
    this.numberMap.set(Number(block.number), blockWithEvents);

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
    this.purgeBlocks();

    return blockWithEvents;
  };
}
