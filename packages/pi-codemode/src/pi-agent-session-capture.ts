import type { AgentTool } from "@earendil-works/pi-agent-core";
import { AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type PiAgentSessionPrivateFields = {
  readonly _toolRegistry: unknown;
};

/** Capabilities proven against the pinned Pi AgentSession before CodeMode changes tool exposure. */
export interface CapturedPiAgentSession {
  readonly agent: AgentSession["agent"];
  readonly session: AgentSession;
  readonly settingsManager: AgentSession["settingsManager"];
  /** Reads Pi's replaceable exact wrapped-tool registry fresh on every call. */
  getToolRegistry(): ReadonlyMap<string, AgentTool>;
}

/** Expected capture or version-capability failure at Pi session startup. */
export type CapturePiAgentSessionResult =
  | { readonly ok: true; readonly capabilities: CapturedPiAgentSession }
  | { readonly ok: false; readonly warning: string };

function piAgentSessionPrivateFields(session: AgentSession): PiAgentSessionPrivateFields {
  const sessionObject: object = session;
  // SAFETY: AgentSession identity and every consumed private field are runtime-gated in this sole compatibility boundary.
  return sessionObject as PiAgentSessionPrivateFields;
}

function hasCallableSessionCapabilities(session: AgentSession): boolean {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Public Pi methods are runtime-gated because this package intentionally supports only the pinned capability shape.
  if (typeof session.getAllTools !== "function") return false;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Public Pi methods are runtime-gated because this package intentionally supports only the pinned capability shape.
  if (typeof session.getActiveToolNames !== "function") return false;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Public Pi methods are runtime-gated because this package intentionally supports only the pinned capability shape.
  if (typeof session.setActiveToolsByName !== "function") return false;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Trust-aware settings methods are runtime-gated at the compatibility boundary.
  if (typeof session.settingsManager.getGlobalSettings !== "function") return false;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Trust-aware settings methods are runtime-gated at the compatibility boundary.
  if (typeof session.settingsManager.getProjectSettings !== "function") return false;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Trust-aware settings methods are runtime-gated at the compatibility boundary.
  if (typeof session.settingsManager.isProjectTrusted !== "function") return false;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Agent hook installation is runtime-gated at the compatibility boundary.
  if (typeof session.agent.beforeToolCall !== "function") return false;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Agent hook installation is runtime-gated at the compatibility boundary.
  return typeof session.agent.afterToolCall === "function";
}

function isExecutablePiToolRegistry(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the parser for Pi's private version-dependent registry boundary.
  value: unknown,
): value is ReadonlyMap<string, AgentTool> {
  if (!(value instanceof Map)) return false;
  try {
    for (const [name, tool] of value) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The private Pi registry is version-gated untrusted compatibility data.
      if (typeof name !== "string" || typeof tool !== "object" || tool === null) {
        return false;
      }
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Executable wrapper members are checked at the private compatibility boundary.
      if (typeof tool.name !== "string" || tool.name !== name) return false;
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Executable wrapper members are checked at the private compatibility boundary.
      if (typeof tool.label !== "string" || typeof tool.description !== "string") return false;
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The exact validation schema is checked at the private compatibility boundary.
      if (typeof tool.parameters !== "object" || tool.parameters === null) return false;
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Executable wrapper members are checked at the private compatibility boundary.
      if (typeof tool.execute !== "function") return false;
      if (
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The private wrapper's structural TypeBox schema must exist before validation or catalogue rendering.
        typeof tool.parameters !== "object" ||
        tool.parameters === null
      ) {
        return false;
      }
      if (
        tool.prepareArguments !== undefined &&
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Optional executable wrapper members are checked at the private compatibility boundary.
        typeof tool.prepareArguments !== "function"
      ) {
        return false;
      }
      if (
        tool.executionMode !== undefined &&
        tool.executionMode !== "parallel" &&
        tool.executionMode !== "sequential"
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function captureFailure(message: string): CapturePiAgentSessionResult {
  return {
    ok: false,
    warning: `Pi CodeMode disabled: ${message}`,
  };
}

/** Captures the owning AgentSession through Pi's synchronous getAllTools delegation and restores its exact descriptor. */
export function capturePiAgentSession(
  pi: Pick<ExtensionAPI, "getAllTools">,
): CapturePiAgentSessionResult {
  const prototype = AgentSession.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "getAllTools");
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The exact private-compatible prototype descriptor is runtime-gated before patching.
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    return captureFailure("AgentSession.getAllTools is not the tested data method");
  }

  const originalGetAllTools = descriptor.value;
  let capturedSession: AgentSession | undefined;
  Object.defineProperty(prototype, "getAllTools", {
    ...descriptor,
    value(this: AgentSession) {
      // oxlint-disable-next-line typescript/no-this-alias -- Capturing the exact synchronous receiver is the approved transient AgentSession discovery mechanism.
      capturedSession = this;
      return originalGetAllTools.call(this);
    },
  });

  try {
    pi.getAllTools();
  } catch (cause) {
    return captureFailure(
      `getAllTools capture failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  } finally {
    Object.defineProperty(prototype, "getAllTools", descriptor);
  }

  if (!(capturedSession instanceof AgentSession)) {
    return captureFailure("getAllTools did not delegate to an AgentSession");
  }
  if (!hasCallableSessionCapabilities(capturedSession)) {
    return captureFailure("AgentSession does not expose the pinned public capabilities");
  }

  const privateFields = piAgentSessionPrivateFields(capturedSession);
  if (!isExecutablePiToolRegistry(privateFields._toolRegistry)) {
    return captureFailure("AgentSession._toolRegistry is not the pinned executable wrapper map");
  }

  return {
    ok: true,
    capabilities: {
      agent: capturedSession.agent,
      session: capturedSession,
      settingsManager: capturedSession.settingsManager,
      getToolRegistry() {
        const currentRegistry = privateFields._toolRegistry;
        if (!isExecutablePiToolRegistry(currentRegistry)) {
          throw new Error(
            "Pi CodeMode capability lost: AgentSession._toolRegistry is no longer an executable wrapper map",
          );
        }
        return currentRegistry;
      },
    },
  };
}
