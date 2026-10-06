import { describe, expect, test } from "vitest";
import {
  resolveTermctrlSettings,
  type TermctrlSettingsDocumentInput,
} from "../src/pi-termctrl-settings.js";

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

  describe("bashTail", () => {
    const tail = (
      termctrl: TermctrlSettingsDocumentInput,
      project?: TermctrlSettingsDocumentInput,
    ) => resolveTermctrlSettings(reader(termctrl, project));

    test("layers lines and bytes field by field", () => {
      const settings = tail(
        { termctrl: { bashTail: { lines: 100, bytes: 4096 } } },
        { termctrl: { bashTail: { lines: 50 } } },
      );
      expect(settings.bashTail).toEqual({ maxLines: 50, maxBytes: 4096 });
      expect(settings.warnings).toEqual([]);
    });

    test.each([0, false])("%j opts out and restores Pi's limits", (optOut) => {
      const settings = tail({ termctrl: { bashTail: optOut } });
      expect(settings.bashTail).toBeUndefined();
      expect(settings.warnings).toEqual([]);
    });

    test("a project opt-out beats a global tail, and true re-enables the defaults", () => {
      expect(
        tail({ termctrl: { bashTail: { lines: 10 } } }, { termctrl: { bashTail: false } }).bashTail,
      ).toBeUndefined();
      expect(
        tail({ termctrl: { bashTail: false } }, { termctrl: { bashTail: true } }).bashTail,
      ).toEqual({ maxLines: 300, maxBytes: 16_384 });
    });

    test("warns for invalid values and keeps the lower layer", () => {
      const settings = tail(
        { termctrl: { bashTail: { lines: 120 } } },
        {
          termctrl: {
            bashTail: { lines: 0, bytes: 2.5, depth: 1 },
          },
        },
      );
      expect(settings.bashTail).toEqual({ maxLines: 120, maxBytes: 16_384 });
      expect(settings.warnings).toEqual([
        "project termctrl.bashTail.lines: expected an integer from 1 to 2000",
        "project termctrl.bashTail.bytes: expected an integer from 1 to 51200",
        "project termctrl.bashTail.depth: unknown field",
      ]);
      // Only invalid fields: a lower layer's opt-out stays.
      expect(
        tail({ termctrl: { bashTail: false } }, { termctrl: { bashTail: { lines: 0 } } }).bashTail,
      ).toBeUndefined();
      expect(tail({ termctrl: { bashTail: "small" } }).warnings).toEqual([
        "global termctrl.bashTail: expected a boolean, 0, or a JSON object",
      ]);
      expect(tail({ termctrl: { bashTail: 5 } }).warnings).toEqual([
        "global termctrl.bashTail: expected a boolean, 0, or a JSON object",
      ]);
      expect(tail({ termctrl: { bashTail: { lines: 5000 } } }).warnings).toEqual([
        "global termctrl.bashTail.lines: expected an integer from 1 to 2000",
      ]);
    });
  });
});
