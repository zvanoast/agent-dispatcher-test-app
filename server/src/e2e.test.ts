import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RoomManager } from "./roomManager.js";
import {
  GamePhase,
  RoundType,
  ServerMessageType,
  ClientMessageType,
  Team,
} from "@fishbowl/shared";

/** Create a mock WebSocket */
function mockWs(): any {
  return {
    readyState: 1,
    OPEN: 1,
    send: vi.fn(),
    close: vi.fn(),
  };
}

/** Parse all messages sent to a mock ws */
function sent(ws: any): any[] {
  return ws.send.mock.calls.map((c: any) => JSON.parse(c[0]));
}

/** Get the last message sent to a ws */
function lastSent(ws: any): any {
  const msgs = sent(ws);
  return msgs[msgs.length - 1];
}

/** Find messages of a given type sent to a ws */
function messagesOfType(ws: any, type: string): any[] {
  return sent(ws).filter((m: any) => m.type === type);
}

describe("E2E: Full Game Loop", () => {
  let rm: RoomManager;
  let hostWs: any, ws2: any, ws3: any, ws4: any;
  const ROOM = "E2E1";

  beforeEach(() => {
    vi.useFakeTimers();
    rm = new RoomManager();

    // 1. Create room and join 4 players
    hostWs = mockWs();
    ws2 = mockWs();
    ws3 = mockWs();
    ws4 = mockWs();

    expect(rm.handleConnection(hostWs, ROOM, "Alice")).toBeNull();
    expect(rm.handleConnection(ws2, ROOM, "Bob")).toBeNull();
    expect(rm.handleConnection(ws3, ROOM, "Carol")).toBeNull();
    expect(rm.handleConnection(ws4, ROOM, "Dave")).toBeNull();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Helper: get player IDs from the room */
  function players() {
    return rm.getRoom(ROOM)!.players;
  }

  /** Helper: get a player's ws by name */
  function wsFor(name: string) {
    return { Alice: hostWs, Bob: ws2, Carol: ws3, Dave: ws4 }[name]!;
  }

  /** Helper: find the clue-giver's ws */
  function clueGiverWs() {
    const room = rm.getRoom(ROOM)!;
    return { Alice: hostWs, Bob: ws2, Carol: ws3, Dave: ws4 }[
      players().find((p) => p.id === room.activeClueGiverId)!.name
    ]!;
  }

  /** Helper: guess all slips in the pool (plays out the entire round via "got-it") */
  function guessAllSlipsInRound() {
    const room = rm.getRoom(ROOM)!;
    const startingRound = room.roundNumber;
    while (room.roundNumber === startingRound && room.phase !== GamePhase.GameOver) {
      // Start a turn (host)
      const err = rm.handleMessage(hostWs, { type: ClientMessageType.StartTurn });
      expect(err).toBeNull();

      // Guess all slips this turn until pool is empty or turn ends
      while (room.currentSlip && room.phase === GamePhase.TurnActive) {
        const cgWs = clueGiverWs();
        const gotErr = rm.handleMessage(cgWs, { type: ClientMessageType.GotIt });
        expect(gotErr).toBeNull();
      }
    }
  }

  it("plays a complete game: create → join → teams → slips → 3 rounds → game-over → new game", () => {
    const room = rm.getRoom(ROOM)!;

    // Verify lobby state
    expect(room.phase).toBe(GamePhase.Lobby);
    expect(room.players).toHaveLength(4);
    expect(room.players[0].isHost).toBe(true);

    // 2. Assign teams: Alice & Bob → Team A, Carol & Dave → Team B
    const [alice, bob, carol, dave] = players();
    rm.handleMessage(hostWs, { type: ClientMessageType.AssignTeam, playerId: alice.id, team: Team.A });
    rm.handleMessage(hostWs, { type: ClientMessageType.AssignTeam, playerId: bob.id, team: Team.A });
    rm.handleMessage(hostWs, { type: ClientMessageType.AssignTeam, playerId: carol.id, team: Team.B });
    rm.handleMessage(hostWs, { type: ClientMessageType.AssignTeam, playerId: dave.id, team: Team.B });

    expect(players().every((p) => p.team !== null)).toBe(true);

    // 3. Start game → Submitting phase
    expect(rm.handleMessage(hostWs, { type: ClientMessageType.StartGame })).toBeNull();
    expect(room.phase).toBe(GamePhase.Submitting);

    // 4. Submit slips (4 per player = 16 total)
    const slipSets: Record<string, string[]> = {
      Alice: ["Einstein", "Cleopatra", "Shakespeare", "Tesla"],
      Bob: ["Mozart", "DaVinci", "Curie", "Newton"],
      Carol: ["Aristotle", "Napoleon", "Galileo", "Darwin"],
      Dave: ["Columbus", "Beethoven", "Picasso", "Turing"],
    };

    for (const [name, texts] of Object.entries(slipSets)) {
      rm.handleMessage(wsFor(name), { type: ClientMessageType.SubmitSlips, texts });
    }

    // After all submit → Playing phase
    expect(room.phase).toBe(GamePhase.Playing);
    expect(room.allSlips).toHaveLength(16);
    expect(room.slipPool).toHaveLength(16);
    expect(room.round).toBe(RoundType.Describe);
    expect(room.roundNumber).toBe(1);

    // Clear all mocks to track round-specific messages
    [hostWs, ws2, ws3, ws4].forEach((ws) => ws.send.mockClear());

    // =========================================================================
    // ROUND 1: Describe
    // =========================================================================
    guessAllSlipsInRound();

    expect(room.roundNumber).toBe(2);
    expect(room.round).toBe(RoundType.Charades);
    expect(room.phase).toBe(GamePhase.RoundEnd);
    // All 16 slips guessed → scores should sum to 16
    expect(room.scores[Team.A] + room.scores[Team.B]).toBe(16);
    // Pool reshuffled for round 2
    expect(room.slipPool).toHaveLength(16);

    const scoresAfterR1 = { ...room.scores };

    // Verify RoundEnded was broadcast
    const roundEndMsgs = messagesOfType(hostWs, ServerMessageType.RoundEnded);
    expect(roundEndMsgs.length).toBeGreaterThanOrEqual(1);
    const r1End = roundEndMsgs[roundEndMsgs.length - 1];
    expect(r1End.completedRound).toBe(RoundType.Describe);
    expect(r1End.nextRound).toBe(RoundType.Charades);

    // =========================================================================
    // ROUND 2: Charades
    // =========================================================================
    guessAllSlipsInRound();

    expect(room.roundNumber).toBe(3);
    expect(room.round).toBe(RoundType.OneWord);
    expect(room.phase).toBe(GamePhase.RoundEnd);
    // Cumulative: 32 total slips guessed across 2 rounds
    expect(room.scores[Team.A] + room.scores[Team.B]).toBe(32);
    // Scores should have accumulated (not reset)
    expect(room.scores[Team.A]).toBeGreaterThanOrEqual(scoresAfterR1[Team.A]);
    expect(room.scores[Team.B]).toBeGreaterThanOrEqual(scoresAfterR1[Team.B]);
    expect(room.slipPool).toHaveLength(16);

    const scoresAfterR2 = { ...room.scores };

    // =========================================================================
    // ROUND 3: One Word
    // =========================================================================
    guessAllSlipsInRound();

    // Game should be over
    expect(room.phase).toBe(GamePhase.GameOver);
    // Cumulative: 48 total slips guessed across 3 rounds
    expect(room.scores[Team.A] + room.scores[Team.B]).toBe(48);
    expect(room.scores[Team.A]).toBeGreaterThanOrEqual(scoresAfterR2[Team.A]);
    expect(room.scores[Team.B]).toBeGreaterThanOrEqual(scoresAfterR2[Team.B]);

    // Verify GameOver message was broadcast with correct winner
    const gameOverMsgs = messagesOfType(hostWs, ServerMessageType.GameOver);
    expect(gameOverMsgs).toHaveLength(1);
    const gameOver = gameOverMsgs[0];
    expect(gameOver.scores[Team.A] + gameOver.scores[Team.B]).toBe(48);
    const expectedWinner =
      gameOver.scores[Team.A] > gameOver.scores[Team.B]
        ? Team.A
        : gameOver.scores[Team.B] > gameOver.scores[Team.A]
          ? Team.B
          : "tie";
    expect(gameOver.winner).toBe(expectedWinner);

    // =========================================================================
    // NEW GAME
    // =========================================================================
    expect(rm.handleMessage(hostWs, { type: ClientMessageType.NewGame })).toBeNull();

    expect(room.phase).toBe(GamePhase.Submitting);
    expect(room.roundNumber).toBe(1);
    expect(room.round).toBe(RoundType.Describe);
    expect(room.scores[Team.A]).toBe(0);
    expect(room.scores[Team.B]).toBe(0);
    expect(room.slipPool).toHaveLength(0);
    expect(room.allSlips).toHaveLength(0);
    expect(room.carryoverTime).toBe(0);
    // Players and teams preserved, slips cleared
    expect(room.players).toHaveLength(4);
    expect(room.players.every((p) => p.team !== null)).toBe(true);
    expect(room.players.every((p) => p.slips.length === 0)).toBe(true);
  });

  it("tracks carryover time when a round ends mid-turn", () => {
    const room = rm.getRoom(ROOM)!;

    // Setup: assign teams, start game, submit slips
    const [alice, bob, carol, dave] = players();
    rm.handleMessage(hostWs, { type: ClientMessageType.AssignTeam, playerId: alice.id, team: Team.A });
    rm.handleMessage(hostWs, { type: ClientMessageType.AssignTeam, playerId: bob.id, team: Team.A });
    rm.handleMessage(hostWs, { type: ClientMessageType.AssignTeam, playerId: carol.id, team: Team.B });
    rm.handleMessage(hostWs, { type: ClientMessageType.AssignTeam, playerId: dave.id, team: Team.B });
    rm.handleMessage(hostWs, { type: ClientMessageType.StartGame });

    for (const [name, texts] of Object.entries({
      Alice: ["Slip1", "Slip2", "Slip3", "Slip4"],
      Bob: ["Slip5", "Slip6", "Slip7", "Slip8"],
      Carol: ["Slip9", "Slip10", "Slip11", "Slip12"],
      Dave: ["Slip13", "Slip14", "Slip15", "Slip16"],
    })) {
      rm.handleMessage(wsFor(name), { type: ClientMessageType.SubmitSlips, texts });
    }

    expect(room.phase).toBe(GamePhase.Playing);

    // Start first turn - 30 seconds
    rm.handleMessage(hostWs, { type: ClientMessageType.StartTurn });
    expect(room.turnTimeRemaining).toBe(30);

    // Advance 5 seconds
    vi.advanceTimersByTime(5000);
    expect(room.turnTimeRemaining).toBe(25);

    // Guess all 16 slips quickly (simulating fast round)
    while (room.currentSlip && room.slipPool.length > 0) {
      rm.handleMessage(clueGiverWs(), { type: ClientMessageType.GotIt });
    }

    // Round should have ended with carryover time
    expect(room.phase).toBe(GamePhase.RoundEnd);
    expect(room.roundNumber).toBe(2);
    // Carryover time should be the remaining time when the last slip was guessed
    expect(room.carryoverTime).toBeGreaterThan(0);

    const carryover = room.carryoverTime;

    // Start next round's turn — should use carryover time
    rm.handleMessage(hostWs, { type: ClientMessageType.StartTurn });
    expect(room.turnTimeRemaining).toBe(carryover);
    // Carryover consumed
    expect(room.carryoverTime).toBe(0);
  });

  it("handles scoring correctly with skips mixed in", () => {
    const room = rm.getRoom(ROOM)!;

    // Setup
    const [alice, bob, carol, dave] = players();
    rm.handleMessage(hostWs, { type: ClientMessageType.AssignTeam, playerId: alice.id, team: Team.A });
    rm.handleMessage(hostWs, { type: ClientMessageType.AssignTeam, playerId: bob.id, team: Team.A });
    rm.handleMessage(hostWs, { type: ClientMessageType.AssignTeam, playerId: carol.id, team: Team.B });
    rm.handleMessage(hostWs, { type: ClientMessageType.AssignTeam, playerId: dave.id, team: Team.B });
    rm.handleMessage(hostWs, { type: ClientMessageType.StartGame });

    for (const [name, texts] of Object.entries({
      Alice: ["A1", "A2", "A3", "A4"],
      Bob: ["B1", "B2", "B3", "B4"],
      Carol: ["C1", "C2", "C3", "C4"],
      Dave: ["D1", "D2", "D3", "D4"],
    })) {
      rm.handleMessage(wsFor(name), { type: ClientMessageType.SubmitSlips, texts });
    }

    // Start first turn
    rm.handleMessage(hostWs, { type: ClientMessageType.StartTurn });
    expect(room.phase).toBe(GamePhase.TurnActive);

    const cgWs = clueGiverWs();
    const activeTeam = room.activeTeam;

    // Guess one, skip one, guess one
    rm.handleMessage(cgWs, { type: ClientMessageType.GotIt });
    expect(room.scores[activeTeam]).toBe(1);

    rm.handleMessage(cgWs, { type: ClientMessageType.Skip });
    // Skip doesn't change score
    expect(room.scores[activeTeam]).toBe(1);
    // But deducts 5s from timer
    expect(room.turnTimeRemaining).toBe(25);

    rm.handleMessage(cgWs, { type: ClientMessageType.GotIt });
    expect(room.scores[activeTeam]).toBe(2);
  });
});
