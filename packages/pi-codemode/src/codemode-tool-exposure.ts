import { isReservedCodeModeToolName } from "./codemode-tool-contract.js";
import type { CodeModeExposureRule } from "./pi-codemode-settings.js";

/** The instance whose active-set method CodeMode wraps without changing its prototype. */
export interface CodeModeActiveToolOwner {
  /** Returns Pi's current policy-applied active tool names. */
  getActiveToolNames(): string[];
  /** Applies exact active tool names through Pi's native registry machinery. */
  setActiveToolsByName(names: string[]): void;
}

/** Restores one installed instance-local exposure policy. */
export interface InstalledCodeModeToolExposure {
  /** Returns the latest coherent direct, CodeMode, and unavailable classification. */
  getDecision(): CodeModeToolExposureDecision;
  /** Restores pre-policy requested names and the owner's exact original method descriptor. */
  restore(): void;
}

/** One coherent classification of every currently registered Pi tool. */
export interface CodeModeToolExposureDecision {
  readonly codeModeNames: readonly string[];
  readonly directNames: readonly string[];
  readonly unavailableNames: readonly string[];
}

/** Applies exposure rules only to requested tools; unrequested tools stay unavailable. */
export function decideCodeModeToolExposure(
  registryNames: Iterable<string>,
  requestedNames: Iterable<string>,
  rules: readonly CodeModeExposureRule[],
): CodeModeToolExposureDecision {
  const requested = new Set(requestedNames);
  const codeModeNames: string[] = [];
  const directNames: string[] = [];
  const unavailableNames: string[] = [];
  for (const toolName of new Set(registryNames)) {
    if (isReservedCodeModeToolName(toolName)) {
      directNames.push(toolName);
      continue;
    }

    if (!requested.has(toolName)) {
      unavailableNames.push(toolName);
      continue;
    }
    let exposure: CodeModeExposureRule["exposure"] = "direct-and-codemode";
    for (const rule of rules) {
      if (rule.matches(toolName)) exposure = rule.exposure;
    }

    if (exposure === "direct-only" || exposure === "direct-and-codemode") {
      directNames.push(toolName);
    }
    if (exposure === "codemode-only" || exposure === "direct-and-codemode") {
      codeModeNames.push(toolName);
    }
  }
  return { codeModeNames, directNames, unavailableNames };
}

function haveSameNames(leftNames: Iterable<string>, rightNames: Iterable<string>): boolean {
  const left = new Set(leftNames);
  const right = new Set(rightNames);
  return left.size === right.size && [...left].every((name) => right.has(name));
}

/** Installs policy on one captured Pi session and synchronously reports coherent decisions. */
export function installCodeModeToolExposure(
  owner: CodeModeActiveToolOwner,
  getRegistryNames: () => Iterable<string>,
  rules: readonly CodeModeExposureRule[],
  onDecision?: (decision: CodeModeToolExposureDecision) => void,
  acceptDecision?: (decision: CodeModeToolExposureDecision) => boolean,
): InstalledCodeModeToolExposure {
  const originalOwnDescriptor = Object.getOwnPropertyDescriptor(owner, "setActiveToolsByName");
  const inheritedCallable = owner.setActiveToolsByName.bind(owner);

  let requestedNames = new Set(owner.getActiveToolNames());
  let lastObservedRegistryNames = new Set(getRegistryNames());
  let decision = decideCodeModeToolExposure(lastObservedRegistryNames, requestedNames, rules);
  let lastAppliedDirectNames = new Set(decision.directNames);
  let restored = false;
  let notifying = false;
  let notificationPending = false;

  const notifyDecision = (): void => {
    if (onDecision === undefined) return;
    if (notifying) {
      notificationPending = true;
      return;
    }
    notifying = true;
    try {
      do {
        notificationPending = false;
        onDecision(decision);
      } while (notificationPending);
    } finally {
      notifying = false;
    }
  };

  const applyPolicy = (inputNames: string[]): void => {
    if (restored) {
      inheritedCallable(inputNames);
      return;
    }
    const registryNames = new Set(getRegistryNames());
    const internalRefresh =
      !haveSameNames(registryNames, lastObservedRegistryNames) ||
      haveSameNames(inputNames, lastAppliedDirectNames);
    if (internalRefresh) {
      requestedNames = new Set([...requestedNames].filter((name) => registryNames.has(name)));
      for (const name of inputNames) {
        if (!lastObservedRegistryNames.has(name) && registryNames.has(name)) {
          requestedNames.add(name);
        }
      }
    } else {
      requestedNames = new Set(inputNames);
    }

    const candidate = decideCodeModeToolExposure(registryNames, requestedNames, rules);
    lastObservedRegistryNames = registryNames;
    if (acceptDecision?.(candidate) === false) {
      inheritedCallable([...lastAppliedDirectNames]);
      return;
    }
    decision = candidate;
    lastAppliedDirectNames = new Set(decision.directNames);
    inheritedCallable([...decision.directNames]);
    notifyDecision();
  };

  Object.defineProperty(owner, "setActiveToolsByName", {
    configurable: true,
    enumerable: originalOwnDescriptor?.enumerable ?? false,
    value: applyPolicy,
    writable: true,
  });
  inheritedCallable([...decision.directNames]);
  notifyDecision();

  return {
    getDecision: () => decision,
    restore: () => {
      if (restored) return;
      const registryNames = new Set(getRegistryNames());
      const namesToRestore = [...requestedNames].filter((name) => registryNames.has(name));
      inheritedCallable(namesToRestore);
      if (originalOwnDescriptor === undefined) {
        Reflect.deleteProperty(owner, "setActiveToolsByName");
      } else {
        Object.defineProperty(owner, "setActiveToolsByName", originalOwnDescriptor);
      }
      restored = true;
    },
  };
}
