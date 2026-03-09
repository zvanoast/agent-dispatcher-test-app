import "dotenv/config";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { RoomManager } from "./roomManager.js";
import { ServerMessageType, type ClientMessage } from "@fishbowl/shared";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

const app = Fastify({ logger: true });
const roomManager = new RoomManager();

await app.register(websocket);

app.get("/health", async () => {
  return { status: "ok" };
});

app.get("/ws", { websocket: true }, (socket, req) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const roomCode = (url.searchParams.get("room") ?? "").toUpperCase();
  const playerName = url.searchParams.get("name") ?? "";

  const error = roomManager.handleConnection(socket, roomCode, playerName);
  if (error) {
    socket.send(
      JSON.stringify({ type: ServerMessageType.Error, message: error })
    );
    socket.close(1008, error);
    return;
  }

  socket.on("message", (data: Buffer | string) => {
    try {
      const msg: ClientMessage = JSON.parse(
        typeof data === "string" ? data : data.toString()
      );
      const err = roomManager.handleMessage(socket, msg);
      if (err) {
        socket.send(
          JSON.stringify({ type: ServerMessageType.Error, message: err })
        );
      }
    } catch {
      socket.send(
        JSON.stringify({ type: ServerMessageType.Error, message: "Invalid message format" })
      );
    }
  });

  socket.on("close", () => {
    roomManager.handleDisconnect(socket);
  });
});

async function start() {
  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
    app.log.info(`Server listening on port ${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
