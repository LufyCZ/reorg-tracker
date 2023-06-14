import { ReorgFilterProvider } from "./ReorgFilterProvider.js";

const provider = new ReorgFilterProvider("http://localhost:8545", {
  address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
});

const filterId = provider.createFilter();

while (true) {
  const changes = provider.getFilterChanges(filterId);
  console.log(changes.length, changes[0]?.blockHash);
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
