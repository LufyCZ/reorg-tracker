import { Client } from "viem";

export async function mineBlocks(client: Client, blocks: number) {
  return client.request<any>({ method: "anvil_mine", params: [blocks] });
}

export async function getState(client: Client) {
  return client.request<any>({ method: "evm_snapshot" });
}

export async function setState(client: Client, id: string) {
  await client.request<any>({ method: "evm_revert", params: [id] });
  return getState(client);
}
