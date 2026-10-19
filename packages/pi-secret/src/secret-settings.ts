import type { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { defineLayeredSettings } from "@ian-pascoe/pi-utils/layered-settings";
import { Type } from "typebox";

/** Pi Secret's settings: the `secret` namespace of Pi's global and trusted-project settings. */
export interface SecretSettings {
  /** The Secret Lifetime, in minutes, counted from when the user enters a value. */
  lifetimeMinutes: number;
}

export const DEFAULT_LIFETIME_MINUTES = 15;

const layered = defineLayeredSettings({
  namespace: "secret",
  label: "Pi Secret",
  schema: Type.Object({
    lifetimeMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
  }),
  defaults: { lifetimeMinutes: DEFAULT_LIFETIME_MINUTES } satisfies SecretSettings,
});

/** Settings as read, with why they fell back to the defaults, if they did. */
export interface ReadSecretSettings {
  settings: SecretSettings;
  warning?: string;
}

/** Effective settings, or the defaults with a warning when the authored ones are invalid. */
export function readSecretSettings(session: {
  settingsManager: SettingsManager;
  sessionManager: Pick<SessionManager, "getBranch">;
}): ReadSecretSettings {
  try {
    return { settings: layered.readSettings(session).settings };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      settings: { lifetimeMinutes: DEFAULT_LIFETIME_MINUTES },
      warning: `${message}; using a ${DEFAULT_LIFETIME_MINUTES}-minute Secret Lifetime`,
    };
  }
}
