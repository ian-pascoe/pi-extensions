import * as piAi from "@earendil-works/pi-ai";
import * as piSdk from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

const callable = Type.Function([], Type.Unknown());

/** True when a native SDK member is present and callable. */
export function isCallable<T>(value: T): boolean {
  return Value.Check(callable, value);
}

/** True when `owner` exposes `name` as a callable, including module getters and inherited methods. */
function hasMember<T extends object>(owner: T | undefined, name: string): boolean {
  if (!owner) return false;
  if (Value.Check(Type.Object({ [name]: callable }), owner)) return true;
  // TypeBox does not treat classes as objects, so read class statics as own data properties.
  return isCallable(Object.getOwnPropertyDescriptor(owner, name)?.value);
}

function missingMembers<T extends object>(
  label: string,
  owner: T | undefined,
  names: readonly string[],
): string[] {
  return names.filter((name) => !hasMember(owner, name)).map((name) => `${label}${name}`);
}

/**
 * Pi capabilities the Advisor needs to observe a session and recreate a private native one.
 * Modules are read through namespaces so a missing export is reported here instead of failing
 * extension load. Built-in extension factories are checked only when the observed session uses them.
 */
export function advisorRuntimeIssues(
  ai: Partial<typeof piAi> = piAi,
  sdk: Partial<typeof piSdk> = piSdk,
): string[] {
  return [
    ...missingMembers("pi-ai ", ai, [
      "InMemoryCredentialStore",
      "contentText",
      "getCurrentSystemPrompt",
      "getCurrentTools",
      "toToolDeclaration",
    ]),
    ...missingMembers("", sdk, [
      "AgentSession",
      "AgentSessionRuntime",
      "DefaultResourceLoader",
      "ModelRuntime",
      "SessionManager",
      "SettingsManager",
      "convertToLlm",
      "createAgentSessionFromServices",
      "createAgentSessionRuntime",
      "createAgentSessionServices",
      "defineTool",
    ]),
    ...missingMembers("SessionManager.", sdk.SessionManager, ["create"]),
    ...missingMembers("SettingsManager.", sdk.SettingsManager, ["fromStorage"]),
    ...missingMembers("SettingsManager#", sdk.SettingsManager?.prototype, [
      "applyOverrides",
      "getGlobalSettings",
      "getProjectSettings",
      "isProjectTrusted",
    ]),
    ...missingMembers("ModelRuntime.", sdk.ModelRuntime, ["create"]),
    ...missingMembers("ModelRuntime#", sdk.ModelRuntime?.prototype, [
      "getAuth",
      "getModel",
      "getRegisteredProviderIds",
      "isUsingOAuth",
      "listCredentials",
      "setRuntimeApiKey",
    ]),
    ...missingMembers("AgentSession#", sdk.AgentSession?.prototype, [
      "abort",
      "bindExtensions",
      "getActiveToolNames",
      "getAllTools",
      "getSessionStats",
      "prompt",
      "sendCustomMessage",
      "subscribe",
    ]),
    ...missingMembers("AgentSessionRuntime#", sdk.AgentSessionRuntime?.prototype, [
      "dispose",
      "setRebindSession",
    ]),
  ];
}

/** User-facing explanation for unmet requirements, or undefined when the runtime is supported. */
export function advisorRuntimeWarning(issues = advisorRuntimeIssues()): string | undefined {
  if (!issues.length) return undefined;
  return `Advisor is unavailable: this Pi runtime lacks ${issues.join(", ")}`;
}
