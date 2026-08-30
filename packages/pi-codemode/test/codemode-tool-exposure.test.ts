import { describe, expect, test } from "vitest";
import {
  decideCodeModeToolExposure,
  installCodeModeToolExposure,
  type CodeModeActiveToolOwner,
} from "../src/codemode-tool-exposure.js";
import { resolveCodeModeSettings } from "../src/pi-codemode-settings.js";

class RecordingActiveToolOwner implements CodeModeActiveToolOwner {
  readonly calls: string[][] = [];
  activeNames: string[];

  constructor(activeNames: readonly string[]) {
    this.activeNames = [...activeNames];
  }

  getActiveToolNames(): string[] {
    return [...this.activeNames];
  }

  setActiveToolsByName(names: string[]): void {
    this.activeNames = [...names];
    this.calls.push([...names]);
  }
}

describe("decideCodeModeToolExposure", () => {
  test("defaults requested tools to both interfaces and keeps inactive tools unavailable", () => {
    expect(
      decideCodeModeToolExposure(
        [
          "active",
          "inactive",
          "codemode_execute",
          "codemode_result",
          "codemode_cancel",
          "codemode_sessions",
          "codemode_search",
        ],
        ["active"],
        [],
      ),
    ).toEqual({
      codeModeNames: ["active"],
      directNames: [
        "active",
        "codemode_execute",
        "codemode_result",
        "codemode_cancel",
        "codemode_sessions",
        "codemode_search",
      ],
      unavailableNames: ["inactive"],
    });
  });

  test("does not reactivate a replaced shell tool through an exposure rule", () => {
    const settings = resolveCodeModeSettings({
      getGlobalSettings: () => ({
        codemode: {
          tools: [
            { pattern: "*", exposure: "codemode-only" },
            { pattern: "bash", exposure: "direct-and-codemode" },
            { pattern: "exec_command", exposure: "direct-and-codemode" },
            { pattern: "write_stdin", exposure: "direct-and-codemode" },
          ],
        },
      }),
      getProjectSettings: () => ({}),
    });
    expect(settings.enabled).toBe(true);
    if (!settings.enabled) return;

    expect(
      decideCodeModeToolExposure(
        ["bash", "exec_command", "write_stdin", "read"],
        ["exec_command", "write_stdin", "read"],
        settings.rules,
      ),
    ).toEqual({
      codeModeNames: ["exec_command", "write_stdin", "read"],
      directNames: ["exec_command", "write_stdin"],
      unavailableNames: ["bash"],
    });
  });

  test("applies case-sensitive minimatch rules in last-match order to active tools", () => {
    const settings = resolveCodeModeSettings({
      getGlobalSettings: () => ({
        codemode: {
          tools: [
            { pattern: "*", exposure: "codemode-only" },
            { pattern: "bash", exposure: "direct-and-codemode" },
            { pattern: "browser_*", exposure: "direct-only" },
          ],
        },
      }),
      getProjectSettings: () => ({}),
    });
    expect(settings.enabled).toBe(true);
    if (!settings.enabled) return;

    expect(
      decideCodeModeToolExposure(
        ["bash", "Bash", "browser_open", "read"],
        ["bash", "Bash", "browser_open", "read"],
        settings.rules,
      ),
    ).toEqual({
      codeModeNames: ["bash", "Bash", "read"],
      directNames: ["bash", "browser_open"],
      unavailableNames: [],
    });
  });
});

describe("installCodeModeToolExposure", () => {
  test("wraps an inherited active-set method and restores pre-policy requested names", () => {
    const owner = new RecordingActiveToolOwner(["active", "forced"]);
    const registryNames = ["active", "forced", "inactive"];
    const settings = resolveCodeModeSettings({
      getGlobalSettings: () => ({
        codemode: {
          tools: [
            { pattern: "active", exposure: "codemode-only" },
            { pattern: "forced", exposure: "direct-only" },
          ],
        },
      }),
      getProjectSettings: () => ({}),
    });
    expect(settings.enabled).toBe(true);
    if (!settings.enabled) return;

    const installed = installCodeModeToolExposure(owner, () => registryNames, settings.rules);

    expect(Object.hasOwn(owner, "setActiveToolsByName")).toBe(true);
    expect(owner.activeNames).toEqual(["forced"]);
    owner.setActiveToolsByName(["inactive"]);
    expect(owner.activeNames).toEqual(["inactive"]);
    expect(installed.getDecision()).toEqual({
      codeModeNames: ["inactive"],
      directNames: ["inactive"],
      unavailableNames: ["active", "forced"],
    });

    installed.restore();

    expect(Object.hasOwn(owner, "setActiveToolsByName")).toBe(false);
    expect(owner.activeNames).toEqual(["inactive"]);
  });

  test("distinguishes registry refreshes from external active-set selections", () => {
    const owner = new RecordingActiveToolOwner(["first"]);
    let registryNames = ["first"];
    const installed = installCodeModeToolExposure(owner, () => registryNames, []);

    registryNames = ["first", "new"];
    owner.setActiveToolsByName(["first", "new"]);
    expect(installed.getDecision().directNames).toEqual(["first", "new"]);

    owner.setActiveToolsByName(["new"]);
    registryNames = ["first", "third"];
    owner.setActiveToolsByName(["first", "third"]);
    expect(installed.getDecision().directNames).toEqual(["third"]);

    installed.restore();
    expect(owner.activeNames).toEqual(["third"]);
  });

  test("coalesces a reentrant registry refresh into the latest decision notification", () => {
    const owner = new RecordingActiveToolOwner(["first"]);
    let registryNames = ["first"];
    const notifications: string[][] = [];

    const installed = installCodeModeToolExposure(
      owner,
      () => registryNames,
      [],
      (decision) => {
        notifications.push([...decision.directNames]);
        if (notifications.length === 1) {
          registryNames = ["first", "second"];
          owner.setActiveToolsByName(["first", "second"]);
        }
      },
    );

    expect(notifications).toEqual([["first"], ["first", "second"]]);
    expect(installed.getDecision().directNames).toEqual(["first", "second"]);
    installed.restore();
  });

  test("retains the last coherent direct and guest sets when a candidate is rejected", () => {
    const owner = new RecordingActiveToolOwner(["first"]);
    let registryNames = ["first"];
    const notifications: string[][] = [];
    const installed = installCodeModeToolExposure(
      owner,
      () => registryNames,
      [],
      (decision) => notifications.push([...decision.codeModeNames]),
      (decision) => !decision.codeModeNames.includes("rejected"),
    );

    registryNames = ["first", "rejected"];
    owner.setActiveToolsByName(["first", "rejected"]);

    expect(owner.activeNames).toEqual(["first"]);
    expect(installed.getDecision().codeModeNames).toEqual(["first"]);
    expect(notifications).toEqual([["first"]]);
    installed.restore();
    expect(owner.activeNames).toEqual(["first", "rejected"]);
  });
});
