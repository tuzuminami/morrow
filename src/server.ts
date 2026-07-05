import { createMorrowApiServer } from "./http-api.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const server = createMorrowApiServer();

server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "morrow.api.started", port }));
});
