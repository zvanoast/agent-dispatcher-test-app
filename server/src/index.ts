import Fastify from "fastify";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

const app = Fastify({ logger: true });

app.get("/health", async () => {
  return { status: "ok" };
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
