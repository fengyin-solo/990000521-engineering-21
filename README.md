# Task Board

A lightweight Trello-like task board application built with Vue 3 and Express.

## Tech Stack

### Frontend
- Vue 3 + Vite
- Vue Router
- Pinia (state management)
- Element Plus (UI components)
- vuedraggable (drag and drop)
- Axios (HTTP client)

### Backend
- Node.js + Express
- better-sqlite3 (SQLite database)
- jsonwebtoken (JWT authentication)
- bcryptjs (password hashing)
- cors

## Project Structure

```
task-board/
├── frontend/          # Vue 3 frontend (port 5174)
│   ├── src/
│   │   ├── api/       # Axios API layer
│   │   ├── components/# Reusable Vue components
│   │   ├── router/    # Vue Router configuration
│   │   ├── stores/    # Pinia stores (auth, board)
│   │   └── views/     # Page-level components
│   └── vite.config.js
├── backend/           # Express API (port 3002)
│   ├── db/            # Database init, seed, and overview snapshot scripts
│   ├── middleware/    # Auth middleware (JWT)
│   ├── routes/       # API route handlers
│   ├── data/         # SQLite database file
│   └── server.js
└── README.md
```

## Getting Started

### Prerequisites
- Node.js 18+

### Backend Setup

```bash
cd backend
npm install
npm run seed     # Seed database with demo data
npm run dev      # Start server on port 3002
```

### Frontend Setup

```bash
cd frontend
npm install
npm run dev      # Start dev server on port 5174
```

### Demo Account

- Username: `demo`
- Password: `demo123`

The seed script creates a demo user with a sample board "My Project" containing 3 columns (To Do, In Progress, Done) and 7 sample cards.

## Board Overview Snapshot (local dev)

```bash
cd backend
npm run snapshot
```

Captures a read-only snapshot of the data behind the "My Boards" overview — board count, every board's columns and cards, column counts, and empty states (no boards, boards without columns/cards, columns without cards) — and writes it to `backend/data/overview-snapshot.json`. The output is deterministic (stable ordering, no run timestamps), so two runs can be compared with a plain diff, e.g. `git diff backend/data/overview-snapshot.json`. Re-running overwrites the previous snapshot.

The script never modifies boards, columns, or cards: it opens the database read-only and only runs `SELECT` queries. (Like any SQLite reader of a WAL database it may leave transient `*.db-shm`/`*.db-wal` side files — the same files the dev server creates; the database content itself is untouched.)

The run is split into stages and stops at the first failing stage with a clear message:

| Stage | Checks | Exit code |
|-------|--------|-----------|
| `deps` | `better-sqlite3` loads, database file exists and opens read-only | 2 |
| `collect` | overview queries succeed | 3 |
| `write` | snapshot directory is writable, snapshot file is written | 4 |

Environment overrides for local dev:

- `TASKBOARD_DB_PATH` — read a different database file (default: `backend/data/taskboard.db`)
- `SNAPSHOT_OUTPUT` — write the snapshot to a different path (default: `backend/data/overview-snapshot.json`)

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login (returns JWT)

### Boards
- `GET /api/boards` - List user's boards
- `POST /api/boards` - Create board
- `DELETE /api/boards/:id` - Delete board

### Columns
- `GET /api/boards/:boardId/columns` - Get columns for a board
- `POST /api/boards/:boardId/columns` - Add column
- `PUT /api/columns/:id` - Update column (rename/reorder)
- `DELETE /api/columns/:id` - Delete column

### Cards
- `GET /api/columns/:columnId/cards` - Get cards in column
- `POST /api/columns/:columnId/cards` - Add card
- `PUT /api/cards/:id` - Update card
- `DELETE /api/cards/:id` - Delete card
- `PUT /api/cards/:id/move` - Move card to another column

## Features

- User authentication with JWT
- Create and manage multiple boards
- Add, rename, and delete columns
- Create cards with title, description, priority (low/medium/high), and due date
- Drag and drop cards between columns
- Drag and drop to reorder columns
- Responsive design with Element Plus UI
