import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RoomManager, MAX_PLAYERS, MIN_PLAYERS } from "./roomManager.js";
import { GamePhase, ServerMessageType, ClientMessageType, Team } from "@fishbowl/shared";
import type { Slip } from "@fishbowl/shared";

/** Create a mock WebSocket */
function mockWs(): any {
  return {
    readyState: 1, // OPEN
    OPEN: 1,
    send: vi.fn(),
    close: vi.fn(),
  };
}

describe("RoomManager", () => {
  let rm: RoomManager;

  beforeEach(() => {
    rm = new RoomManager();
  });

  describe("room creation", () => {
    it("creates a room when a player connects with a new code", () => {
      const ws = mockWs();
      const err = rm.handleConnection(ws, "AB12", "Alice");
      expect(err).toBeNull();

      const room = rm.getRoom("AB12");
      expect(room).toBeDefined();
      expect(room!.code).toBe("AB12");
      expect(room!.phase).toBe(GamePhase.Lobby);
      expect(room!.players).toHaveLength(1);
      expect(room!.players[0].name).toBe("Alice");
      expect(room!.players[0].isHost).toBe(true);
    });

    it("sends room-created message to the host", () => {
      const ws = mockWs();
      rm.handleConnection(ws, "AB12", "Alice");

      const calls = ws.send.mock.calls;
      // First call is room-created, second is room-state
      const roomCreated = JSON.parse(calls[0][0]);
      expect(roomCreated.type).toBe(ServerMessageType.RoomCreated);
      expect(roomCreated.roomCode).toBe("AB12");
    });
  });

  describe("joining", () => {
    it("joins an existing room", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      rm.handleConnection(ws1, "AB12", "Alice");
      rm.handleConnection(ws2, "AB12", "Bob");

      const room = rm.getRoom("AB12");
      expect(room!.players).toHaveLength(2);
      expect(room!.players[1].name).toBe("Bob");
      expect(room!.players[1].isHost).toBe(false);
    });

    it("broadcasts room-state to all clients on join", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      rm.handleConnection(ws1, "AB12", "Alice");
      ws1.send.mockClear();

      rm.handleConnection(ws2, "AB12", "Bob");

      // Both ws1 and ws2 should receive room-state
      const msg1 = JSON.parse(ws1.send.mock.calls[0][0]);
      const msg2Calls = ws2.send.mock.calls;
      // ws2 gets room-state (no room-created since room already exists)
      const msg2 = JSON.parse(msg2Calls[0][0]);

      expect(msg1.type).toBe(ServerMessageType.RoomState);
      expect(msg1.room.players).toHaveLength(2);
      expect(msg2.type).toBe(ServerMessageType.RoomState);
      expect(msg2.room.players).toHaveLength(2);
    });

    it("rejects duplicate player names", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      rm.handleConnection(ws1, "AB12", "Alice");

      const err = rm.handleConnection(ws2, "AB12", "alice");
      expect(err).toContain("already taken");
    });
  });

  describe("invalid inputs", () => {
    it("rejects empty player name", () => {
      const ws = mockWs();
      const err = rm.handleConnection(ws, "AB12", "  ");
      expect(err).toBe("Player name is required");
    });

    it("rejects invalid room code format", () => {
      const ws = mockWs();
      expect(rm.handleConnection(ws, "AB", "Alice")).toBe("Invalid room code format");
      expect(rm.handleConnection(ws, "ab12", "Alice")).toBe("Invalid room code format");
      expect(rm.handleConnection(ws, "", "Alice")).toBe("Invalid room code format");
      expect(rm.handleConnection(ws, "ABCDE", "Alice")).toBe("Invalid room code format");
    });
  });

  describe("disconnect / leave", () => {
    it("removes a player on disconnect", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      rm.handleConnection(ws1, "AB12", "Alice");
      rm.handleConnection(ws2, "AB12", "Bob");

      rm.handleDisconnect(ws2);

      const room = rm.getRoom("AB12");
      expect(room!.players).toHaveLength(1);
      expect(room!.players[0].name).toBe("Alice");
    });

    it("broadcasts room-state after disconnect", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      rm.handleConnection(ws1, "AB12", "Alice");
      rm.handleConnection(ws2, "AB12", "Bob");
      ws1.send.mockClear();

      rm.handleDisconnect(ws2);

      const msg = JSON.parse(ws1.send.mock.calls[0][0]);
      expect(msg.type).toBe(ServerMessageType.RoomState);
      expect(msg.room.players).toHaveLength(1);
    });

    it("removes the room when the last player disconnects", () => {
      const ws = mockWs();
      rm.handleConnection(ws, "AB12", "Alice");
      rm.handleDisconnect(ws);
      expect(rm.getRoom("AB12")).toBeUndefined();
      expect(rm.roomCount).toBe(0);
    });
  });

  describe("host transfer", () => {
    it("transfers host to next player when host leaves", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      const ws3 = mockWs();
      rm.handleConnection(ws1, "AB12", "Alice");
      rm.handleConnection(ws2, "AB12", "Bob");
      rm.handleConnection(ws3, "AB12", "Carol");

      // Alice is host, disconnect her
      rm.handleDisconnect(ws1);

      const room = rm.getRoom("AB12");
      expect(room!.players).toHaveLength(2);
      // Bob should now be host
      expect(room!.players[0].name).toBe("Bob");
      expect(room!.players[0].isHost).toBe(true);
      expect(room!.players[1].isHost).toBe(false);
    });

    it("does not transfer host when a non-host leaves", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      rm.handleConnection(ws1, "AB12", "Alice");
      rm.handleConnection(ws2, "AB12", "Bob");

      rm.handleDisconnect(ws2);

      const room = rm.getRoom("AB12");
      expect(room!.players[0].isHost).toBe(true);
      expect(room!.players[0].name).toBe("Alice");
    });
  });

  describe("idempotent disconnect", () => {
    it("handles disconnecting an unknown WebSocket gracefully", () => {
      const ws = mockWs();
      // Should not throw
      rm.handleDisconnect(ws);
    });
  });

  describe("assign-team", () => {
    it("host can assign a player to a team", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      rm.handleConnection(ws1, "AB12", "Alice");
      rm.handleConnection(ws2, "AB12", "Bob");

      const room = rm.getRoom("AB12")!;
      const bobId = room.players[1].id;

      ws1.send.mockClear();
      ws2.send.mockClear();

      const err = rm.handleMessage(ws1, {
        type: ClientMessageType.AssignTeam,
        playerId: bobId,
        team: Team.B,
      });

      expect(err).toBeNull();
      expect(room.players[1].team).toBe(Team.B);

      // Both clients should receive teams-updated
      const msg1 = JSON.parse(ws1.send.mock.calls[0][0]);
      expect(msg1.type).toBe(ServerMessageType.TeamsUpdated);
      expect(msg1.players[1].team).toBe(Team.B);

      const msg2 = JSON.parse(ws2.send.mock.calls[0][0]);
      expect(msg2.type).toBe(ServerMessageType.TeamsUpdated);
    });

    it("non-host cannot assign teams", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      rm.handleConnection(ws1, "AB12", "Alice");
      rm.handleConnection(ws2, "AB12", "Bob");

      const room = rm.getRoom("AB12")!;
      const aliceId = room.players[0].id;

      const err = rm.handleMessage(ws2, {
        type: ClientMessageType.AssignTeam,
        playerId: aliceId,
        team: Team.A,
      });

      expect(err).toBe("Only the host can assign teams");
    });

    it("rejects assigning a non-existent player", () => {
      const ws1 = mockWs();
      rm.handleConnection(ws1, "AB12", "Alice");

      const err = rm.handleMessage(ws1, {
        type: ClientMessageType.AssignTeam,
        playerId: "nonexistent-id",
        team: Team.A,
      });

      expect(err).toBe("Player not found");
    });
  });

  describe("randomize-teams", () => {
    it("host can randomize teams and all players get assigned", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      const ws3 = mockWs();
      const ws4 = mockWs();
      rm.handleConnection(ws1, "AB12", "Alice");
      rm.handleConnection(ws2, "AB12", "Bob");
      rm.handleConnection(ws3, "AB12", "Carol");
      rm.handleConnection(ws4, "AB12", "Dave");

      const err = rm.handleMessage(ws1, {
        type: ClientMessageType.RandomizeTeams,
      });

      expect(err).toBeNull();

      const room = rm.getRoom("AB12")!;
      // All players should have a team assigned
      expect(room.players.every((p) => p.team !== null)).toBe(true);

      // Teams should be evenly split (2 and 2 for 4 players)
      const teamA = room.players.filter((p) => p.team === Team.A);
      const teamB = room.players.filter((p) => p.team === Team.B);
      expect(teamA.length).toBe(2);
      expect(teamB.length).toBe(2);
    });

    it("handles odd number of players (extra goes to Team A)", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      const ws3 = mockWs();
      rm.handleConnection(ws1, "AB12", "Alice");
      rm.handleConnection(ws2, "AB12", "Bob");
      rm.handleConnection(ws3, "AB12", "Carol");

      rm.handleMessage(ws1, { type: ClientMessageType.RandomizeTeams });

      const room = rm.getRoom("AB12")!;
      const teamA = room.players.filter((p) => p.team === Team.A);
      const teamB = room.players.filter((p) => p.team === Team.B);
      expect(teamA.length).toBe(2);
      expect(teamB.length).toBe(1);
    });

    it("non-host cannot randomize teams", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      rm.handleConnection(ws1, "AB12", "Alice");
      rm.handleConnection(ws2, "AB12", "Bob");

      const err = rm.handleMessage(ws2, {
        type: ClientMessageType.RandomizeTeams,
      });

      expect(err).toBe("Only the host can randomize teams");
    });

    it("broadcasts teams-updated to all clients", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      rm.handleConnection(ws1, "AB12", "Alice");
      rm.handleConnection(ws2, "AB12", "Bob");
      ws1.send.mockClear();
      ws2.send.mockClear();

      rm.handleMessage(ws1, { type: ClientMessageType.RandomizeTeams });

      const msg1 = JSON.parse(ws1.send.mock.calls[0][0]);
      const msg2 = JSON.parse(ws2.send.mock.calls[0][0]);
      expect(msg1.type).toBe(ServerMessageType.TeamsUpdated);
      expect(msg2.type).toBe(ServerMessageType.TeamsUpdated);
    });
  });

  describe("submit-slips", () => {
    function setupSubmittingRoom() {
      const ws1 = mockWs();
      const ws2 = mockWs();
      rm.handleConnection(ws1, "AB12", "Alice");
      rm.handleConnection(ws2, "AB12", "Bob");

      // Manually set phase to submitting
      const room = rm.getRoom("AB12")!;
      room.phase = GamePhase.Submitting;

      return { ws1, ws2, room };
    }

    it("player can submit exactly 4 slips", () => {
      const { ws1, room } = setupSubmittingRoom();

      const err = rm.handleMessage(ws1, {
        type: ClientMessageType.SubmitSlips,
        texts: ["Beyoncé", "Einstein", "Pikachu", "Cleopatra"],
      });

      expect(err).toBeNull();
      expect(room.players[0].slips).toHaveLength(4);
      expect(room.players[0].slips[0].text).toBe("Beyoncé");
      expect(room.players[0].slips[0].submittedBy).toBe(room.players[0].id);
    });

    it("rejects fewer than 4 slips", () => {
      const { ws1 } = setupSubmittingRoom();

      const err = rm.handleMessage(ws1, {
        type: ClientMessageType.SubmitSlips,
        texts: ["One", "Two", "Three"],
      });

      expect(err).toBe("Must submit exactly 4 slips");
    });

    it("rejects more than 4 slips", () => {
      const { ws1 } = setupSubmittingRoom();

      const err = rm.handleMessage(ws1, {
        type: ClientMessageType.SubmitSlips,
        texts: ["One", "Two", "Three", "Four", "Five"],
      });

      expect(err).toBe("Must submit exactly 4 slips");
    });

    it("rejects empty slip text", () => {
      const { ws1 } = setupSubmittingRoom();

      const err = rm.handleMessage(ws1, {
        type: ClientMessageType.SubmitSlips,
        texts: ["Beyoncé", "", "Pikachu", "Cleopatra"],
      });

      expect(err).toBe("All slips must be non-empty");
    });

    it("rejects submission when not in submitting phase", () => {
      const ws1 = mockWs();
      rm.handleConnection(ws1, "AB12", "Alice");

      // Room is in lobby phase by default
      const err = rm.handleMessage(ws1, {
        type: ClientMessageType.SubmitSlips,
        texts: ["One", "Two", "Three", "Four"],
      });

      expect(err).toBe("Not in submitting phase");
    });
  });

  describe("phase transition: submitting → playing", () => {
    it("transitions to playing when all players have submitted slips", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      rm.handleConnection(ws1, "AB12", "Alice");
      rm.handleConnection(ws2, "AB12", "Bob");

      const room = rm.getRoom("AB12")!;
      room.phase = GamePhase.Submitting;

      // Alice submits
      rm.handleMessage(ws1, {
        type: ClientMessageType.SubmitSlips,
        texts: ["Slip1", "Slip2", "Slip3", "Slip4"],
      });
      expect(room.phase).toBe(GamePhase.Submitting);

      ws1.send.mockClear();
      ws2.send.mockClear();

      // Bob submits — should trigger transition
      rm.handleMessage(ws2, {
        type: ClientMessageType.SubmitSlips,
        texts: ["Slip5", "Slip6", "Slip7", "Slip8"],
      });

      expect(room.phase).toBe(GamePhase.Playing);

      // Slip pool should contain all 8 slips
      expect(room.slipPool).toHaveLength(8);

      // Should have received phase-changed message
      const allMsgs1 = ws1.send.mock.calls.map((c: any) => JSON.parse(c[0]));
      const phaseMsg1 = allMsgs1.find(
        (m: any) => m.type === ServerMessageType.PhaseChanged
      );
      expect(phaseMsg1).toBeDefined();
      expect(phaseMsg1.phase).toBe(GamePhase.Playing);

      const allMsgs2 = ws2.send.mock.calls.map((c: any) => JSON.parse(c[0]));
      const phaseMsg2 = allMsgs2.find(
        (m: any) => m.type === ServerMessageType.PhaseChanged
      );
      expect(phaseMsg2).toBeDefined();
      expect(phaseMsg2.phase).toBe(GamePhase.Playing);
    });

    it("does not transition if not all players have submitted", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      rm.handleConnection(ws1, "AB12", "Alice");
      rm.handleConnection(ws2, "AB12", "Bob");

      const room = rm.getRoom("AB12")!;
      room.phase = GamePhase.Submitting;

      // Only Alice submits
      rm.handleMessage(ws1, {
        type: ClientMessageType.SubmitSlips,
        texts: ["Slip1", "Slip2", "Slip3", "Slip4"],
      });

      expect(room.phase).toBe(GamePhase.Submitting);
      expect(room.slipPool).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Turn Engine
  // ---------------------------------------------------------------------------

  describe("turn engine", () => {
    /** Set up a room in Playing phase with 2 teams and 8 slips in the pool */
    function setupPlayingRoom() {
      vi.useFakeTimers();
      const ws1 = mockWs();
      const ws2 = mockWs();
      const ws3 = mockWs();
      const ws4 = mockWs();
      rm.handleConnection(ws1, "AB12", "Alice"); // host
      rm.handleConnection(ws2, "AB12", "Bob");
      rm.handleConnection(ws3, "AB12", "Carol");
      rm.handleConnection(ws4, "AB12", "Dave");

      const room = rm.getRoom("AB12")!;
      // Assign teams
      room.players[0].team = Team.A; // Alice
      room.players[1].team = Team.A; // Bob
      room.players[2].team = Team.B; // Carol
      room.players[3].team = Team.B; // Dave

      // Set up slips and transition to Playing
      room.phase = GamePhase.Playing;
      const slips: Slip[] = [
        { id: "s1", text: "Einstein", submittedBy: room.players[0].id },
        { id: "s2", text: "Beyoncé", submittedBy: room.players[0].id },
        { id: "s3", text: "Pikachu", submittedBy: room.players[1].id },
        { id: "s4", text: "Cleopatra", submittedBy: room.players[1].id },
        { id: "s5", text: "Mozart", submittedBy: room.players[2].id },
        { id: "s6", text: "Godzilla", submittedBy: room.players[2].id },
        { id: "s7", text: "Sherlock", submittedBy: room.players[3].id },
        { id: "s8", text: "Gandalf", submittedBy: room.players[3].id },
      ];
      room.slipPool = [...slips];
      room.allSlips = [...slips];
      room.activeTeam = Team.A;

      // Clear all mock calls from setup
      ws1.send.mockClear();
      ws2.send.mockClear();
      ws3.send.mockClear();
      ws4.send.mockClear();

      return { ws1, ws2, ws3, ws4, room };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    describe("start-turn", () => {
      it("host sends start-turn; server starts 30s countdown and sends turn-started", () => {
        const { ws1, ws2, room } = setupPlayingRoom();

        const err = rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        expect(err).toBeNull();

        expect(room.phase).toBe(GamePhase.TurnActive);
        expect(room.turnTimeRemaining).toBe(30);
        expect(room.activeClueGiverId).toBe(room.players[0].id); // Alice (Team A, index 0)
        expect(room.currentSlip).toBeDefined();
        expect(room.currentSlip!.id).toBe("s1"); // first unskipped slip

        // All clients get turn-started
        const msg1 = JSON.parse(ws1.send.mock.calls[0][0]);
        expect(msg1.type).toBe(ServerMessageType.TurnStarted);
        expect(msg1.clueGiverId).toBe(room.players[0].id);
        expect(msg1.team).toBe(Team.A);
        expect(msg1.timeRemaining).toBe(30);

        // Clue-giver (Alice, ws1) gets the current slip
        expect(msg1.currentSlip).toBeDefined();
        expect(msg1.currentSlip.id).toBe("s1");

        // Non-clue-giver does NOT get the slip
        const msg2 = JSON.parse(ws2.send.mock.calls[0][0]);
        expect(msg2.type).toBe(ServerMessageType.TurnStarted);
        expect(msg2.currentSlip).toBeUndefined();
      });

      it("non-host cannot start a turn", () => {
        const { ws2 } = setupPlayingRoom();
        const err = rm.handleMessage(ws2, { type: ClientMessageType.StartTurn });
        expect(err).toBe("Only the host can start a turn");
      });

      it("cannot start turn in wrong phase", () => {
        const { ws1, room } = setupPlayingRoom();
        room.phase = GamePhase.Lobby;
        const err = rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        expect(err).toBe("Cannot start a turn in current phase");
      });
    });

    describe("timer-tick", () => {
      it("server sends timer-tick every second to all clients", () => {
        const { ws1, ws2, ws3, ws4 } = setupPlayingRoom();
        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });

        // Clear start-turn messages
        ws1.send.mockClear();
        ws2.send.mockClear();
        ws3.send.mockClear();
        ws4.send.mockClear();

        // Advance 1 second
        vi.advanceTimersByTime(1000);

        // All 4 clients should get timer-tick
        for (const ws of [ws1, ws2, ws3, ws4]) {
          const msg = JSON.parse(ws.send.mock.calls[0][0]);
          expect(msg.type).toBe(ServerMessageType.TimerTick);
          expect(msg.timeRemaining).toBe(29);
        }
      });

      it("turn ends when timer hits 0", () => {
        const { ws1, room } = setupPlayingRoom();
        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        ws1.send.mockClear();

        // Advance 30 seconds
        vi.advanceTimersByTime(30_000);

        expect(room.phase).toBe(GamePhase.TurnEnd);

        // Should have received turn-ended
        const allMsgs = ws1.send.mock.calls.map((c: any) => JSON.parse(c[0]));
        const turnEndedMsg = allMsgs.find(
          (m: any) => m.type === ServerMessageType.TurnEnded
        );
        expect(turnEndedMsg).toBeDefined();
        expect(turnEndedMsg.guessedCount).toBe(0);
      });
    });

    describe("got-it", () => {
      it("awards +1 point and draws next slip", () => {
        const { ws1, room } = setupPlayingRoom();
        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });

        const initialPoolSize = room.slipPool.length;
        ws1.send.mockClear();

        const err = rm.handleMessage(ws1, { type: ClientMessageType.GotIt });
        expect(err).toBeNull();

        expect(room.scores[Team.A]).toBe(1);
        expect(room.slipPool).toHaveLength(initialPoolSize - 1);
        expect(room.turnGuessed).toHaveLength(1);
        expect(room.turnGuessed[0].id).toBe("s1");

        // Next slip drawn
        expect(room.currentSlip).toBeDefined();
        expect(room.currentSlip!.id).toBe("s2");

        // SlipGuessed broadcast
        const allMsgs = ws1.send.mock.calls.map((c: any) => JSON.parse(c[0]));
        const guessedMsg = allMsgs.find(
          (m: any) => m.type === ServerMessageType.SlipGuessed
        );
        expect(guessedMsg).toBeDefined();
        expect(guessedMsg.slip.id).toBe("s1");
        expect(guessedMsg.team).toBe(Team.A);
      });

      it("only clue-giver can send got-it", () => {
        const { ws1, ws2 } = setupPlayingRoom();
        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });

        const err = rm.handleMessage(ws2, { type: ClientMessageType.GotIt });
        expect(err).toBe("Only the clue-giver can do this");
      });

      it("multiple got-its accumulate score", () => {
        const { ws1, room } = setupPlayingRoom();
        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });

        rm.handleMessage(ws1, { type: ClientMessageType.GotIt }); // s1
        rm.handleMessage(ws1, { type: ClientMessageType.GotIt }); // s2
        rm.handleMessage(ws1, { type: ClientMessageType.GotIt }); // s3

        expect(room.scores[Team.A]).toBe(3);
        expect(room.slipPool).toHaveLength(5); // 8 - 3
        expect(room.currentSlip!.id).toBe("s4");
      });
    });

    describe("skip", () => {
      it("moves slip to bottom, deducts 5s, prevents re-draw this turn", () => {
        const { ws1, room } = setupPlayingRoom();
        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });

        expect(room.currentSlip!.id).toBe("s1");
        ws1.send.mockClear();

        const err = rm.handleMessage(ws1, { type: ClientMessageType.Skip });
        expect(err).toBeNull();

        // Time reduced by 5
        expect(room.turnTimeRemaining).toBe(25);

        // s1 is skipped, now showing s2
        expect(room.currentSlip!.id).toBe("s2");
        expect(room.turnSkipped).toContain("s1");

        // Slip stays in pool (moved to bottom)
        expect(room.slipPool.find((s) => s.id === "s1")).toBeDefined();

        // SlipSkipped broadcast
        const allMsgs = ws1.send.mock.calls.map((c: any) => JSON.parse(c[0]));
        const skipMsg = allMsgs.find(
          (m: any) => m.type === ServerMessageType.SlipSkipped
        );
        expect(skipMsg).toBeDefined();

        // TimerTick broadcast with penalty
        const tickMsg = allMsgs.find(
          (m: any) => m.type === ServerMessageType.TimerTick
        );
        expect(tickMsg).toBeDefined();
        expect(tickMsg.timeRemaining).toBe(25);
      });

      it("cannot re-skip — skipped slips are not re-drawn", () => {
        const { ws1, room } = setupPlayingRoom();
        // Use a small pool: 2 slips
        room.slipPool = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
          { id: "s2", text: "Beyoncé", submittedBy: "p1" },
        ];

        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        expect(room.currentSlip!.id).toBe("s1");

        // Skip s1 → should draw s2
        rm.handleMessage(ws1, { type: ClientMessageType.Skip });
        expect(room.currentSlip!.id).toBe("s2");
        expect(room.turnSkipped).toEqual(["s1"]);

        // Skip s2 → all slips skipped, turn should end
        rm.handleMessage(ws1, { type: ClientMessageType.Skip });
        expect(room.phase).toBe(GamePhase.TurnEnd);
      });

      it("only clue-giver can skip", () => {
        const { ws1, ws2 } = setupPlayingRoom();
        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });

        const err = rm.handleMessage(ws2, { type: ClientMessageType.Skip });
        expect(err).toBe("Only the clue-giver can do this");
      });

      it("skip penalty can cause timer to hit 0 and end turn", () => {
        const { ws1, room } = setupPlayingRoom();
        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });

        // Set time low enough that a skip will end the turn
        room.turnTimeRemaining = 3;

        rm.handleMessage(ws1, { type: ClientMessageType.Skip });
        expect(room.turnTimeRemaining).toBe(0);
        expect(room.phase).toBe(GamePhase.TurnEnd);
      });
    });

    describe("turn-end conditions", () => {
      it("turn ends and round ends when all slips in pool are guessed (pool empty)", () => {
        const { ws1, room } = setupPlayingRoom();
        // Small pool: 2 slips
        room.slipPool = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
          { id: "s2", text: "Beyoncé", submittedBy: "p1" },
        ];
        room.allSlips = [...room.slipPool];

        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        rm.handleMessage(ws1, { type: ClientMessageType.GotIt }); // s1
        rm.handleMessage(ws1, { type: ClientMessageType.GotIt }); // s2

        // Pool empty triggers round end (round 1 → round 2)
        expect(room.phase).toBe(GamePhase.RoundEnd);
        // Pool reshuffled with all slips
        expect(room.slipPool).toHaveLength(2);
        expect(room.scores[Team.A]).toBe(2);
      });

      it("turn ends when all remaining slips have been skipped this turn", () => {
        const { ws1, room } = setupPlayingRoom();
        room.slipPool = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
          { id: "s2", text: "Beyoncé", submittedBy: "p1" },
          { id: "s3", text: "Pikachu", submittedBy: "p1" },
        ];

        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });

        rm.handleMessage(ws1, { type: ClientMessageType.Skip }); // skip s1
        rm.handleMessage(ws1, { type: ClientMessageType.Skip }); // skip s2
        rm.handleMessage(ws1, { type: ClientMessageType.Skip }); // skip s3

        expect(room.phase).toBe(GamePhase.TurnEnd);
        // All slips still in pool (just skipped, not removed)
        expect(room.slipPool).toHaveLength(3);
        expect(room.scores[Team.A]).toBe(0);
      });

      it("turn-ended message includes correct guessedCount and scores", () => {
        const { ws1, ws2, room } = setupPlayingRoom();
        // 8 slips in pool (from setupPlayingRoom), guess 2 then let timer expire

        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });

        rm.handleMessage(ws1, { type: ClientMessageType.GotIt }); // s1
        rm.handleMessage(ws1, { type: ClientMessageType.GotIt }); // s2

        ws1.send.mockClear();
        ws2.send.mockClear();

        // Let timer expire to end the turn normally (pool still has 6 slips)
        vi.advanceTimersByTime(30_000);

        // Find TurnEnded in ws2 messages
        const allMsgs = ws2.send.mock.calls.map((c: any) => JSON.parse(c[0]));
        const turnEnded = allMsgs.find(
          (m: any) => m.type === ServerMessageType.TurnEnded
        );
        expect(turnEnded).toBeDefined();
        expect(turnEnded.guessedCount).toBe(2);
        expect(turnEnded.scores[Team.A]).toBe(2);
      });

      it("after turn ends, active team switches and clue-giver index advances", () => {
        const { ws1, room } = setupPlayingRoom();
        expect(room.activeTeam).toBe(Team.A);
        expect(room.clueGiverIndex[Team.A]).toBe(0);

        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });

        // Let timer expire
        vi.advanceTimersByTime(30_000);

        expect(room.phase).toBe(GamePhase.TurnEnd);
        // Team switched to B
        expect(room.activeTeam).toBe(Team.B);
        // Team A clue-giver index advanced
        expect(room.clueGiverIndex[Team.A]).toBe(1);
        expect(room.activeClueGiverId).toBeNull();
      });

      it("can start a new turn after previous turn ended", () => {
        const { ws1, room } = setupPlayingRoom();
        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });

        // End turn via timer
        vi.advanceTimersByTime(30_000);
        expect(room.phase).toBe(GamePhase.TurnEnd);

        // Start next turn
        ws1.send.mockClear();
        const err = rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        expect(err).toBeNull();
        expect(room.phase).toBe(GamePhase.TurnActive);
        // Now Team B's turn, clue-giver should be Carol (index 0 of Team B)
        expect(room.activeTeam).toBe(Team.B);
        const carolId = room.players[2].id;
        expect(room.activeClueGiverId).toBe(carolId);
      });
    });

    // -------------------------------------------------------------------------
    // Round Progression & Game Over
    // -------------------------------------------------------------------------

    describe("round progression", () => {
      it("round ends when slip pool is empty, advancing describe → charades", () => {
        const { ws1, ws2, room } = setupPlayingRoom();
        room.slipPool = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
        ];
        room.allSlips = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
        ];

        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        ws1.send.mockClear();
        ws2.send.mockClear();

        rm.handleMessage(ws1, { type: ClientMessageType.GotIt }); // pool empty

        expect(room.phase).toBe(GamePhase.RoundEnd);
        expect(room.roundNumber).toBe(2);
        expect(room.round).toBe("charades");

        // Pool reshuffled with all slips
        expect(room.slipPool).toHaveLength(1);

        // round-ended message sent
        const allMsgs = ws2.send.mock.calls.map((c: any) => JSON.parse(c[0]));
        const roundEnded = allMsgs.find(
          (m: any) => m.type === ServerMessageType.RoundEnded
        );
        expect(roundEnded).toBeDefined();
        expect(roundEnded.completedRound).toBe("describe");
        expect(roundEnded.nextRound).toBe("charades");
        expect(roundEnded.scores).toBeDefined();
      });

      it("advances charades → one-word", () => {
        const { ws1, room } = setupPlayingRoom();
        room.round = "charades" as any;
        room.roundNumber = 2;
        room.slipPool = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
        ];
        room.allSlips = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
        ];

        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        rm.handleMessage(ws1, { type: ClientMessageType.GotIt });

        expect(room.phase).toBe(GamePhase.RoundEnd);
        expect(room.roundNumber).toBe(3);
        expect(room.round).toBe("one-word");
      });

      it("all slips return to pool and are reshuffled between rounds", () => {
        const { ws1, room } = setupPlayingRoom();
        const allSlips = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
          { id: "s2", text: "Beyoncé", submittedBy: "p1" },
          { id: "s3", text: "Pikachu", submittedBy: "p1" },
        ];
        room.slipPool = [...allSlips];
        room.allSlips = [...allSlips];

        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });

        // Guess all slips to empty the pool
        rm.handleMessage(ws1, { type: ClientMessageType.GotIt }); // s1
        rm.handleMessage(ws1, { type: ClientMessageType.GotIt }); // s2
        rm.handleMessage(ws1, { type: ClientMessageType.GotIt }); // s3

        // All slips back in pool
        expect(room.slipPool).toHaveLength(3);
        const poolIds = room.slipPool.map((s) => s.id).sort();
        expect(poolIds).toEqual(["s1", "s2", "s3"]);
      });

      it("host can start turn from round-end phase", () => {
        const { ws1, room } = setupPlayingRoom();
        room.slipPool = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
        ];
        room.allSlips = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
        ];

        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        rm.handleMessage(ws1, { type: ClientMessageType.GotIt }); // round end

        expect(room.phase).toBe(GamePhase.RoundEnd);

        // Start turn in the new round
        ws1.send.mockClear();
        const err = rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        expect(err).toBeNull();
        expect(room.phase).toBe(GamePhase.TurnActive);
      });

      it("does not switch active team when round ends (carryover team goes first)", () => {
        const { ws1, room } = setupPlayingRoom();
        room.slipPool = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
        ];
        room.allSlips = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
        ];
        room.activeTeam = Team.A;

        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        rm.handleMessage(ws1, { type: ClientMessageType.GotIt }); // round end

        // Team A should still be active (they get carryover turn)
        expect(room.activeTeam).toBe(Team.A);
      });
    });

    describe("carryover time", () => {
      it("carryover time is awarded when last slip guessed mid-turn", () => {
        const { ws1, room } = setupPlayingRoom();
        room.slipPool = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
        ];
        room.allSlips = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
        ];

        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        // Timer starts at 30. Advance 10 seconds, leaving 20.
        vi.advanceTimersByTime(10_000);

        rm.handleMessage(ws1, { type: ClientMessageType.GotIt });

        expect(room.carryoverTime).toBe(20);
      });

      it("turn-ended message includes carryoverTime when round ends mid-turn", () => {
        const { ws1, ws2, room } = setupPlayingRoom();
        room.slipPool = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
        ];
        room.allSlips = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
        ];

        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        vi.advanceTimersByTime(5_000); // 25 seconds remaining
        ws2.send.mockClear();

        rm.handleMessage(ws1, { type: ClientMessageType.GotIt });

        const allMsgs = ws2.send.mock.calls.map((c: any) => JSON.parse(c[0]));
        const turnEnded = allMsgs.find(
          (m: any) => m.type === ServerMessageType.TurnEnded
        );
        expect(turnEnded).toBeDefined();
        expect(turnEnded.carryoverTime).toBe(25);
      });

      it("carryover time is used as turn duration for the next turn in new round", () => {
        const { ws1, room } = setupPlayingRoom();
        room.slipPool = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
        ];
        room.allSlips = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
        ];

        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        vi.advanceTimersByTime(15_000); // 15 seconds remaining

        rm.handleMessage(ws1, { type: ClientMessageType.GotIt }); // round end

        expect(room.carryoverTime).toBe(15);

        // Start next turn — should use carryover time
        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        expect(room.turnTimeRemaining).toBe(15);
        expect(room.carryoverTime).toBe(0); // consumed
      });

      it("no carryover when round ends with timer at 0", () => {
        const { ws1, room } = setupPlayingRoom();
        room.slipPool = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
        ];
        room.allSlips = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
        ];

        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        vi.advanceTimersByTime(29_000); // 1 second remaining
        room.turnTimeRemaining = 0; // simulate exact 0

        rm.handleMessage(ws1, { type: ClientMessageType.GotIt });

        expect(room.carryoverTime).toBe(0);
      });
    });

    describe("game over", () => {
      it("game over after round 3 ends", () => {
        const { ws1, ws2, room } = setupPlayingRoom();
        room.round = "one-word" as any;
        room.roundNumber = 3;
        room.slipPool = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
        ];
        room.allSlips = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
        ];

        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        ws2.send.mockClear();

        rm.handleMessage(ws1, { type: ClientMessageType.GotIt });

        expect(room.phase).toBe(GamePhase.GameOver);

        // Check messages
        const allMsgs = ws2.send.mock.calls.map((c: any) => JSON.parse(c[0]));

        const roundEnded = allMsgs.find(
          (m: any) => m.type === ServerMessageType.RoundEnded
        );
        expect(roundEnded).toBeDefined();
        expect(roundEnded.completedRound).toBe("one-word");
        expect(roundEnded.nextRound).toBeUndefined();

        const gameOver = allMsgs.find(
          (m: any) => m.type === ServerMessageType.GameOver
        );
        expect(gameOver).toBeDefined();
        expect(gameOver.scores[Team.A]).toBe(1);
        expect(gameOver.winner).toBe(Team.A);
      });

      it("game-over message shows correct winner (Team B)", () => {
        const { ws1, ws2, room } = setupPlayingRoom();
        room.round = "one-word" as any;
        room.roundNumber = 3;
        room.scores = { [Team.A]: 3, [Team.B]: 5 };
        room.slipPool = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
        ];
        room.allSlips = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
        ];

        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        ws2.send.mockClear();
        rm.handleMessage(ws1, { type: ClientMessageType.GotIt });

        const allMsgs = ws2.send.mock.calls.map((c: any) => JSON.parse(c[0]));
        const gameOver = allMsgs.find(
          (m: any) => m.type === ServerMessageType.GameOver
        );
        expect(gameOver.winner).toBe(Team.B);
      });

      it("game-over message shows tie when scores are equal", () => {
        const { ws1, ws2, room } = setupPlayingRoom();
        room.round = "one-word" as any;
        room.roundNumber = 3;
        room.scores = { [Team.A]: 5, [Team.B]: 5 };
        room.slipPool = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
        ];
        room.allSlips = [
          { id: "s1", text: "Einstein", submittedBy: "p1" },
        ];
        // Team A active, guessing adds +1 to Team A making it 6-5
        // To get a tie: set A=4, B=5, then A guesses 1 making it 5-5
        room.scores = { [Team.A]: 4, [Team.B]: 5 };

        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        ws2.send.mockClear();
        rm.handleMessage(ws1, { type: ClientMessageType.GotIt });

        const allMsgs = ws2.send.mock.calls.map((c: any) => JSON.parse(c[0]));
        const gameOver = allMsgs.find(
          (m: any) => m.type === ServerMessageType.GameOver
        );
        expect(gameOver.scores[Team.A]).toBe(5);
        expect(gameOver.scores[Team.B]).toBe(5);
        expect(gameOver.winner).toBe("tie");
      });

      it("cannot start turn after game over", () => {
        const { ws1, room } = setupPlayingRoom();
        room.phase = GamePhase.GameOver;
        const err = rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        expect(err).toBe("Cannot start a turn in current phase");
      });
    });

    describe("new-game", () => {
      it("host can start new game after game over, resetting to submitting phase", () => {
        const { ws1, ws2, room } = setupPlayingRoom();
        room.phase = GamePhase.GameOver;
        room.scores = { [Team.A]: 10, [Team.B]: 7 };
        room.roundNumber = 3;
        room.round = "one-word" as any;

        ws1.send.mockClear();
        ws2.send.mockClear();

        const err = rm.handleMessage(ws1, { type: ClientMessageType.NewGame });
        expect(err).toBeNull();

        expect(room.phase).toBe(GamePhase.Submitting);
        expect(room.round).toBe("describe");
        expect(room.roundNumber).toBe(1);
        expect(room.scores[Team.A]).toBe(0);
        expect(room.scores[Team.B]).toBe(0);
        expect(room.slipPool).toHaveLength(0);
        expect(room.allSlips).toHaveLength(0);
        expect(room.carryoverTime).toBe(0);

        // Player slips cleared
        for (const p of room.players) {
          expect(p.slips).toHaveLength(0);
        }

        // Players still in room with teams intact
        expect(room.players).toHaveLength(4);

        // Phase-changed and room-state broadcasts sent
        const allMsgs = ws2.send.mock.calls.map((c: any) => JSON.parse(c[0]));
        const phaseMsg = allMsgs.find(
          (m: any) => m.type === ServerMessageType.PhaseChanged
        );
        expect(phaseMsg).toBeDefined();
        expect(phaseMsg.phase).toBe(GamePhase.Submitting);
      });

      it("non-host cannot start new game", () => {
        const { ws2, room } = setupPlayingRoom();
        room.phase = GamePhase.GameOver;

        const err = rm.handleMessage(ws2, { type: ClientMessageType.NewGame });
        expect(err).toBe("Only the host can start a new game");
      });

      it("cannot start new game unless in game-over phase", () => {
        const { ws1, room } = setupPlayingRoom();
        room.phase = GamePhase.Playing;

        const err = rm.handleMessage(ws1, { type: ClientMessageType.NewGame });
        expect(err).toBe("Can only start a new game after game over");
      });
    });

    describe("start-game", () => {
      /** Helper: add N players to a room, assign teams, return their websockets */
      function fillRoom(rm: RoomManager, code: string, count: number): any[] {
        const sockets: any[] = [];
        const names = ["Alice", "Bob", "Carol", "Dave", "Eve", "Frank", "Grace", "Hank"];
        for (let i = 0; i < count; i++) {
          const ws = mockWs();
          rm.handleConnection(ws, code, names[i]);
          sockets.push(ws);
        }
        const room = rm.getRoom(code)!;
        // Assign teams: first half Team A, rest Team B
        const half = Math.ceil(room.players.length / 2);
        room.players.forEach((p, i) => {
          p.team = i < half ? Team.A : Team.B;
        });
        return sockets;
      }

      it("host transitions room from Lobby to Submitting", () => {
        const sockets = fillRoom(rm, "AB12", MIN_PLAYERS);
        const room = rm.getRoom("AB12")!;
        expect(room.phase).toBe(GamePhase.Lobby);

        sockets.forEach((ws: any) => ws.send.mockClear());

        const err = rm.handleMessage(sockets[0], { type: ClientMessageType.StartGame });
        expect(err).toBeNull();
        expect(room.phase).toBe(GamePhase.Submitting);

        // All clients should receive a phase-changed broadcast
        const msg1 = JSON.parse(sockets[0].send.mock.calls[0][0]);
        expect(msg1.type).toBe(ServerMessageType.PhaseChanged);
        expect(msg1.phase).toBe(GamePhase.Submitting);

        const msg2 = JSON.parse(sockets[1].send.mock.calls[0][0]);
        expect(msg2.type).toBe(ServerMessageType.PhaseChanged);
        expect(msg2.phase).toBe(GamePhase.Submitting);
      });

      it("rejects start-game from non-host player", () => {
        const sockets = fillRoom(rm, "AB12", MIN_PLAYERS);
        const room = rm.getRoom("AB12")!;

        const err = rm.handleMessage(sockets[1], { type: ClientMessageType.StartGame });
        expect(err).toBe("Only the host can start the game");
        expect(room.phase).toBe(GamePhase.Lobby);
      });

      it("rejects start-game when not in Lobby phase", () => {
        const ws1 = mockWs();
        rm.handleConnection(ws1, "AB12", "Alice");
        const room = rm.getRoom("AB12")!;
        room.phase = GamePhase.Submitting;

        const err = rm.handleMessage(ws1, { type: ClientMessageType.StartGame });
        expect(err).toBe("Game can only be started from the lobby");
      });

      it("rejects start-game with fewer than MIN_PLAYERS", () => {
        // Add only MIN_PLAYERS - 1 players
        const count = MIN_PLAYERS - 1;
        const sockets = fillRoom(rm, "AB12", count);
        const room = rm.getRoom("AB12")!;

        const err = rm.handleMessage(sockets[0], { type: ClientMessageType.StartGame });
        expect(err).toBe(`Need at least ${MIN_PLAYERS} players to start (currently ${count})`);
        expect(room.phase).toBe(GamePhase.Lobby);
      });

      it("rejects start-game when a player is unassigned to a team", () => {
        const sockets = fillRoom(rm, "AB12", MIN_PLAYERS);
        const room = rm.getRoom("AB12")!;
        // Unassign the last player
        room.players[room.players.length - 1].team = null;

        const err = rm.handleMessage(sockets[0], { type: ClientMessageType.StartGame });
        expect(err).toBe("All players must be assigned to a team before starting");
        expect(room.phase).toBe(GamePhase.Lobby);
      });

      it("rejects start-game when a team has zero players", () => {
        const sockets = fillRoom(rm, "AB12", MIN_PLAYERS);
        const room = rm.getRoom("AB12")!;
        // Put everyone on Team A
        room.players.forEach((p) => { p.team = Team.A; });

        const err = rm.handleMessage(sockets[0], { type: ClientMessageType.StartGame });
        expect(err).toBe("Both teams must have at least one player");
        expect(room.phase).toBe(GamePhase.Lobby);
      });

      it("allows start-game at exactly MIN_PLAYERS with valid teams", () => {
        const sockets = fillRoom(rm, "AB12", MIN_PLAYERS);
        const room = rm.getRoom("AB12")!;

        const err = rm.handleMessage(sockets[0], { type: ClientMessageType.StartGame });
        expect(err).toBeNull();
        expect(room.phase).toBe(GamePhase.Submitting);
      });
    });

    describe("player count limits", () => {
      it("rejects join-room when room already has MAX_PLAYERS", () => {
        const names = ["Alice", "Bob", "Carol", "Dave", "Eve", "Frank", "Grace", "Hank"];
        for (let i = 0; i < MAX_PLAYERS; i++) {
          const ws = mockWs();
          const err = rm.handleConnection(ws, "AB12", names[i]);
          expect(err).toBeNull();
        }

        const room = rm.getRoom("AB12")!;
        expect(room.players).toHaveLength(MAX_PLAYERS);

        // 9th player should be rejected
        const ws9 = mockWs();
        const err = rm.handleConnection(ws9, "AB12", "Ivy");
        expect(err).toBe("Room is full (maximum 8 players)");
        expect(room.players).toHaveLength(MAX_PLAYERS);
      });

      it("allows joining after a player disconnects from a full room", () => {
        const names = ["Alice", "Bob", "Carol", "Dave", "Eve", "Frank", "Grace", "Hank"];
        const sockets: any[] = [];
        for (let i = 0; i < MAX_PLAYERS; i++) {
          const ws = mockWs();
          rm.handleConnection(ws, "AB12", names[i]);
          sockets.push(ws);
        }

        // Disconnect one player
        rm.handleDisconnect(sockets[7]);

        // Now a new player should be able to join
        const ws9 = mockWs();
        const err = rm.handleConnection(ws9, "AB12", "Ivy");
        expect(err).toBeNull();

        const room = rm.getRoom("AB12")!;
        expect(room.players).toHaveLength(MAX_PLAYERS);
      });

      it("allows exactly MAX_PLAYERS to join", () => {
        const names = ["Alice", "Bob", "Carol", "Dave", "Eve", "Frank", "Grace", "Hank"];
        for (let i = 0; i < MAX_PLAYERS; i++) {
          const ws = mockWs();
          const err = rm.handleConnection(ws, "AB12", names[i]);
          expect(err).toBeNull();
        }

        const room = rm.getRoom("AB12")!;
        expect(room.players).toHaveLength(MAX_PLAYERS);
      });
    });
  });

  describe("player disconnect during gameplay", () => {
    /**
     * Sets up a 4-player room in Playing phase (like setupPlayingRoom in the
     * turn-engine tests) and returns all websockets plus the room.
     */
    function setupGameRoom() {
      vi.useFakeTimers();
      const ws1 = mockWs();
      const ws2 = mockWs();
      const ws3 = mockWs();
      const ws4 = mockWs();
      rm.handleConnection(ws1, "AB12", "Alice"); // host
      rm.handleConnection(ws2, "AB12", "Bob");
      rm.handleConnection(ws3, "AB12", "Carol");
      rm.handleConnection(ws4, "AB12", "Dave");

      const room = rm.getRoom("AB12")!;
      // Assign teams
      room.players[0].team = Team.A; // Alice
      room.players[1].team = Team.A; // Bob
      room.players[2].team = Team.B; // Carol
      room.players[3].team = Team.B; // Dave

      // Set up slips and transition to Playing
      room.phase = GamePhase.Playing;
      const slips: Slip[] = [
        { id: "s1", text: "Einstein", submittedBy: room.players[0].id },
        { id: "s2", text: "Beyoncé", submittedBy: room.players[0].id },
        { id: "s3", text: "Pikachu", submittedBy: room.players[1].id },
        { id: "s4", text: "Cleopatra", submittedBy: room.players[1].id },
        { id: "s5", text: "Mozart", submittedBy: room.players[2].id },
        { id: "s6", text: "Godzilla", submittedBy: room.players[2].id },
        { id: "s7", text: "Sherlock", submittedBy: room.players[3].id },
        { id: "s8", text: "Gandalf", submittedBy: room.players[3].id },
      ];
      room.slipPool = [...slips];
      room.allSlips = [...slips];
      room.activeTeam = Team.A;

      ws1.send.mockClear();
      ws2.send.mockClear();
      ws3.send.mockClear();
      ws4.send.mockClear();

      return { ws1, ws2, ws3, ws4, room };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    describe("clue-giver disconnect", () => {
      it("ends the turn immediately when the active clue-giver disconnects", () => {
        const { ws1, ws2, ws3, ws4, room } = setupGameRoom();

        // Start a turn — Alice (Team A) is clue-giver
        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        expect(room.phase).toBe(GamePhase.TurnActive);
        expect(room.activeClueGiverId).toBe(room.players[0].id); // Alice

        // Clear mocks before disconnect
        ws2.send.mockClear();
        ws3.send.mockClear();
        ws4.send.mockClear();

        // Disconnect Alice (the clue-giver)
        rm.handleDisconnect(ws1);

        // Turn should have ended — phase should be TurnEnd (not TurnActive)
        expect(room.phase).toBe(GamePhase.TurnEnd);
        // Alice should be marked disconnected, not removed
        const alice = room.players.find((p) => p.name === "Alice")!;
        expect(alice.connected).toBe(false);
      });

      it("awards no additional points when clue-giver disconnects mid-turn", () => {
        const { ws1, ws2, ws3, ws4, room } = setupGameRoom();

        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        const scoreBefore = room.scores[Team.A];

        rm.handleDisconnect(ws1);

        // No additional points awarded
        expect(room.scores[Team.A]).toBe(scoreBefore);
      });

      it("clears the turn timer when clue-giver disconnects", () => {
        const { ws1, room } = setupGameRoom();

        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        expect(room.phase).toBe(GamePhase.TurnActive);

        rm.handleDisconnect(ws1);

        // Advancing time should not change anything (timer cleared)
        const phaseAfter = room.phase;
        vi.advanceTimersByTime(35000);
        expect(room.phase).toBe(phaseAfter);
      });
    });

    describe("host disconnect during gameplay", () => {
      it("transfers host to another connected player when host disconnects", () => {
        const { ws1, room } = setupGameRoom();

        expect(room.players[0].isHost).toBe(true); // Alice is host
        rm.handleDisconnect(ws1);

        const alice = room.players.find((p) => p.name === "Alice")!;
        expect(alice.isHost).toBe(false);
        expect(alice.connected).toBe(false);

        // Another connected player should be host
        const connectedHost = room.players.find((p) => p.isHost && p.connected);
        expect(connectedHost).toBeDefined();
      });

      it("preserves disconnected player scores and slips", () => {
        const { ws1, room } = setupGameRoom();

        // Give Alice some slips
        const alice = room.players.find((p) => p.name === "Alice")!;
        alice.slips = [{ id: "test1", text: "Test", submittedBy: alice.id }];

        rm.handleDisconnect(ws1);

        // Alice should still be in the roster with slips preserved
        const aliceAfter = room.players.find((p) => p.name === "Alice")!;
        expect(aliceAfter).toBeDefined();
        expect(aliceAfter.connected).toBe(false);
        expect(aliceAfter.slips).toHaveLength(1);
        expect(aliceAfter.team).toBe(Team.A);
      });
    });

    describe("team-empty pause", () => {
      it("pauses the game when a team has no connected players", () => {
        const { ws3, ws4, room } = setupGameRoom();

        // Disconnect both Team B players (Carol and Dave)
        rm.handleDisconnect(ws3);
        rm.handleDisconnect(ws4);

        expect(room.phase).toBe(GamePhase.Paused);
        expect(room.pausedFromPhase).toBe(GamePhase.Playing);
      });

      it("broadcasts a game-paused message when team becomes empty", () => {
        const { ws1, ws3, ws4, room } = setupGameRoom();
        ws1.send.mockClear();

        rm.handleDisconnect(ws3);
        rm.handleDisconnect(ws4);

        // Find the game-paused message sent to ws1
        const messages = ws1.send.mock.calls.map((c: any) => JSON.parse(c[0]));
        const pausedMsg = messages.find(
          (m: any) => m.type === ServerMessageType.GamePaused,
        );
        expect(pausedMsg).toBeDefined();
        expect(pausedMsg.reason).toContain("Team B");
      });

      it("unpauses the game when a player reconnects to the empty team", () => {
        const { ws3, ws4, room } = setupGameRoom();

        // Disconnect both Team B players
        rm.handleDisconnect(ws3);
        rm.handleDisconnect(ws4);
        expect(room.phase).toBe(GamePhase.Paused);

        // Carol reconnects
        const ws3b = mockWs();
        rm.handleConnection(ws3b, "AB12", "Carol");

        expect(room.phase).toBe(GamePhase.Playing);
        expect(room.pausedFromPhase).toBeNull();
      });

      it("pauses and ends the turn when clue-giver's entire team disconnects mid-turn", () => {
        const { ws1, ws2, room } = setupGameRoom();

        // Start a turn — Team A active
        rm.handleMessage(ws1, { type: ClientMessageType.StartTurn });
        expect(room.phase).toBe(GamePhase.TurnActive);

        // Disconnect both Team A players (Alice and Bob)
        rm.handleDisconnect(ws1); // clue-giver disconnect ends turn
        rm.handleDisconnect(ws2); // team now empty → pause

        expect(room.phase).toBe(GamePhase.Paused);
        // The turn should have been ended
        expect(room.activeClueGiverId).toBeNull();
      });
    });

    describe("lobby disconnect still removes players", () => {
      it("removes the player entirely when disconnecting in lobby phase", () => {
        const ws1 = mockWs();
        const ws2 = mockWs();
        rm.handleConnection(ws1, "AB12", "Alice");
        rm.handleConnection(ws2, "AB12", "Bob");

        rm.handleDisconnect(ws2);

        const room = rm.getRoom("AB12")!;
        expect(room.players).toHaveLength(1);
        expect(room.players.find((p) => p.name === "Bob")).toBeUndefined();
      });
    });

    describe("reconnection", () => {
      it("reconnects a disconnected player preserving team and slips", () => {
        const { ws1, room } = setupGameRoom();
        const alice = room.players.find((p) => p.name === "Alice")!;
        const aliceId = alice.id;

        rm.handleDisconnect(ws1);
        expect(alice.connected).toBe(false);

        // Alice reconnects
        const ws1b = mockWs();
        rm.handleConnection(ws1b, "AB12", "Alice");

        expect(alice.connected).toBe(true);
        expect(alice.id).toBe(aliceId); // same player record
        expect(alice.team).toBe(Team.A);
      });
    });
  });
});

