import type { ClientMessage, ServerMessage } from "@fishbowl/shared";

export type MessageHandler = (msg: ServerMessage) => void;
export type StatusHandler = (status: "connecting" | "connected" | "disconnected") => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private onMessage: MessageHandler;
  private onStatus: StatusHandler;

  constructor(onMessage: MessageHandler, onStatus: StatusHandler) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
  }

  connect(roomCode: string, playerName: string): void {
    this.disconnect();
    this.onStatus("connecting");

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const host = location.hostname;
    const port = location.port === "5173" ? "3000" : location.port;
    const url = `${protocol}//${host}:${port}/ws?room=${encodeURIComponent(roomCode)}&name=${encodeURIComponent(playerName)}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.onStatus("connected");
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data as string);
        this.onMessage(msg);
      } catch {
        console.error("Failed to parse server message:", event.data);
      }
    };

    this.ws.onclose = () => {
      this.onStatus("disconnected");
    };

    this.ws.onerror = () => {
      // onclose will fire after this
    };
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
