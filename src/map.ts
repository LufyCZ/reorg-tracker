import { writeFileSync, mkdirSync, statSync, readFileSync } from "fs";

export function saveMap<T, P>(map: Map<T, P>, path: string) {
  if (!path.endsWith(".json")) path = path.concat(".json");

  const dirPath = path.split("/").slice(0, -1).join("/");

  if (!statSync(dirPath, { throwIfNoEntry: false })) {
    mkdirSync(dirPath, { recursive: true });
  }

  writeFileSync(
    path,
    JSON.stringify(
      Array.from(map.entries()),
      (key, value) => (typeof value === "bigint" ? value.toString() : value),
      2
    )
  );
}

export function loadMap<T, P>(path: string): Map<T, P> {
  if (!statSync(path)) {
    throw new Error("File does not exist");
  }

  return new Map(JSON.parse(readFileSync(path, "utf-8")));
}
