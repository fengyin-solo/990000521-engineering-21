#!/usr/bin/env node
/**
 * Local-dev snapshot of the board overview ("My Boards" page data).
 *
 * One run summarizes board count, every board's columns and cards, column
 * counts, and empty states, then writes a deterministic JSON snapshot that
 * can be diffed across runs (e.g. `git diff backend/data/overview-snapshot.json`).
 * Re-running overwrites the previous snapshot.
 *
 * The script is strictly read-only: it opens the database with
 * { readonly: true, fileMustExist: true } and only runs SELECT queries.
 * It never creates, updates, or deletes boards, columns, or cards.
 *
 * Stages (the script stops at the first failing stage with a clear message):
 *   1. deps    - better-sqlite3 loadable and database opened read-only (exit 2)
 *   2. collect - read-only queries against the database              (exit 3)
 *   3. write   - snapshot directory writable, snapshot file written  (exit 4)
 *
 * Env overrides (local dev only):
 *   TASKBOARD_DB_PATH  - database file to read (default: backend/data/taskboard.db)
 *   SNAPSHOT_OUTPUT    - snapshot file to write (default: backend/data/overview-snapshot.json)
 */
const fs = require('fs');
const path = require('path');

const EXIT_CODES = { deps: 2, collect: 3, write: 4 };

function log(stage, message) {
  console.log(`[snapshot] stage "${stage}": ${message}`);
}

function fail(stage, message, hint) {
  console.error(`[snapshot] stage "${stage}" FAILED: ${message}`);
  if (hint) console.error(`[snapshot] hint: ${hint}`);
  process.exit(EXIT_CODES[stage]);
}

// --- Stage 1: deps -----------------------------------------------------------
let Database;
try {
  Database = require('better-sqlite3');
} catch (err) {
  fail('deps', `cannot load better-sqlite3 (${err.message})`, 'run `npm install` in backend/');
}

// init.js requires better-sqlite3 at its top level, so load it only after the
// driver check above - otherwise a missing driver would crash with a stack
// trace instead of stopping at the deps stage.
const { DATA_DIR, DB_PATH } = require('./init');

const dbPath = process.env.TASKBOARD_DB_PATH || DB_PATH;
const outputPath = process.env.SNAPSHOT_OUTPUT || path.join(DATA_DIR, 'overview-snapshot.json');

if (!fs.existsSync(dbPath)) {
  fail('deps', `database file not found: ${dbPath}`, 'run `npm run seed` or start the server once to create it');
}

let db;
try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
} catch (err) {
  fail('deps', `cannot open database read-only: ${err.message}`,
    'the better-sqlite3 native binding may not match this platform - try `npm rebuild better-sqlite3`');
}
log('deps', `ok - better-sqlite3 loaded, database opened read-only: ${dbPath}`);

// --- Stage 2: collect --------------------------------------------------------
function collect(db) {
  const users = db.prepare('SELECT id, username FROM users ORDER BY id').all();
  const userNames = new Map(users.map(u => [u.id, u.username]));

  const boards = db.prepare('SELECT * FROM boards ORDER BY id').all();
  const columns = db.prepare('SELECT * FROM columns ORDER BY board_id, position, id').all();
  const cards = db.prepare(`
    SELECT c.* FROM cards c
    JOIN columns col ON c.column_id = col.id
    ORDER BY col.board_id, c.column_id, c.position, c.id
  `).all();

  const columnsByBoard = new Map();
  for (const col of columns) {
    if (!columnsByBoard.has(col.board_id)) columnsByBoard.set(col.board_id, []);
    columnsByBoard.get(col.board_id).push(col);
  }
  const cardsByColumn = new Map();
  for (const card of cards) {
    if (!cardsByColumn.has(card.column_id)) cardsByColumn.set(card.column_id, []);
    cardsByColumn.get(card.column_id).push(card);
  }

  const boardEntries = boards.map(b => {
    const cols = (columnsByBoard.get(b.id) || []).map(col => {
      const colCards = (cardsByColumn.get(col.id) || []).map(c => ({
        id: c.id,
        title: c.title,
        priority: c.priority,
        due_date: c.due_date,
        position: c.position
      }));
      return { id: col.id, name: col.name, position: col.position, card_count: colCards.length, cards: colCards };
    });
    return {
      id: b.id,
      name: b.name,
      owner: userNames.get(b.user_id) || `user#${b.user_id}`,
      description: b.description || '',
      created_at: b.created_at,
      column_count: cols.length,
      card_count: cols.reduce((n, c) => n + c.card_count, 0),
      columns: cols
    };
  });

  const emptyState = {
    no_boards: boardEntries.length === 0,
    boards_without_columns: boardEntries.filter(b => b.column_count === 0).map(b => ({ id: b.id, name: b.name })),
    boards_without_cards: boardEntries.filter(b => b.card_count === 0).map(b => ({ id: b.id, name: b.name })),
    columns_without_cards: boardEntries.flatMap(b =>
      b.columns.filter(c => c.card_count === 0).map(c => ({ id: c.id, name: c.name, board: b.name }))
    )
  };

  const totals = {
    users: users.length,
    boards: boardEntries.length,
    columns: boardEntries.reduce((n, b) => n + b.column_count, 0),
    cards: boardEntries.reduce((n, b) => n + b.card_count, 0)
  };

  // Deterministic output: fixed key order, rows sorted by id/position, no
  // run timestamps - so two runs over the same data produce identical files.
  return {
    schema_version: 1,
    generated_by: 'npm run snapshot (backend/db/snapshot.js)',
    totals,
    empty_state: emptyState,
    boards: boardEntries
  };
}

let snapshot;
try {
  snapshot = collect(db);
} catch (err) {
  fail('collect', `query failed: ${err.message}`);
} finally {
  try { db.close(); } catch (err) { /* already closed */ }
}

const es = snapshot.empty_state;
const emptyCount = es.boards_without_columns.length + es.boards_without_cards.length + es.columns_without_cards.length;
log('collect', `ok - ${snapshot.totals.boards} boards, ${snapshot.totals.columns} columns, ${snapshot.totals.cards} cards`);
if (es.no_boards) {
  log('collect', 'empty state: no boards yet (overview shows the empty state)');
} else if (emptyCount > 0) {
  log('collect', `empty states: ${es.boards_without_columns.length} boards without columns, ` +
    `${es.boards_without_cards.length} boards without cards, ${es.columns_without_cards.length} columns without cards`);
}

// --- Stage 3: write ----------------------------------------------------------
// Create a directory and its missing parents without fs.mkdirSync's recursive
// option, which can spin forever on pseudo-filesystems such as /proc.
function ensureDir(dir) {
  if (fs.existsSync(dir)) return;
  const parent = path.dirname(dir);
  if (parent !== dir) ensureDir(parent);
  try {
    fs.mkdirSync(dir);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

const hadPrevious = fs.existsSync(outputPath);
const outputDir = path.dirname(outputPath);
try {
  ensureDir(outputDir);
  fs.accessSync(outputDir, fs.constants.W_OK);
} catch (err) {
  fail('write', `snapshot directory ${outputDir} is not writable: ${err.message}`, 'choose a writable location or fix directory permissions');
}

const tmpPath = `${outputPath}.tmp`;
try {
  fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, outputPath); // atomically overwrites the previous snapshot
} catch (err) {
  try { fs.unlinkSync(tmpPath); } catch (cleanupErr) { /* nothing to clean up */ }
  fail('write', `cannot write snapshot to ${outputPath}: ${err.message}`, 'check that the location is writable');
}

log('write', `ok - snapshot written to ${outputPath}${hadPrevious ? ' (previous snapshot overwritten)' : ''}`);
console.log('[snapshot] done - diff the snapshot file (e.g. `git diff`) to compare runs');
