import {
  ClientMessageType,
  ServerMessageType,
  type ServerMessage,
  type Room,
  type Player,
} from "../../shared/src/types.js";

type Screen = "landing" | "lobby";

export class App {
  private root: HTMLElement;
  private ws: WebSocket | null = null;
  private screen: Screen = "landing";
  private room: Room | null = null;
  private myPlayerId: string | null = null;
  private roomCode: string | null = null;
  private error: string | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  mount(): void {
    this.render();
  }

  private connectWebSocket(): void {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    this.ws = new WebSocket(wsUrl);

    this.ws.addEventListener("open", () => {
      this.error = null;
      this.render();
    });

    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data as string) as ServerMessage;
      this.handleServerMessage(msg);
    });

    this.ws.addEventListener("close", () => {
      this.ws = null;
      this.error = "Disconnected from server";
      this.render();
    });

    this.ws.addEventListener("error", () => {
      this.error = "Connection error";
      this.render();
    });
  }

  private send(data: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case ServerMessageType.RoomCreated:
        this.roomCode = msg.roomCode;
        break;

      case ServerMessageType.RoomState:
        this.room = msg.room;
        this.roomCode = msg.room.code;
        this.screen = "lobby";
        this.error = null;
        break;

      case ServerMessageType.PlayerJoined:
        if (this.room) {
          this.room.players.push(msg.player);
        }
        break;

      case ServerMessageType.PlayerLeft:
        if (this.room) {
          this.room.players = this.room.players.filter((p) => p.id !== msg.playerId);
        }
        break;

      case ServerMessageType.Error:
        this.error = msg.message;
        break;
    }

    this.render();
  }

  private handleCreateRoom(name: string): void {
    this.connectWebSocket();
    this.ws!.addEventListener("open", () => {
      this.myPlayerId = null; // Will be set from room state
      this.send({ type: ClientMessageType.CreateRoom, playerName: name });
    });
  }

  private handleJoinRoom(name: string, code: string): void {
    this.connectWebSocket();
    this.ws!.addEventListener("open", () => {
      this.send({
        type: ClientMessageType.JoinRoom,
        playerName: name,
        roomCode: code,
      });
    });
  }

  private render(): void {
    switch (this.screen) {
      case "landing":
        this.renderLanding();
        break;
      case "lobby":
        this.renderLobby();
        break;
    }
  }

  private renderLanding(): void {
    this.root.innerHTML = `
      <div class="container">
        <h1>Fishbowl</h1>
        <p class="subtitle">The party game for friends</p>

        ${this.error ? `<div class="error">${this.escapeHtml(this.error)}</div>` : ""}

        <div class="card">
          <h2>Create a Room</h2>
          <form id="create-form">
            <input type="text" id="create-name" placeholder="Your name" maxlength="20" required />
            <button type="submit">Create Room</button>
          </form>
        </div>

        <div class="divider">or</div>

        <div class="card">
          <h2>Join a Room</h2>
          <form id="join-form">
            <input type="text" id="join-name" placeholder="Your name" maxlength="20" required />
            <input type="text" id="join-code" placeholder="Room code" maxlength="4" required
              style="text-transform: uppercase" />
            <button type="submit">Join Room</button>
          </form>
        </div>
      </div>
    `;

    this.root.querySelector("#create-form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = (this.root.querySelector("#create-name") as HTMLInputElement).value.trim();
      if (name) this.handleCreateRoom(name);
    });

    this.root.querySelector("#join-form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = (this.root.querySelector("#join-name") as HTMLInputElement).value.trim();
      const code = (this.root.querySelector("#join-code") as HTMLInputElement).value.trim();
      if (name && code) this.handleJoinRoom(name, code);
    });
  }

  private renderLobby(): void {
    const players = this.room?.players ?? [];
    const isHost = players.find((p) => p.isHost);

    this.root.innerHTML = `
      <div class="container">
        <h1>Fishbowl</h1>

        <div class="room-code-display">
          <span class="label">Room Code</span>
          <span class="code">${this.escapeHtml(this.roomCode ?? "")}</span>
        </div>

        ${this.error ? `<div class="error">${this.escapeHtml(this.error)}</div>` : ""}

        <div class="card">
          <h2>Players (${players.length}/8)</h2>
          <ul class="player-list">
            ${players
              .map(
                (p) => `
              <li class="player-item">
                <span class="player-name">${this.escapeHtml(p.name)}</span>
                ${p.isHost ? '<span class="host-badge">Host</span>' : ""}
                <span class="status-dot ${p.connected ? "connected" : "disconnected"}"></span>
              </li>
            `,
              )
              .join("")}
          </ul>
        </div>

        <p class="waiting-text">Waiting for players to join...</p>
        <p class="share-text">Share the room code with your friends!</p>
      </div>
    `;
  }

  private escapeHtml(str: string): string {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
}
