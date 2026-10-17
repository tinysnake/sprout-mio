import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

config({ path: [".env.local", ".env"] });

const databaseUrl = process.env.DATABASE_URL ?? "./data/sprout.sqlite";
if (databaseUrl !== ":memory:") {
  mkdirSync(dirname(databaseUrl), { recursive: true });
}

export default defineConfig({
  out: "./drizzle",
  schema: "./src/db/schema.ts",
  dialect: "sqlite",
  dbCredentials: { url: databaseUrl },
});
