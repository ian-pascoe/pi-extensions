import { describe, expect, test } from "vitest";
import {
  resolveTermctrlSettings,
  type TermctrlSettingsDocumentInput,
} from "../src/termctrl-settings.js";

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
});
