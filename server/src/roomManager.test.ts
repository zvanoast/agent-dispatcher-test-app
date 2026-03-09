import { describe, it, expect, beforeEach, vi } from "vitest";
import { RoomManager } from "./roomManager.js";
import { GamePhase, ServerMessageType } from "@fishbowl/shared";

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
});
