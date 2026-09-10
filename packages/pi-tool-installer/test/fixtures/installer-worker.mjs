import { ToolInstaller } from "../../dist/index.js";

const [directory, operation, serialized, interrupt] = process.argv.slice(2);
const installer = new ToolInstaller(directory);
const request = JSON.parse(serialized);
const options = {
  allowDownload: true,
  onProgress(message) {
    process.stderr.write(`${message}\n`, () => {
      // Flush evidence, then bypass cleanup to exercise a dead owner's heartbeat lock.
      if (interrupt && message.includes(interrupt)) process.kill(process.pid, "SIGKILL");
    });
  },
};
const result =
  operation === "update"
    ? await installer.update(request, options)
    : await installer.ensure(request, options);
console.log(JSON.stringify(result));
