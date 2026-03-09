import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { handleConnection } from "./wsHandler.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const app = Fastify({ logger: true });

await app.register(websocket);

app.get("/health", async () => {
  return { status: "ok" };
});

app.get("/ws", { websocket: true }, (socket) => {
  handleConnection(socket);
});

async function start(): Promise<void> {
  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
    app.log.info(`Server listening on port ${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
