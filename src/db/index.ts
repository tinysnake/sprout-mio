import { resolve } from "node:path";
import { config } from "../lib/config";
import { openDatabase } from "./connection";
import type { DatabaseConnection } from "./connection";

const processCache = globalThis as typeof globalThis & {
  sproutDatabases?: Map<string, DatabaseConnection>;
};
const connections = (processCache.sproutDatabases ??= new Map());
const key = config.DATABASE_URL === ":memory:" ? ":memory:" : resolve(config.DATABASE_URL);
const connection = connections.get(key) ?? openDatabase(config.DATABASE_URL);
connections.set(key, connection);

export const db = connection.db;
export const sqlite = connection.sqlite;
export { openDatabase } from "./connection";
export type { DatabaseConnection } from "./connection";
