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
│   ├── db/            # Database init and seed scripts
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

### Local development: board overview snapshots

For local development you can capture a comparable snapshot of everything shown on
the **My Boards** overview: board counts, per-board column/card counts, and the
empty states (users with no boards, boards without columns, boards without
cards).

```bash
cd backend
npm run snapshot          # aggregate and (over)write snapshots/board-overview.json
npm run snapshot:check    # compare current data with the saved snapshot
```

- Repeating `npm run snapshot` **overwrites the previous snapshot**; the JSON is
  deterministic (sorted, no timestamp), so runs can be diffed directly. The
  command also prints changes versus the previous snapshot.
- `npm run snapshot:check` never writes; it exits `0` when the current data
  matches the saved snapshot and `2` when differences are found (and prints
  them), which is useful as a quick local verification step.
- The database is opened **read-only**; existing boards are never modified, and
  creating / deleting / opening boards behaves exactly as before.
- The run stops at an explicit numbered stage with a hint when a dependency is
  missing (`1/4 dependencies`), the database cannot be opened
  (`2/4 database`), aggregation fails (`3/4 aggregation`), or the snapshot
  location is not writable (`4/4 snapshot`).
- Custom locations are supported with `-- --db <path> --out <path>`.
- Snapshots are dev-only artifacts and are git-ignored (`backend/snapshots/`).

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
