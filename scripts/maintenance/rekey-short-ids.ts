import Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ID_PREFIXES } from "../../src/contracts/ids";

/**
 * 一次性重写 `<prefix>_<uuid>` 形状的 id 到 `newId` 生成的短格式。
 * 映射先落库到 id_map，再由 id_map 驱动数据库与文件系统两侧的替换，因此两次运行
 * （以及--apply 之后单独跑 --fs）用的一定是同一份映射。
 */
const REKEY_VERSION = "short-ids-v1";
const MAP_TABLE = "id_map";
const MARKER_TABLE = "__id_rekey_done";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ID_TOKEN = new RegExp(`([A-Za-z][A-Za-z0-9]*)_(${UUID})`, "g");
const NEW_ID_VALUE = /^([a-z][a-z0-9]*)_[0-9a-f]{8,16}$/;
const SHORT_LENGTHS = [8, 10, 12, 14, 16] as const;
const MAX_REWRITE_BYTES = 64 * 1024 * 1024;

/** 旧代码里没有登记在 ID_PREFIXES 的前缀，按同一份映射改到新前缀。 */
const PREFIX_ALIASES: Record<string, string> = {
  repoc: "rco",
  repop: "rpn",
  delivery: "dlv",
  evaluation: "evl",
};
const TARGET_PREFIXES = new Set<string>(Object.values(ID_PREFIXES));
const FAMILY_TARGETS = new Map<string, string>([
  ...[...TARGET_PREFIXES].map((prefix): [string, string] => [prefix, prefix]),
  ...Object.entries(PREFIX_ALIASES),
]);
/**
 * 散文列保留原样：id 出现在人类与模型写下的句子里，替换会改掉历史记录本身的内容，
 * 也不能保证句子仍然可读。代价是这些行继续引用旧 id，见报告。
 */
const PROSE_COLUMNS = new Set(["message.body", "turn_context.serialized_text"]);

export type ColumnCategory = "id" | "payload" | "prose" | "already-new" | "plain";

export type ColumnScan = {
  table: string;
  column: string;
  category: ColumnCategory;
  rows: number;
  /** 该列里出现的旧 id 处数；散文列记的是原样保留的处数。 */
  references: number;
  oldIds: string[];
};

export type UnknownPrefix = {
  prefix: string;
  count: number;
  tables: string[];
  samples: string[];
};

export type TableStat = {
  table: string;
  idRows: number;
  payloadRows: number;
  replacements: number;
};

export type FsPlan = {
  renames: { from: string; to: string }[];
  rewrites: { path: string; replacements: number }[];
  unknown: string[];
};

export type RekeyOptions = {
  dbPath: string;
  apply: boolean;
  fs: boolean;
  repoRoot?: string;
  piDataRoot?: string;
  log?: (line: string) => void;
};

export type RekeyResult = {
  status: "dry-run" | "applied" | "already-applied";
  columns: ColumnScan[];
  mapping: { oldId: string; newId: string }[];
  collisions: { oldId: string; newId: string }[];
  unknown: UnknownPrefix[];
  tables: TableStat[];
  proseReferences: number;
  remainingOldIds: number;
  foreignKeyViolations: number;
  fs?: FsPlan;
  elapsedMs: number;
};

type FoundId = { id: string; start: number; end: number };

type IdScan = { ids: FoundId[]; unknown: { name: string; id: string }[] };

function resolveFamily(name: string): { family: string; offset: number } | undefined {
  if (FAMILY_TARGETS.has(name)) return { family: name, offset: 0 };
  let best: { family: string; offset: number } | undefined;
  for (const family of FAMILY_TARGETS.keys()) {
    if (!name.endsWith(family)) continue;
    if (best && best.family.length >= family.length) continue;
    best = { family, offset: name.length - family.length };
  }
  return best;
}

/**
 * 载荷列里的 id 常常紧贴前一个词（`agentagp_...`、JSON 转义后的 `\ntsk_...`），
 * 所以按“最长已知前缀是词尾”来归族，未知词尾才报成未知前缀。
 */
function scanIds(text: string): IdScan {
  const ids: FoundId[] = [];
  const unknown: { name: string; id: string }[] = [];
  for (const match of text.matchAll(ID_TOKEN)) {
    const name = match[1];
    const resolved = resolveFamily(name);
    if (!resolved) {
      unknown.push({ name, id: match[0] });
      continue;
    }
    const start = (match.index ?? 0) + resolved.offset;
    ids.push({
      id: `${resolved.family}_${match[2]}`,
      start,
      end: start + resolved.family.length + 1 + match[2].length,
    });
  }
  return { ids, unknown };
}

function replaceIds(
  text: string,
  mapping: Map<string, string>,
): { text: string; replacements: number } {
  const found = scanIds(text).ids;
  if (found.length === 0) return { text, replacements: 0 };
  let next = "";
  let cursor = 0;
  let replacements = 0;
  for (const foundId of found) {
    const replacement = mapping.get(foundId.id);
    if (!replacement) continue;
    next += text.slice(cursor, foundId.start) + replacement;
    cursor = foundId.end;
    replacements += 1;
  }
  if (replacements === 0) return { text, replacements: 0 };
  return { text: next + text.slice(cursor), replacements };
}

function listTables(sqlite: Database.Database): string[] {
  const rows = sqlite
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%' AND name NOT IN (?, ?) ORDER BY name`,
    )
    .all(MAP_TABLE, MARKER_TABLE) as { name: string }[];
  return rows.map((row) => row.name);
}

function textColumns(sqlite: Database.Database, table: string): string[] {
  const rows = sqlite.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as {
    name: string;
    type: string;
  }[];
  return rows.filter((row) => /text/i.test(row.type)).map((row) => row.name);
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function collectUnknown(
  unknown: Map<string, UnknownPrefix>,
  found: { name: string; id: string }[],
  table: string,
): void {
  for (const { name, id } of found) {
    const entry = unknown.get(name) ?? { prefix: name, count: 0, tables: [], samples: [] };
    entry.count += 1;
    if (!entry.tables.includes(table)) entry.tables.push(table);
    if (entry.samples.length < 3 && !entry.samples.includes(id)) entry.samples.push(id);
    unknown.set(name, entry);
  }
}

function scanDatabase(sqlite: Database.Database): {
  columns: ColumnScan[];
  unknown: UnknownPrefix[];
  existingNewIds: Set<string>;
} {
  const columns: ColumnScan[] = [];
  const unknown = new Map<string, UnknownPrefix>();
  const existingNewIds = new Set<string>();

  for (const table of listTables(sqlite)) {
    for (const column of textColumns(sqlite, table)) {
      const rows = sqlite
        .prepare(
          `SELECT ${quote(column)} AS value FROM ${quote(table)} WHERE ${quote(column)} IS NOT NULL`,
        )
        .all() as { value: unknown }[];
      let idRows = 0;
      let embeddedRows = 0;
      let newRows = 0;
      let occurrences = 0;
      const oldIds = new Set<string>();

      for (const row of rows) {
        if (typeof row.value !== "string" || row.value === "") continue;
        const scan = scanIds(row.value);
        collectUnknown(unknown, scan.unknown, table);
        if (scan.ids.length === 0) {
          const newId = NEW_ID_VALUE.exec(row.value);
          const family = newId ? resolveFamily(newId[1]) : undefined;
          if (family && family.offset === 0 && TARGET_PREFIXES.has(family.family)) {
            newRows += 1;
            existingNewIds.add(row.value);
          }
          continue;
        }
        occurrences += scan.ids.length;
        for (const found of scan.ids) oldIds.add(found.id);
        if (
          scan.ids.length === 1 &&
          scan.ids[0].start === 0 &&
          scan.ids[0].end === row.value.length
        )
          idRows += 1;
        else embeddedRows += 1;
      }

      let category: ColumnCategory;
      if (embeddedRows > 0) category = "payload";
      else if (idRows > 0) category = "id";
      else if (newRows > 0) category = "already-new";
      else category = "plain";
      if (PROSE_COLUMNS.has(`${table}.${column}`) && oldIds.size > 0) category = "prose";

      const prose = category === "prose";
      columns.push({
        table,
        column,
        category,
        rows:
          category === "id" ? idRows : category === "payload" || prose ? idRows + embeddedRows : 0,
        references: occurrences,
        oldIds: prose ? [] : [...oldIds],
      });
    }
  }
  return {
    columns,
    unknown: [...unknown.values()].sort((a, b) => a.prefix.localeCompare(b.prefix)),
    existingNewIds,
  };
}

/**
 * 同一前缀内取 uuid 随机段前 8 位；撞车就延长到 10、12 位，直到 16 位用尽。
 * 输入按 id 排序，所以同一份数据每次得到的映射完全一致。
 */
export function buildMapping(
  oldIds: Iterable<string>,
  taken: Set<string>,
): { mapping: Map<string, string>; collisions: { oldId: string; newId: string }[] } {
  const mapping = new Map<string, string>();
  const collisions: { oldId: string; newId: string }[] = [];
  for (const oldId of [...oldIds].sort()) {
    const match = new RegExp(`^([a-z]+)_(${UUID})$`).exec(oldId);
    if (!match) throw new Error(`不是可迁移的旧 id：${oldId}`);
    const target = FAMILY_TARGETS.get(match[1]);
    if (!target) throw new Error(`未登记的前缀：${match[1]}`);
    const hex = match[2].replaceAll("-", "");
    let assigned: string | undefined;
    for (const length of SHORT_LENGTHS) {
      const candidate = `${target}_${hex.slice(0, length)}`;
      if (taken.has(candidate)) continue;
      assigned = candidate;
      break;
    }
    if (!assigned) throw new Error(`前缀 ${target} 的短 id 已用尽，无法为 ${oldId} 找到空位`);
    if (assigned.length > target.length + 1 + 8) collisions.push({ oldId, newId: assigned });
    taken.add(assigned);
    mapping.set(oldId, assigned);
  }
  return { mapping, collisions };
}

function proseReferencesOf(columns: ColumnScan[]): number {
  return columns
    .filter((column) => column.category === "prose")
    .reduce((total, column) => total + column.references, 0);
}

function tableStatsOf(columns: ColumnScan[]): TableStat[] {
  const stats = new Map<string, TableStat>();
  for (const column of columns) {
    const entry = stats.get(column.table) ?? {
      table: column.table,
      idRows: 0,
      payloadRows: 0,
      replacements: 0,
    };
    if (column.category === "id") {
      entry.idRows += column.rows;
      entry.replacements += column.references;
    }
    if (column.category === "payload") {
      entry.payloadRows += column.rows;
      entry.replacements += column.references;
    }
    stats.set(column.table, entry);
  }
  return [...stats.values()].sort((a, b) => a.table.localeCompare(b.table));
}

function remainingOldIds(
  columns: ColumnScan[],
  mapping: Map<string, string>,
): { table: string; column: string; oldId: string }[] {
  const remaining: { table: string; column: string; oldId: string }[] = [];
  for (const column of columns) {
    if (column.category === "prose") continue;
    for (const oldId of column.oldIds)
      if (mapping.has(oldId)) remaining.push({ table: column.table, column: column.column, oldId });
  }
  return remaining;
}

function ensureMapTable(sqlite: Database.Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS ${MAP_TABLE} (
    old_id TEXT PRIMARY KEY NOT NULL,
    new_id TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS ${MARKER_TABLE} (
    version TEXT PRIMARY KEY NOT NULL,
    completed_at INTEGER NOT NULL,
    mapped_ids INTEGER NOT NULL
  )`);
}

function readMarker(
  sqlite: Database.Database,
): { version: string; completed_at: number } | undefined {
  const table = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(MARKER_TABLE);
  if (!table) return undefined;
  return sqlite
    .prepare(`SELECT version, completed_at FROM ${MARKER_TABLE} WHERE version = ?`)
    .get(REKEY_VERSION) as { version: string; completed_at: number } | undefined;
}

/**
 * 身份不可变的触发器（chat / task / message / turn_context 等）会拒绝任何 id 改动，
 * AFTER 触发器还会顺手改别的表。DDL 在同一事务里，改写期间摘掉、写完按 sqlite_master
 * 里的原文装回去，回滚时 schema 也跟着回滚。
 */
function suspendTriggers(sqlite: Database.Database): { name: string; sql: string }[] {
  const triggers = sqlite
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL")
    .all() as { name: string; sql: string }[];
  for (const trigger of triggers) sqlite.exec(`DROP TRIGGER ${quote(trigger.name)}`);
  return triggers;
}

function restoreTriggers(
  sqlite: Database.Database,
  triggers: { name: string; sql: string }[],
): void {
  for (const trigger of triggers) sqlite.exec(trigger.sql);
}

function rewriteIdColumns(sqlite: Database.Database, columns: ColumnScan[]): number {
  let changes = 0;
  for (const column of columns) {
    if (column.category !== "id") continue;
    const result = sqlite
      .prepare(
        `UPDATE ${quote(column.table)} SET ${quote(column.column)} = (
           SELECT new_id FROM ${MAP_TABLE} WHERE old_id = ${quote(column.table)}.${quote(column.column)}
         ) WHERE ${quote(column.column)} IN (SELECT old_id FROM ${MAP_TABLE})`,
      )
      .run();
    if (result.changes !== column.rows)
      throw new Error(
        `${column.table}.${column.column} 预期改写 ${column.rows} 行，实际 ${result.changes} 行`,
      );
    changes += result.changes;
  }
  return changes;
}

function rewritePayloadColumns(
  sqlite: Database.Database,
  columns: ColumnScan[],
  mapping: Map<string, string>,
): number {
  let changes = 0;
  for (const column of columns) {
    if (column.category !== "payload") continue;
    const rows = sqlite
      .prepare(
        `SELECT rowid AS rowid, ${quote(column.column)} AS value FROM ${quote(column.table)}
          WHERE ${quote(column.column)} IS NOT NULL`,
      )
      .all() as { rowid: number; value: unknown }[];
    const update = sqlite.prepare(
      `UPDATE ${quote(column.table)} SET ${quote(column.column)} = ? WHERE rowid = ?`,
    );
    let rewrittenRows = 0;
    for (const row of rows) {
      if (typeof row.value !== "string") continue;
      const next = replaceIds(row.value, mapping);
      if (next.replacements === 0) continue;
      update.run(next.text, row.rowid);
      rewrittenRows += 1;
    }
    if (rewrittenRows !== column.rows)
      throw new Error(
        `${column.table}.${column.column} 预期改写 ${column.rows} 行，实际 ${rewrittenRows} 行`,
      );
    changes += rewrittenRows;
  }
  return changes;
}

function applyDatabase(
  sqlite: Database.Database,
  log: (line: string) => void,
): {
  columns: ColumnScan[];
  mapping: Map<string, string>;
  collisions: { oldId: string; newId: string }[];
  unknown: UnknownPrefix[];
  foreignKeyViolations: number;
} {
  ensureMapTable(sqlite);
  const triggers = suspendTriggers(sqlite);
  const scan = scanDatabase(sqlite);
  const pending = new Set<string>();
  for (const column of scan.columns)
    if (column.category === "id" || column.category === "payload")
      for (const oldId of column.oldIds) pending.add(oldId);

  const { mapping, collisions } = buildMapping(pending, scan.existingNewIds);
  const insert = sqlite.prepare(
    `INSERT INTO ${MAP_TABLE} (old_id, new_id, prefix, created_at) VALUES (?, ?, ?, unixepoch())`,
  );
  for (const [oldId, newId] of mapping)
    insert.run(oldId, newId, newId.slice(0, newId.lastIndexOf("_")));

  const idChanges = rewriteIdColumns(sqlite, scan.columns);
  const payloadChanges = rewritePayloadColumns(sqlite, scan.columns, mapping);
  log(
    `数据库改写：精确 id 列 ${idChanges} 行，载荷列 ${payloadChanges} 行，映射 ${mapping.size} 条`,
  );

  const violations = sqlite.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    for (const violation of violations.slice(0, 10)) log(`外键违规：${JSON.stringify(violation)}`);
    throw new Error(`外键校验失败（${violations.length} 条），已回滚`);
  }

  const remaining = remainingOldIds(scanDatabase(sqlite).columns, mapping);
  if (remaining.length > 0)
    throw new Error(
      `改写后仍有 ${remaining.length} 处已映射的旧 id，已回滚：` +
        remaining
          .slice(0, 5)
          .map((entry) => `${entry.table}.${entry.column}=${entry.oldId}`)
          .join("，"),
    );
  restoreTriggers(sqlite, triggers);

  sqlite
    .prepare(
      `INSERT INTO ${MARKER_TABLE} (version, completed_at, mapped_ids) VALUES (?, unixepoch(), ?)`,
    )
    .run(REKEY_VERSION, mapping.size);

  return {
    columns: scan.columns,
    mapping,
    collisions,
    unknown: scan.unknown,
    foreignKeyViolations: 0,
  };
}

function readMapping(sqlite: Database.Database): Map<string, string> {
  const table = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(MAP_TABLE);
  if (!table) throw new Error(`没有 ${MAP_TABLE} 表：先跑一次 --apply 生成映射`);
  const rows = sqlite.prepare(`SELECT old_id, new_id FROM ${MAP_TABLE}`).all() as {
    old_id: string;
    new_id: string;
  }[];
  return new Map(rows.map((row) => [row.old_id, row.new_id]));
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files.sort();
}

/** 计划阶段只读，干跑与 --apply 走同一份计划。 */
function planFilesystem(
  mapping: Map<string, string>,
  repoRoot: string | undefined,
  piDataRoot: string | undefined,
): FsPlan {
  const plan: FsPlan = { renames: [], rewrites: [], unknown: [] };
  const noteUnknown = (name: string) => {
    if (!plan.unknown.includes(name)) plan.unknown.push(name);
  };

  const planEntry = (path: string): void => {
    const name = basename(path);
    for (const found of scanIds(name).unknown) noteUnknown(found.name);
    const next = replaceIds(name, mapping);
    if (next.replacements > 0)
      plan.renames.push({ from: path, to: join(dirname(path), next.text) });
  };

  if (repoRoot) {
    if (!existsSync(repoRoot)) throw new Error(`仓库根目录不存在：${repoRoot}`);
    for (const entry of readdirSync(repoRoot, { withFileTypes: true }))
      if (entry.isDirectory()) planEntry(join(repoRoot, entry.name));
  }

  if (piDataRoot) {
    if (!existsSync(piDataRoot)) throw new Error(`pi 数据根目录不存在：${piDataRoot}`);
    for (const entry of readdirSync(piDataRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const instanceDirectory = join(piDataRoot, entry.name);
      const sessions = join(instanceDirectory, "sessions");
      if (existsSync(sessions)) {
        for (const file of listFiles(sessions)) {
          const size = statSync(file).size;
          if (size > MAX_REWRITE_BYTES) {
            noteUnknown(`${file}（${size} 字节，超过改写上限）`);
            continue;
          }
          const content = readFileSync(file, "utf8");
          const rewritten = replaceIds(content, mapping);
          for (const found of scanIds(content).unknown) noteUnknown(found.name);
          if (rewritten.replacements > 0)
            plan.rewrites.push({ path: file, replacements: rewritten.replacements });
          planEntry(file);
        }
      }
      planEntry(instanceDirectory);
    }
  }
  return plan;
}

function applyFilesystem(
  plan: FsPlan,
  mapping: Map<string, string>,
  log: (line: string) => void,
): void {
  for (const rewrite of plan.rewrites) {
    const content = readFileSync(rewrite.path, "utf8");
    const next = replaceIds(content, mapping);
    if (next.replacements === 0) continue;
    writeFileSync(rewrite.path, next.text);
  }
  // 先深后浅：文件先改名，再改它们所在的目录，路径才不会中途失效。
  for (const rename of [...plan.renames].sort((a, b) => b.from.length - a.from.length)) {
    if (!existsSync(rename.from)) {
      log(`跳过已不存在的路径：${rename.from}`);
      continue;
    }
    renameSync(rename.from, rename.to);
  }
}

export function rekeyShortIds(options: RekeyOptions): RekeyResult {
  const started = Date.now();
  const log = options.log ?? (() => {});
  const sqlite = new Database(options.dbPath, { readonly: !options.apply, fileMustExist: true });
  try {
    const marker = readMarker(sqlite);
    if (marker) {
      const mapping = readMapping(sqlite);
      const rescan = scanDatabase(sqlite).columns;
      const remaining = remainingOldIds(rescan, mapping).length;
      log(
        `已应用 ${REKEY_VERSION}（${new Date(marker.completed_at * 1000).toISOString()}），不再写入`,
      );
      if (remaining > 0) log(`警告：已应用但仍有 ${remaining} 处旧 id 引用`);
      const fs = options.fs
        ? planFilesystem(mapping, options.repoRoot, options.piDataRoot)
        : undefined;
      // 数据库已提交但文件系统阶段可能中断，所以已应用也要能单独重跑 --fs。
      if (fs && options.apply) applyFilesystem(fs, mapping, log);
      return {
        status: "already-applied",
        columns: [],
        mapping: [...mapping].map(([oldId, newId]) => ({ oldId, newId })),
        collisions: [],
        unknown: [],
        tables: [],
        proseReferences: proseReferencesOf(rescan),
        remainingOldIds: remaining,
        foreignKeyViolations: 0,
        fs,
        elapsedMs: Date.now() - started,
      };
    }

    if (!options.apply) {
      const scan = scanDatabase(sqlite);
      const pending = new Set<string>();
      for (const column of scan.columns)
        if (column.category === "id" || column.category === "payload")
          for (const oldId of column.oldIds) pending.add(oldId);
      const { mapping, collisions } = buildMapping(pending, scan.existingNewIds);
      const fs = options.fs
        ? planFilesystem(mapping, options.repoRoot, options.piDataRoot)
        : undefined;
      return {
        status: "dry-run",
        columns: scan.columns,
        mapping: [...mapping].map(([oldId, newId]) => ({ oldId, newId })),
        collisions,
        unknown: scan.unknown,
        tables: tableStatsOf(scan.columns),
        proseReferences: proseReferencesOf(scan.columns),
        remainingOldIds: pending.size,
        foreignKeyViolations: (sqlite.pragma("foreign_key_check") as unknown[]).length,
        fs,
        elapsedMs: Date.now() - started,
      };
    }

    // PRAGMA foreign_keys 在事务里无效，必须在 BEGIN 之前落到连接上。
    sqlite.pragma("foreign_keys = OFF");
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const applied = applyDatabase(sqlite, log);
      sqlite.exec("COMMIT");
      const fs = options.fs
        ? planFilesystem(applied.mapping, options.repoRoot, options.piDataRoot)
        : undefined;
      if (fs) applyFilesystem(fs, applied.mapping, log);
      return {
        status: "applied",
        columns: applied.columns,
        mapping: [...applied.mapping].map(([oldId, newId]) => ({ oldId, newId })),
        collisions: applied.collisions,
        unknown: applied.unknown,
        tables: tableStatsOf(applied.columns),
        proseReferences: proseReferencesOf(applied.columns),
        remainingOldIds: 0,
        foreignKeyViolations: applied.foreignKeyViolations,
        fs,
        elapsedMs: Date.now() - started,
      };
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    } finally {
      sqlite.pragma("foreign_keys = ON");
    }
  } finally {
    sqlite.close();
  }
}

function render(result: RekeyResult): string[] {
  const lines: string[] = [];
  lines.push(`状态：${result.status}（${result.elapsedMs} ms）`);
  if (result.columns.length > 0) {
    lines.push("== 列清单（表.列 [类别] 行数/替换数）==");
    for (const column of result.columns) {
      if (column.category === "plain" || column.category === "already-new") continue;
      lines.push(
        `  ${column.category.padEnd(8)} ${`${column.table}.${column.column}`.padEnd(44)} ` +
          `${column.rows} 行 / ${column.references} 处`,
      );
    }
    lines.push("== 各表改写 ==");
    for (const table of result.tables)
      if (table.idRows + table.payloadRows > 0)
        lines.push(
          `  ${table.table.padEnd(34)} id ${String(table.idRows).padStart(4)} 行  ` +
            `payload ${String(table.payloadRows).padStart(3)} 行  替换 ${table.replacements}`,
        );
  }
  if (result.mapping.length > 0) lines.push(`映射：${result.mapping.length} 条`);
  lines.push(`散文列保留的旧 id 引用：${result.proseReferences} 处（不改写）`);
  for (const collision of result.collisions)
    lines.push(`撞车延长：${collision.oldId} → ${collision.newId}`);
  for (const entry of result.unknown)
    lines.push(
      `未知前缀：${entry.prefix}_（${entry.count} 处，表 ${entry.tables.join(",")}，样例 ${entry.samples.join(",")}）`,
    );
  if (result.fs) {
    lines.push(
      `文件系统：重命名 ${result.fs.renames.length} 项，内容改写 ${result.fs.rewrites.length} 个文件`,
    );
    for (const rename of result.fs.renames) lines.push(`  rename ${rename.from} → ${rename.to}`);
    for (const rewrite of result.fs.rewrites)
      lines.push(`  rewrite ${rewrite.path}（${rewrite.replacements} 处）`);
    for (const unknown of result.fs.unknown) lines.push(`  未知前缀（路径）：${unknown}`);
  }
  return lines;
}

function parseArgs(argv: string[]): RekeyOptions {
  const options: RekeyOptions = {
    dbPath: process.env.DATABASE_URL ?? "./data/sprout.sqlite",
    apply: false,
    fs: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--fs") options.fs = true;
    else if (argument === "--db") options.dbPath = argv[++index] ?? "";
    else if (argument === "--repo-root") options.repoRoot = argv[++index] ?? "";
    else if (argument === "--pi-data-root") options.piDataRoot = argv[++index] ?? "";
    else if (argument === "--help" || argument === "-h") {
      console.log(
        "用法：node --import tsx scripts/maintenance/rekey-short-ids.ts " +
          "[--db <path>] [--repo-root <path>] [--pi-data-root <path>] [--apply] [--fs]",
      );
      process.exit(0);
    } else throw new Error(`未知参数：${argument}`);
  }
  if (options.repoRoot === undefined) options.repoRoot = process.env.SPROUT_REPO_DIR;
  if (options.piDataRoot === undefined) options.piDataRoot = process.env.SPROUT_PI_DATA_DIR;
  if (options.fs && !options.repoRoot && !options.piDataRoot)
    throw new Error("--fs 需要 --repo-root 或 --pi-data-root（或对应的 SPROUT_* 环境变量）");
  return options;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  options.log = (line) => console.log(line);
  if (options.fs)
    console.log(
      `文件系统根：repos=${options.repoRoot ?? "未设置"} pi=${options.piDataRoot ?? "未设置"}`,
    );
  const result = rekeyShortIds(options);
  for (const line of render(result)) console.log(line);
  if (!options.apply)
    console.log("（干跑：没有写入任何改动；加 --apply 才落库，加 --fs 处理文件系统）");
}

// 部署目录可能是符号链接，realpath 之后再比，否则入口判断为假、脚本静默什么都不做却返回 0。
const entryPath = process.argv[1];
if (
  entryPath &&
  existsSync(entryPath) &&
  realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    console.error("id 重写失败", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
