import { Block, GetLogsReturnType } from "viem";

type EventWithInvalid = GetLogsReturnType[number] & { invalid: boolean };

export type BlockWithEvents = Block & { events: EventWithInvalid[] };
