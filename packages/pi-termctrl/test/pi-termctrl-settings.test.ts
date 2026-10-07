import { describe, expect, test } from "vitest";
import {
  resolveTermctrlSettings,
  type TermctrlSettingsDocumentInput,
} from "../src/pi-termctrl-settings.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function reader(
  globalSettings: TermctrlSettingsDocumentInput,
  projectSettings: TermctrlSettingsDocumentInput = {},
) {
  return {
    getGlobalSettings: () => globalSettings,
    getProjectSettings: () => projectSettings,
  };
}

describe("resolveTermctrlSettings", () => {
  test("uses the documented defaults when nothing is configured", () => {
    expect(resolveTermctrlSettings(reader({}))).toEqual({
      replaceBash: true,
      defaultViewport: { cols: 120, rows: 40 },
      exitTailLines: 20,
      bashTail: { maxLines: 300, maxBytes: 16_384 },
      scrollback: { maxLines: 100, maxBytes: 16_384 },
      warnings: [],
    });
  });

  test("layers project values over global values field by field", () => {
    const settings = resolveTermctrlSettings(
      reader(
        { termctrl: { replaceBash: false, defaultViewport: { cols: 80, rows: 24 } } },
        { termctrl: { defaultViewport: { rows: 50 }, exitTailLines: 5 } },
      ),
    );
    expect(settings).toEqual({
      replaceBash: false,
      defaultViewport: { cols: 80, rows: 50 },
      exitTailLines: 5,
      bashTail: { maxLines: 300, maxBytes: 16_384 },
      scrollback: { maxLines: 100, maxBytes: 16_384 },
      warnings: [],
    });
  });

  test("keeps the lower layer and warns for invalid values", () => {
    const settings = resolveTermctrlSettings(
      reader(
        { termctrl: { exitTailLines: 7 } },
        {
          termctrl: {
            replaceBash: "yes",
            defaultViewport: { cols: 0, rows: 2.5 },
            exitTailLines: -1,
          },
        },
      ),
    );
    expect(settings.replaceBash).toBe(true);
    expect(settings.defaultViewport).toEqual({ cols: 120, rows: 40 });
    expect(settings.exitTailLines).toBe(7);
    expect(settings.warnings).toEqual([
      "project termctrl.replaceBash: expected a boolean",
      "project termctrl.defaultViewport.cols: expected an integer from 1 to 1000",
      "project termctrl.defaultViewport.rows: expected an integer from 1 to 1000",
      "project termctrl.exitTailLines: expected an integer from 0 to 1000",
    ]);
  });

  test("warns for unknown keys and non-object sections", () => {
    const settings = resolveTermctrlSettings(
      reader(
        { termctrl: { replaceBash: true, shell: "zsh", defaultViewport: { cols: 90, depth: 3 } } },
        { termctrl: "on" },
      ),
    );
    expect(settings.defaultViewport).toEqual({ cols: 90, rows: 40 });
    expect(settings.warnings).toEqual([
      "global termctrl.shell: unknown field",
      "global termctrl.defaultViewport.depth: unknown field",
      "project termctrl: expected a JSON object",
    ]);
  });

  test("warns when defaultViewport is not an object", () => {
    const settings = resolveTermctrlSettings(reader({ termctrl: { defaultViewport: [80, 24] } }));
    expect(settings.defaultViewport).toEqual({ cols: 120, rows: 40 });
    expect(settings.warnings).toEqual(["global termctrl.defaultViewport: expected a JSON object"]);
  });

  describe.each([
    { key: "bashTail", defaults: { maxLines: 300, maxBytes: 16_384 } },
    { key: "scrollback", defaults: { maxLines: 100, maxBytes: 16_384 } },
  ] as const)("$key", ({ key, defaults }) => {
    const resolve = (global: JsonValue, project?: JsonValue) =>
      resolveTermctrlSettings(
        reader(
          { termctrl: { [key]: global } },
          project === undefined ? {} : { termctrl: { [key]: project } },
        ),
      );

    test("layers lines and bytes field by field", () => {
      const settings = resolve({ lines: 100, bytes: 4096 }, { lines: 50 });
      expect(settings[key]).toEqual({ maxLines: 50, maxBytes: 4096 });
      expect(settings.warnings).toEqual([]);
    });

    test.each([0, false])("%j opts out and restores Pi's limits", (optOut) => {
      const settings = resolve(optOut);
      expect(settings[key]).toBeUndefined();
      expect(settings.warnings).toEqual([]);
    });

    test("a project opt-out beats a global limit, and true re-enables the defaults", () => {
      expect(resolve({ lines: 10 }, false)[key]).toBeUndefined();
      expect(resolve(false, true)[key]).toEqual(defaults);
    });

    test("warns for invalid values and keeps the lower layer", () => {
      const settings = resolve({ lines: 120 }, { lines: 0, bytes: 2.5, depth: 1 });
      expect(settings[key]).toEqual({ maxLines: 120, maxBytes: defaults.maxBytes });
      expect(settings.warnings).toEqual([
        `project termctrl.${key}.lines: expected an integer from 1 to 2000`,
        `project termctrl.${key}.bytes: expected an integer from 1 to 51200`,
        `project termctrl.${key}.depth: unknown field`,
      ]);
      // Only invalid fields: a lower layer's opt-out stays.
      expect(resolve(false, { lines: 0 })[key]).toBeUndefined();
      expect(resolve("small").warnings).toEqual([
        `global termctrl.${key}: expected a boolean, 0, or a JSON object`,
      ]);
      expect(resolve(5).warnings).toEqual([
        `global termctrl.${key}: expected a boolean, 0, or a JSON object`,
      ]);
      expect(resolve({ lines: 5000 }).warnings).toEqual([
        `global termctrl.${key}.lines: expected an integer from 1 to 2000`,
      ]);
    });
  });
});
