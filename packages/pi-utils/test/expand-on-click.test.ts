import { CustomMessageComponent, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  MouseRegion,
  Text,
  type Component,
  type TuiMouseButton,
  type TuiMouseEvent,
  type TuiMouseEventType,
} from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { expandMessageOnClick } from "../src/ui.js";
import { expectClickToggles, keybindingHints } from "../src/ui-testing.js";

beforeAll(() => initTheme("dark"));

type Message = ConstructorParameters<typeof CustomMessageComponent>[0];

// SAFETY: the renderers under test never call the theme, and Pi exports no Theme instance.
const theme = {} as Theme;
const collapsed = { ...keybindingHints, expanded: false, outputPad: 1 };
const expandedOptions = { ...keybindingHints, expanded: true, outputPad: 1 };

/** A fresh message; Pi passes the renderer the same object each time it rebuilds that message. */
const message = (): Message => ({
  role: "custom",
  customType: "demo",
  content: "demo",
  display: true,
  timestamp: 0,
});

function mouse(
  y: number,
  height: number,
  type: TuiMouseEventType = "click",
  button: TuiMouseButton = "left",
): TuiMouseEvent {
  return {
    type,
    button,
    x: 0,
    y,
    screenX: 0,
    screenY: y,
    width: 40,
    height,
    shift: false,
    alt: false,
    ctrl: false,
    clickCount: 1,
  };
}

/** Collapsed: one line. Expanded: two lines. */
function view<Rendered>(_item: Rendered, { expanded }: { expanded: boolean }): Component {
  return new Text(expanded ? "full\nbody" : "short", 0, 0);
}

const lines = (component: Component | undefined) =>
  component?.render(40).map((line) => line.trim()) ?? [];

function click(component: Component | undefined, y = 0) {
  return component?.handleMouse?.(mouse(y, component.render(40).length));
}

describe("expandMessageOnClick", () => {
  it("toggles between the Collapsed and Expanded View on each left click", () => {
    const component = expandMessageOnClick(view)(message(), collapsed, theme);
    expect(lines(component)).toEqual(["short"]);
    expect(click(component)).toEqual({ handled: true });
    expect(lines(component)).toEqual(["full", "body"]);
    click(component, 1);
    expect(lines(component)).toEqual(["short"]);
  });

  it("ignores anything but a left click", () => {
    const component = expandMessageOnClick(view)(message(), collapsed, theme);
    expect(component?.handleMouse?.(mouse(0, 1, "click", "right"))).toBeUndefined();
    expect(component?.handleMouse?.(mouse(0, 1, "move", "none"))).toBeUndefined();
    expect(lines(component)).toEqual(["short"]);
  });

  it("leaves a click to content that handles it itself", () => {
    const linked = (_message: Message, { expanded }: { expanded: boolean }) =>
      new MouseRegion(new Text(expanded ? "full" : "short", 0, 0), () => ({ handled: true }));
    const component = expandMessageOnClick(linked)(message(), collapsed, theme);
    expect(click(component)).toMatchObject({ handled: true });
    expect(lines(component)).toEqual(["short"]);
  });

  it("keeps a clicked message's view when Pi rebuilds it, and only that message's", () => {
    const render = expandMessageOnClick(view);
    const clicked = message();
    click(render(clicked, collapsed, theme));
    // Pi rebuilds message and entry components on invalidation with its own expanded flag.
    expect(lines(render(clicked, collapsed, theme))).toEqual(["full", "body"]);
    expect(lines(render(message(), collapsed, theme))).toEqual(["short"]);
  });

  it("lets ctrl+o reset every message, as it does Pi's tool rows", () => {
    const render = expandMessageOnClick(view);
    const clicked = message();
    click(render(clicked, collapsed, theme));
    expect(lines(render(clicked, expandedOptions, theme))).toEqual(["full", "body"]);
    expect(lines(render(clicked, collapsed, theme))).toEqual(["short"]);
  });

  it("passes through a renderer that falls back to Pi's default", () => {
    expect(expandMessageOnClick(() => undefined)(message(), collapsed, theme)).toBeUndefined();
  });
});

describe("expectClickToggles", () => {
  it("fails for a renderer that ignores clicks", () => {
    expect(() => expectClickToggles(view, message(), collapsed, theme)).toThrow(
      /did not handle a left click/,
    );
  });

  it("fails when a click does not show the other view", () => {
    const stuck = expandMessageOnClick((_message: Message, { expanded }: { expanded: boolean }) =>
      expanded
        ? new Text("other", 0, 0)
        : new MouseRegion(new Text("short", 0, 0), () => ({ handled: true })),
    );
    expect(() => expectClickToggles(stuck, message(), collapsed, theme)).toThrow(
      /did not show the other view/,
    );
  });
});

describe("inside Pi's CustomMessageComponent", () => {
  it("toggles a renderer wrapped with expandMessageOnClick", () => {
    const host = new CustomMessageComponent(message(), expandMessageOnClick(view));
    expect(lines(host)).toEqual(["", "short"]);
    expect(click(host, 1)).toMatchObject({ handled: true });
    expect(lines(host)).toEqual(["", "full", "body"]);
  });
});
