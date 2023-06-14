import { mainnet } from "viem/chains";

export const chains = {
  ethereum: {
    chain: mainnet,
    httpTransport: "http://192.168.1.9:8545",
  },
} as const;
