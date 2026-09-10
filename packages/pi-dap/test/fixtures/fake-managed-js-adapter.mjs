import { createServer } from "node:net";
import { spawn } from "node:child_process";

const server = createServer((socket) => {
  const child = spawn(process.execPath, [process.env.PI_DAP_FIXTURE], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  socket.pipe(child.stdin);
  child.stdout.pipe(socket);
  socket.on("close", () => child.kill());
  child.on("close", () => server.close(() => process.exit(0)));
});
server.listen(Number(process.argv[2]), process.argv[3]);
