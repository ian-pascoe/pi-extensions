import type { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { defineLayeredSettings } from "@ian-pascoe/pi-utils/layered-settings";
import { Type } from "typebox";
import type { OnePasswordSettings } from "./one-password-provider.js";

/** Pi Secret's settings: the `secret` namespace of Pi's global and trusted-project settings. */
export interface SecretSettings {
  /** The Secret Lifetime, in minutes, counted from when the user enters a value. */
  lifetimeMinutes: number;
  /** Secret Provider settings; a provider without settings uses its defaults. */
  providers: { "1password"?: OnePasswordSettings };
}

export const DEFAULT_LIFETIME_MINUTES = 15;

const layered = defineLayeredSettings({
  namespace: "secret",
  label: "Pi Secret",
  schema: Type.Object({
    lifetimeMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
    providers: Type.Optional(
      Type.Object({
        "1password": Type.Optional(
          Type.Object({
            account: Type.Optional(Type.String({ minLength: 1 })),
            vaults: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
          }),
        ),
      }),
    ),
  }),
  defaults: { lifetimeMinutes: DEFAULT_LIFETIME_MINUTES, providers: {} } satisfies SecretSettings,
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
      // Fail closed: an unreadable vault allowlist must not widen to every vault.
      settings: {
        lifetimeMinutes: DEFAULT_LIFETIME_MINUTES,
        providers: { "1password": { vaults: [] } },
      },
      warning: `${message}; using a ${DEFAULT_LIFETIME_MINUTES}-minute Secret Lifetime and no 1Password vaults until it is fixed`,
    };
  }
}
