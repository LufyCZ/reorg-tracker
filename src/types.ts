import { Block, Log } from "viem";

export type BlockWithEvents = Block & { events: Log[] };
