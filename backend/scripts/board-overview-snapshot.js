#!/usr/bin/env node
/**
 * Board overview snapshot — local development tool only.
 *
 * Aggregates the data shown on the "My Boards" overview page in one run:
 * board counts, per-board column/card counts and empty states, then writes a
 * deterministic JSON snapshot that can be diffed or checked against a previous
 * run. Re-running this command overwrites the old snapshot.
 *
 * The database is opened read-only and no boards, columns or cards are ever
 * modified; creating / deleting / opening boards keeps working unchanged.
 *
 * Usage:
 *   node scripts/board-overview-snapshot.js [--check] [--db <path>] [--out <path>]
 *
 *   (no flags)   Aggregate and overwrite the snapshot file.
 *   --check      Compare current data with the saved snapshot without writing.
 *   --db <path>  SQLite database file (default: backend/data/taskboard.db).
 *   --out <path> Snapshot output file (default: backend/snapshots/board-overview.json).
 *
 * Exit codes:
 *   0  snapshot written, or --check found no differences
 *   1  stopped at a defined stage (missing dependency / unreadable db / unwritable storage)
 *   2  --check found differences, or no baseline snapshot exists yet
 */

'use strict';

const fs = require('fs');
const path = require('path');

const STAGES = {
  DEPS: '1/4 dependencies',
  DB: '2/4 database',
  AGGREGATE: '3/4 aggregation',
  SNAPSHOT: '4/4 snapshot',
};

const SNAPSHOT_VERSION = 1;
const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'taskboard.db');
const DEFAULT_OUT_PATH = path.join(__dirname, '..', 'snapshots', 'board-overview.json');
const REQUIRED_TABLES = ['users', 'boards', 'columns', 'cards'];
const TOTAL_KEYS = [
  'users', 'boards', 'columns', 'cards',
  'empty_overviews', 'boards_without_columns', 'boards_without_cards',
];

function printHelp() {
  console.log(
    'Usage: node scripts/board-overview-snapshot.js [--check] [--db <path>] [--out <path>]\n' +
    '\n' +
    '  (no flags)   Aggregate board overview data and overwrite the snapshot file\n' +
    '  --check      Compare current data with the saved snapshot without writing\n' +
    '  --db <path>  SQLite database file (default: backend/data/taskboard.db)\n' +
    '  --out <path> Snapshot file (default: backend/snapshots/board-overview.json)'
  );
}

function parseArgs(argv) {
  const opts = { check: false, dbPath: DEFAULT_DB_PATH, outPath: DEFAULT_OUT_PATH };

  const readValue = (flag, value) => {
    if (value === undefined || value.startsWith('--')) {
      console.error(`Missing value for ${flag}`);
      printHelp();
      process.exit(1);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') {
      opts.check = true;
    } else if (arg === '--db') {
      opts.dbPath = path.resolve(readValue(arg, argv[++i]));
    } else if (arg === '--out') {
      opts.outPath = path.resolve(readValue(arg, argv[++i]));
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }
  return opts;
}

function stop(stage, message, hint) {
  console.error(`\n[stage ${stage}] stopped: ${message}`);
  if (hint) console.error(`  hint: ${hint}`);
  process.exit(1);
}

// --- Stage 1: dependencies -------------------------------------------------

function loadDatabaseDriver() {
  console.log('[1/4] Checking dependencies...');
  try {
    return require('better-sqlite3');
  } catch (err) {
    stop(
      STAGES.DEPS,
      `required dependency "better-sqlite3" is not available (${err.message})`,
      "install backend dependencies first: cd backend && npm install"
    );
  }
}

// --- Stage 2: open the database read-only ----------------------------------

function openDatabase(Database, dbPath) {
  console.log(`[2/4] Opening database (read-only): ${dbPath}`);

  if (!fs.existsSync(dbPath)) {
    stop(
      STAGES.DB,
      `database file not found: ${dbPath}`,
      "run 'npm run seed' (or start the API once) to create it"
    );
  }

  let db;
  try {
    // Read-only: opening the snapshot never creates or modifies the database.
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    stop(STAGES.DB, `cannot open database read-only: ${err.message}`);
  }

  try {
    // Belt-and-braces: reject any write statement on this connection.
    db.pragma('query_only = ON');
  } catch (err) {
    db.close();
    stop(STAGES.DB, `cannot secure read-only connection: ${err.message}`);
  }

  return db;
}

// --- Stage 3: aggregate the board overview ---------------------------------

function aggregate(db) {
  console.log('[3/4] Aggregating board counts, card counts, column counts and empty states...');

  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    const missing = REQUIRED_TABLES.filter((table) => !tables.includes(table));
    if (missing.length > 0) {
      stop(
        STAGES.AGGREGATE,
        `database is missing required tables: ${missing.join(', ')}`,
        "initialize the schema with 'npm run seed' (or start the API once)"
      );
    }

    // A single read-only transaction gives a consistent point-in-time snapshot.
    const data = db.transaction(() => {
      const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

      const totals = {
        users: count('users'),
        boards: count('boards'),
        columns: count('columns'),
        cards: count('cards'),
      };

      // Per-user rollups. The overview is per user, so the empty overview state
      // (the "No boards yet" screen) means a user with zero boards.
      const userRows = db.prepare(`
        SELECT u.id, u.username,
          (SELECT COUNT(*) FROM boards b WHERE b.user_id = u.id) AS board_count,
          (SELECT COUNT(*) FROM columns c
             JOIN boards b ON c.board_id = b.id
            WHERE b.user_id = u.id) AS column_count,
          (SELECT COUNT(*) FROM cards k
             JOIN columns c ON k.column_id = c.id
             JOIN boards b ON c.board_id = b.id
            WHERE b.user_id = u.id) AS card_count
          FROM users u
         ORDER BY u.id
      `).all().map((u) => ({
        id: u.id,
        username: u.username,
        board_count: u.board_count,
        column_count: u.column_count,
        card_count: u.card_count,
        empty_overview: u.board_count === 0,
      }));

      // Per-board detail — matches the column/card tags shown on BoardCard.
      const boards = db.prepare(`
        SELECT b.id, b.user_id, b.name, b.created_at,
          (SELECT COUNT(*) FROM columns c WHERE c.board_id = b.id) AS column_count,
          (SELECT COUNT(*) FROM cards k
             JOIN columns c ON k.column_id = c.id
            WHERE c.board_id = b.id) AS card_count
          FROM boards b
         ORDER BY b.id
      `).all().map((b) => ({
        id: b.id,
        user_id: b.user_id,
        name: b.name,
        created_at: b.created_at,
        column_count: b.column_count,
        card_count: b.card_count,
        has_columns: b.column_count > 0,
        has_cards: b.card_count > 0,
      }));

      totals.empty_overviews = userRows.filter((u) => u.empty_overview).length;
      totals.boards_without_columns = boards.filter((b) => !b.has_columns).length;
      totals.boards_without_cards = boards.filter((b) => !b.has_cards).length;

      return { version: SNAPSHOT_VERSION, totals, users: userRows, boards };
    })();

    return data;
  } catch (err) {
    stop(STAGES.AGGREGATE, `failed to read board overview data: ${err.message}`);
  }
}

// --- Comparison -------------------------------------------------------------

function formatDelta(value, previous) {
  if (value === previous) return String(value);
  const delta = value - previous;
  const sign = delta > 0 ? `+${delta}` : `${delta}`;
  return `${previous} -> ${value} (${sign})`;
}

function compareSnapshots(previous, current) {
  const lines = [];

  if (!previous || typeof previous !== 'object' || previous.version !== current.version) {
    lines.push(`snapshot format version differs (saved v${previous && previous.version}, current v${current.version}); run without --check to refresh the baseline`);
    return lines;
  }

  const prevTotals = previous.totals || {};
  for (const key of TOTAL_KEYS) {
    if (prevTotals[key] !== current.totals[key]) {
      lines.push(`totals.${key}: ${formatDelta(current.totals[key], prevTotals[key] || 0)}`);
    }
  }

  const prevUsers = new Map((previous.users || []).map((u) => [u.id, u]));
  const currentUsers = new Map(current.users.map((u) => [u.id, u]));

  for (const [id, user] of currentUsers) {
    const before = prevUsers.get(id);
    if (!before) {
      lines.push(`user #${id} "${user.username}" added (boards: ${user.board_count})`);
      continue;
    }
    for (const key of ['username', 'board_count', 'column_count', 'card_count', 'empty_overview']) {
      if (before[key] !== user[key]) {
        lines.push(`user #${id} "${user.username}": ${key} ${before[key]} -> ${user[key]}`);
      }
    }
  }
  for (const [id, user] of prevUsers) {
    if (!currentUsers.has(id)) lines.push(`user #${id} "${user.username}" removed`);
  }

  const prevBoards = new Map((previous.boards || []).map((b) => [b.id, b]));
  const currentBoards = new Map(current.boards.map((b) => [b.id, b]));

  const emptyTransitions = (key, label) => {
    const becameEmpty = [];
    const becameNonEmpty = [];
    for (const [id, board] of currentBoards) {
      const before = prevBoards.get(id);
      if (!before || before[key] === board[key]) continue;
      (board[key] ? becameNonEmpty : becameEmpty).push(id);
    }
    if (becameEmpty.length) lines.push(`${label}: boards now empty -> #${becameEmpty.join(', #')}`);
    if (becameNonEmpty.length) lines.push(`${label}: boards no longer empty -> #${becameNonEmpty.join(', #')}`);
  };

  for (const [id, board] of currentBoards) {
    const before = prevBoards.get(id);
    if (!before) {
      lines.push(`board #${id} "${board.name}" added (columns: ${board.column_count}, cards: ${board.card_count})`);
      continue;
    }
    for (const key of ['name', 'user_id', 'column_count', 'card_count']) {
      if (before[key] !== board[key]) {
        lines.push(`board #${id} "${board.name}": ${key} ${before[key]} -> ${board[key]}`);
      }
    }
  }
  for (const [id, board] of prevBoards) {
    if (!currentBoards.has(id)) {
      lines.push(`board #${id} "${board.name}" removed (was columns: ${board.column_count}, cards: ${board.card_count})`);
    }
  }

  emptyTransitions('has_columns', 'empty columns');
  emptyTransitions('has_cards', 'empty cards');

  return lines;
}

// --- Stage 4: snapshot storage ---------------------------------------------

function ensureStorageWritable(outPath) {
  const dir = path.dirname(outPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    stop(STAGES.SNAPSHOT, `cannot create snapshot directory ${dir}: ${err.message}`);
  }

  const probe = path.join(dir, `.write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (err) {
    stop(
      STAGES.SNAPSHOT,
      `snapshot storage is not writable: ${dir} (${err.code || err.message})`,
      `choose a writable location, e.g. npm run snapshot -- --out /tmp/${path.basename(outPath)}`
    );
  }
}

function readBaseline(outPath) {
  try {
    return JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function writeSnapshot(outPath, snapshot) {
  const tmpPath = `${outPath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2) + '\n');
    fs.renameSync(tmpPath, outPath); // atomic overwrite of the previous snapshot
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    stop(STAGES.SNAPSHOT, `failed to write snapshot ${outPath}: ${err.message}`);
  }
}

function printTotals(snapshot) {
  const t = snapshot.totals;
  console.log(
    `  totals: ${t.boards} boards, ${t.columns} columns, ${t.cards} cards, ` +
    `${t.users} users (${t.empty_overviews} empty overview, ` +
    `${t.boards_without_columns} boards without columns, ${t.boards_without_cards} boards without cards)`
  );
}

// --- Main -------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const Database = loadDatabaseDriver();
  const db = openDatabase(Database, opts.dbPath);
  const snapshot = aggregate(db);
  db.close();

  if (opts.check) {
    console.log('[4/4] Comparing against saved snapshot (no files are written)...');
    if (!fs.existsSync(opts.outPath)) {
      console.error(`\n[stage ${STAGES.SNAPSHOT}] stopped: no baseline snapshot found at ${opts.outPath}`);
      console.error('  hint: run "npm run snapshot" once to create the baseline first');
      process.exit(2);
    }

    let previous;
    try {
      previous = JSON.parse(fs.readFileSync(opts.outPath, 'utf8'));
    } catch (err) {
      stop(STAGES.SNAPSHOT, `saved snapshot is not valid JSON (${opts.outPath}): ${err.message}`,
        'rerun "npm run snapshot" to recreate the baseline');
    }

    printTotals(snapshot);
    const differences = compareSnapshots(previous, snapshot);
    if (differences.length === 0) {
      console.log(`\nSnapshot matches: ${opts.outPath}`);
      process.exit(0);
    }

    console.log(`\nDifferences from ${opts.outPath}:`);
    for (const line of differences) console.log(`  - ${line}`);
    process.exit(2);
  }

  console.log('[4/4] Writing snapshot (repeated runs overwrite the previous snapshot)...');
  ensureStorageWritable(opts.outPath);

  const previous = fs.existsSync(opts.outPath) ? readBaseline(opts.outPath) : null;
  if (fs.existsSync(opts.outPath) && previous === null) {
    console.log(`  warning: existing snapshot was not valid JSON and will be replaced: ${opts.outPath}`);
  }

  writeSnapshot(opts.outPath, snapshot);

  printTotals(snapshot);
  if (previous) {
    const differences = compareSnapshots(previous, snapshot);
    if (differences.length === 0) {
      console.log('  changes since previous snapshot: none');
    } else {
      console.log('  changes since previous snapshot:');
      for (const line of differences) console.log(`    - ${line}`);
    }
  } else {
    console.log('  baseline snapshot created (no previous snapshot to compare)');
  }

  console.log(`\nSnapshot written: ${opts.outPath}`);
  console.log('The snapshot contains no timestamp on purpose, so repeated runs produce diffable output.');
  process.exit(0);
}

main();
