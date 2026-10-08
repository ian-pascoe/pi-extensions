import { delimiter, isAbsolute } from "node:path";
import { afterEach, beforeEach } from "vitest";

/** Variables that keep `cd`, `git`, or every program from being a Safe Command. */
function affectsSafeCommands(name: string): boolean {
  return (
    name.startsWith("GIT_") ||
    name.startsWith("BASH_FUNC_") ||
    ["BASH_ENV", "ENV", "BASHOPTS", "SHELLOPTS", "CDPATH"].includes(name)
  );
}

/**
 * Run each test of the calling file with this process's environment cleared of what keeps Safe
 * Commands from being safe (git variables set by a hook or CI, startup files, relative `PATH`
 * entries), so tests do not depend on where they run.
 */
export function useCleanShellEnvironment(): void {
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const name of Object.keys(process.env))
      if (affectsSafeCommands(name)) {
        saved.set(name, process.env[name]);
        Reflect.deleteProperty(process.env, name);
      }
    const path = process.env["PATH"];
    if (path !== undefined) {
      saved.set("PATH", path);
      process.env["PATH"] = path.split(delimiter).filter(isAbsolute).join(delimiter);
    }
  });
  afterEach(() => {
    for (const [name, value] of saved)
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    saved.clear();
  });
}
