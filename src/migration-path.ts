import { fileURLToPath } from "node:url";

export function packageMigrationsDirectory(): string {
  return fileURLToPath(new URL("../../migrations/", import.meta.url));
}
