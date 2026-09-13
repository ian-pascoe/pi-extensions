import type { AgentTool } from "@earendil-works/pi-agent-core";
import { AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverPiAgentSession } from "@ian-pascoe/pi-utils/pi-agent-session-discovery";
import { Type } from "typebox";
import { Value } from "typebox/value";

type PiAgentSessionPrivateFields = {
  readonly _toolRegistry: unknown;
};

const PiCallableSchema = Type.Function([], Type.Unknown());
const PiToolWrapperSchema = Type.Object(
  {
    name: Type.String(),
    label: Type.String(),
    description: Type.String(),
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: PiCallableSchema,
    prepareArguments: Type.Optional(PiCallableSchema),
    executionMode: Type.Optional(
      Type.Union([Type.Literal("parallel"), Type.Literal("sequential")]),
    ),
  },
  { additionalProperties: true },
);
const PiToolRegistryEntrySchema = Type.Tuple([Type.String(), PiToolWrapperSchema]);
const PiAgentSessionCapabilitiesSchema = Type.Object(
  {
    getActiveToolNames: PiCallableSchema,
    setActiveToolsByName: PiCallableSchema,
    settingsManager: Type.Object(
      {
        getGlobalSettings: PiCallableSchema,
        getProjectSettings: PiCallableSchema,
        isProjectTrusted: PiCallableSchema,
      },
      { additionalProperties: true },
    ),
    agent: Type.Object(
      {
        beforeToolCall: PiCallableSchema,
        afterToolCall: PiCallableSchema,
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

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
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: Pi keeps this version-pinned field private; AgentSession identity is checked before this boundary and the registry before every use. pi-tool-bridge.test.ts covers capability loss and registry replacement.
  return session as unknown as PiAgentSessionPrivateFields;
}

function hasCallableSessionCapabilities(session: AgentSession): boolean {
  return Value.Check(PiAgentSessionCapabilitiesSchema, session);
}

function isExecutablePiToolRegistry(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: This private Pi compatibility parser validates the version-pinned registry before exposing its wrapped handlers; pi-tool-bridge.test.ts covers capability loss.
  value: unknown,
): value is ReadonlyMap<string, AgentTool> {
  if (!(value instanceof Map)) return false;
  try {
    for (const entry of value) {
      if (!Value.Check(PiToolRegistryEntrySchema, entry) || entry[1].name !== entry[0]) {
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
  const discovery = discoverPiAgentSession(pi, AgentSession);
  if (!discovery.ok) return captureFailure(discovery.warning);
  const capturedSession = discovery.session;
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
