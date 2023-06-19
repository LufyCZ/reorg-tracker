// Not a mocha test file

import { Log, createPublicClient, http } from "viem";
import { ReorgFilterProvider } from "../src/ReorgFilterProvider.js";
import { saveMap } from "../src/map.js";

const rpcUrl = "http://localhost:8545";

// USDC
const logSourceAddress = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as const;

const client = createPublicClient({
  transport: http(rpcUrl),
});

const provider = new ReorgFilterProvider(rpcUrl, {
  address: logSourceAddress,
});

const gethFilter = await client.createEventFilter({
  address: logSourceAddress,
});

const providerFilterId = provider.createFilter({
  address: logSourceAddress,
});

const gethTxHashMap = new Map<string, boolean>();
const gethTxRemovedHashMap = new Map<string, boolean>();
const providerTxHashMap = new Map<string, boolean>();
const providerRemovedTxHashMap = new Map<string, boolean>();

let gethLogCount = 0;
let providerLogCount = 0;

function transformLogs(logs: Log[]) {
  return logs.map((log) => ({
    txHash: log.transactionHash,
    blockNumber: Number(log.blockNumber),
    blockHash: log.blockHash,
    removed: log.removed,
  }));
}

while (true) {
  const gethLogs = transformLogs(
    await client.getFilterChanges({
      filter: gethFilter,
    })
  );

  const providerLogs = transformLogs(
    provider.getFilterChanges(providerFilterId)
  );

  const timestamp = Math.floor(Date.now() / 1000);

  gethLogs.forEach((log) => {
    if (log.removed) {
      gethTxRemovedHashMap.set(log.txHash!, true);
    } else {
      gethTxHashMap.set(log.txHash!, true);
    }
  });

  providerLogs.forEach((log) => {
    if (log.removed) {
      providerRemovedTxHashMap.set(log.txHash!, true);
    } else {
      providerTxHashMap.set(log.txHash!, true);
    }
  });

  gethLogCount += gethLogs.length;
  providerLogCount += providerLogs.length;

  const equal = JSON.stringify(gethLogs) === JSON.stringify(providerLogs);
  const equalSoFar =
    Array.from(gethTxHashMap.entries()).every(([txHash]) => {
      return providerTxHashMap.has(txHash);
    }) &&
    Array.from(gethTxRemovedHashMap.entries()).every(([txHash]) => {
      return providerRemovedTxHashMap.has(txHash);
    }) &&
    Array.from(providerTxHashMap.entries()).every(([txHash]) => {
      return gethTxHashMap.has(txHash);
    }) &&
    Array.from(providerRemovedTxHashMap.entries()).every(([txHash]) => {
      return gethTxRemovedHashMap.has(txHash);
    });

  saveMap(gethTxHashMap, "./gethTxHashMap.json");
  saveMap(gethTxRemovedHashMap, "./gethTxRemovedHashMap.json");
  saveMap(providerTxHashMap, "./providerTxHashMap.json");
  saveMap(providerRemovedTxHashMap, "./providerRemovedTxHashMap.json");

  let mismatchLength = 0;

  if (!equalSoFar) {
    if (gethTxHashMap.size > providerTxHashMap.size) {
      Array.from(gethTxHashMap.entries()).forEach(([txHash]) => {
        if (!providerTxHashMap.has(txHash)) {
          mismatchLength++;
        }
      });
    } else {
      Array.from(providerTxHashMap.entries()).forEach(([txHash]) => {
        if (!gethTxHashMap.has(txHash)) {
          mismatchLength++;
        }
      });
    }
  }

  console.log(
    timestamp,
    "equal?",
    equal,
    "equalSoFar?",
    equalSoFar,
    "geth",
    gethLogCount,
    "provider",
    providerLogCount,
    "mismatchLength",
    mismatchLength
  );

  await new Promise((resolve) => setTimeout(resolve, 10000));
}
