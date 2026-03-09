# Fishbowl — Vision

## Product Description

Fishbowl is a browser-based multiplayer party game for 4–8 players split into two teams. Players submit names of famous people or fictional characters, which go into a shared pool. Teams take turns giving clues across three rounds with increasingly restrictive rules: describe it (Round 1), act it out (Round 2), one word only (Round 3). The same slips are reused each round. Points are scored per correct guess; the team with the most points after Round 3 wins.

The goal is a polished, shareable web app that a group of friends can launch from their phones with no install, no account, and no friction.

## Constraints

These are fixed and must not be changed by agents:

- **Language**: TypeScript throughout (client, server, shared types)
- **Server authority**: The server owns all game state. Clients render what they receive. No client-side game logic.
- **No database**: Game state is in-memory. Rooms expire after inactivity.
- **Real-time**: All state changes must push to clients instantly via WebSocket
- **No auth**: Join by room code only. No accounts, no login.

## Current Milestone

**M1 — Playable Single-Room Prototype**

A complete, playable game loop for one room. All three rounds. Full scoring. Host controls. Runs locally. Not yet deployed.

### Definition of Done

- [x] A host can create a room and share a code
- [x] 2–8 players can join by entering the room code
- [x] Players can be assigned to Team A or Team B (manual or randomized)
- [x] Each player submits 4 slips before the game starts
- [x] All three rounds play correctly with the same slip pool reshuffled each round
- [x] 30-second server-authoritative timer per turn with 5-second skip penalty
- [x] Skipped slips go to the bottom and cannot be re-drawn in the same turn
- [x] Scores accumulate correctly across all rounds
- [x] Carryover time works when the last slip of a round is guessed mid-turn
- [x] Game over screen shows final scores and winner
- [x] Host can start a new game (same players, new slips)
- [x] Works on mobile browsers (no install)
- [x] No known crashes or stuck states during normal play

## Completed Work

M1 is functionally complete. The full game loop is playable end-to-end.

### Infrastructure
- **Monorepo scaffold** — `server/`, `client/`, `shared/` packages with TypeScript throughout (PR #12)
- **Configurable ports** — server and client ports via environment variables (PR #27)
- **README** — setup instructions, usage guide, and game rules (PR #25)

### Server — Game Engine
- **RoomManager with WebSocket support** — room creation, join/leave, host transfer (PR #19)
- **Team assignment & slip submission** — manual/random team assignment, slip submission, phase transitions (PR #20)
- **Turn & timer engine** — start-turn, got-it, skip with 5-second penalty, server-authoritative 30-second timer (PR #21)
- **Round progression & game-over** — all three rounds with reshuffled slip pool, carryover time, final scores, new-game reset (PR #22)
- **Start-game handler** — lobby-to-submitting phase transition with host controls (PR #33)
- **Player count enforcement** — 2–8 player limits enforced server-side (PR #34)
- **Graceful disconnect handling** — players can disconnect and the game continues without crashing (PR #35)

### Client
- **Join, lobby, and game UI** — mobile-friendly screens for joining by room code, lobby view, and full gameplay UI (PR #23)

### Testing
- **168 unit/integration tests** passing across RoomManager and game logic
- **End-to-end smoke test** — automated full game loop verification (PR #36)

### Remaining Polish (Post-M1)
- No deployment yet (M2 scope per Upcoming Priorities)
- No reconnection grace period (M2 scope)
- No animations or sound cues (M2 scope)
- TV/host-screen display mode deferred to M2

## Upcoming Priorities (Post-M1)

These are not in scope for M1 but inform decisions agents make now:

1. **Deployment** — hosted publicly so friends can join from anywhere
2. **Display modes** — TV/host-screen mode vs. phone-only mode (see notes below)
3. **Reconnection** — 30-second grace period for dropped connections
4. **Room cleanup** — auto-expire rooms after 30 minutes of inactivity
5. **Polish** — animations, sound cues, better mobile layout

## Open Decisions

- Display mode implementation: The game supports two modes chosen at room creation — (1) a dedicated host screen on a TV/laptop showing the full game view while phones show minimal UI, and (2) phone-only mode where every player's phone shows full context. This is deferred to M2 but agents should not design the UI in a way that makes it hard to add later.
- Deployment target: TBD. Likely a single small VPS or existing EC2 instance. Do not optimize for it in M1.

## Game Rules Reference

### Round Rules
- **Round 1**: Describe the person — any words, cannot say any part of the name
- **Round 2**: Charades — no words, no sounds, gestures only
- **Round 3**: One word clue only

### Turn Flow
- Teams alternate turns; players rotate as clue-giver within their team across all rounds
- 30 seconds per turn (server timer)
- Got It: +1 point, next slip drawn
- Skip: slip goes to bottom of pool, -5 seconds from timer; cannot re-skip already-skipped slips this turn
- Turn ends when timer hits 0 or all remaining slips have been skipped this turn

### Slip Pool
- Each player submits exactly 4 slips before the game starts
- All slips shared in one pool across both teams
- Pool is reshuffled at the start of each round
- Slips guessed in a round are removed from that round's pool only — all slips return for the next round
