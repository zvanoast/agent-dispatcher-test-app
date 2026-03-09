import { describe, it, expect, beforeEach, vi } from "vitest";
import { RoomManager } from "./roomManager.js";
import { GamePhase, ServerMessageType, ClientMessageType, Team } from "@fishbowl/shared";

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
});
