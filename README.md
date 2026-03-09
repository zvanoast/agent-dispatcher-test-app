# Fishbowl

A browser-based multiplayer party game for 4-8 players. Teams take turns giving clues to guess famous people or fictional characters across three increasingly restrictive rounds.

## How It Works

1. A host creates a room and shares a 4-character code
2. Players join from their phones — no install, no account
3. Everyone submits 4 slips (names of famous people or characters)
4. Teams alternate 30-second turns across three rounds:
   - **Round 1 — Describe:** Use any words except the name itself
   - **Round 2 — Charades:** No words or sounds, gestures only
   - **Round 3 — One Word:** A single word clue
5. The same slips are reused each round. The team with the most points after Round 3 wins.

## Tech Stack

- **TypeScript** — strict mode, ESM throughout
- **Server:** Node.js 20+, Fastify, WebSocket (`ws`)
- **Client:** Vanilla TypeScript, Vite
- **Shared:** Common types and enums used by both client and server
- **Testing:** Vitest

The server is fully authoritative — all game state lives on the server and clients are stateless renderers. No database; rooms are held in memory.

## Project Structure

```
agent-project/
├── shared/src/        # Shared types, enums, and message interfaces
│   ├── types.ts       # Room, Player, Slip, GamePhase, all message types
│   └── index.ts       # Barrel re-export
├── server/src/        # Fastify server with WebSocket game engine
│   ├── index.ts       # HTTP + WebSocket entry point
│   ├── roomManager.ts # Core game logic (rooms, turns, scoring, rounds)
│   └── roomManager.test.ts
├── client/src/        # Browser UI
│   ├── main.ts        # Phase-based rendering and message handling
│   ├── ws.ts          # WebSocket client wrapper
│   └── style.css      # Mobile-first dark theme
└── package.json       # Root build orchestrator
```

## Prerequisites

- Node.js 20 or later
- npm

## Setup

```bash
# Install dependencies for all packages
npm run install:all
```

## Development

Start the server and client in two separate terminals:

```bash
# Terminal 1 — start the game server (port 3000)
npm run dev:server

# Terminal 2 — start the Vite dev server (port 5173)
npm run dev:client
```

Open `http://localhost:5173` in your browser. The Vite dev server automatically proxies WebSocket connections to the game server on port 3000.

### Custom Ports

All ports are configurable via environment variables. The defaults are **3000** (server) and **5173** (client).

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Game server port |
| `VITE_SERVER_PORT` | `3000` | Tells the client which port the game server is on |
| `VITE_CLIENT_PORT` | `5173` | Vite dev server port |

**Using `.env` files (recommended):**

Copy the example files and edit as needed:

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
```

`server/.env`:
```
PORT=4000
```

`client/.env`:
```
VITE_SERVER_PORT=4000
VITE_CLIENT_PORT=8080
```

The server loads `server/.env` automatically on startup. The client loads `client/.env` automatically via Vite.

**Using inline environment variables:**

When changing the server port, set both `PORT` and `VITE_SERVER_PORT` so the client knows where to connect:

```bash
# Terminal 1 — run server on port 4000
PORT=4000 npm run dev:server

# Terminal 2 — run client on port 8080, pointing at server port 4000
VITE_SERVER_PORT=4000 VITE_CLIENT_PORT=8080 npm run dev:client
```

## Production Build

```bash
npm run build
```

This builds all three packages in order: shared, server, then client. Output goes to `dist/` in each package directory.

## Testing

```bash
cd server && npm test
```

## Game Rules

### Turns

- 30 seconds per turn (server-authoritative timer)
- **Got It** — +1 point, next slip is drawn
- **Skip** — slip goes to the bottom of the pool, -5 second penalty; already-skipped slips cannot be re-skipped in the same turn
- Turn ends when the timer hits 0 or all remaining slips have been skipped

### Scoring

- Points accumulate across all three rounds
- If the last slip of a round is guessed before time runs out, the remaining time carries over to the next round's first turn

### Other Rules

- Teams alternate turns; the clue-giver rotates within each team across rounds
- Each player submits exactly 4 slips before the game starts
- The slip pool is reshuffled at the start of each round
