import { SettingsManager, type SessionManager } from "@earendil-works/pi-coding-agent";
import {
  defineLayeredSettings,
  type LayeredSettingScope,
} from "@ian-pascoe/pi-utils/layered-settings";
import { Type, type Static } from "typebox";
import { isInsideProject, type EnvFileSettings, type ListedEnvFile } from "./env-file-provider.js";
import type { OnePasswordSettings } from "./one-password-provider.js";

/** Pi Secret's settings: the `secret` namespace of Pi's global and trusted-project settings. */
export interface SecretSettings {
  /** The Secret Lifetime, in minutes, counted from when the user enters a value. */
  lifetimeMinutes: number;
  /** Secret Provider settings; a provider without settings uses its defaults. */
  providers: { "1password"?: OnePasswordSettings; dotenv?: EnvFileSettings };
}

export const DEFAULT_LIFETIME_MINUTES = 15;

const SettingsSchema = Type.Object({
  lifetimeMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
  providers: Type.Optional(
    Type.Object({
      "1password": Type.Optional(
        Type.Object({
          account: Type.Optional(Type.String({ minLength: 1 })),
          vaults: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
        }),
      ),
      dotenv: Type.Optional(
        Type.Object({
          enabled: Type.Optional(Type.Boolean()),
          files: Type.Optional(
            Type.Array(
              // An exact path: absolute, or under the home directory with `~/`.
              Type.String({ pattern: "^(?:~[\\\\/]|[\\\\/]|[A-Za-z]:[\\\\/])" }),
            ),
          ),
        }),
      ),
    }),
  ),
});

/** Each provider's settings replace that provider's only; listed Env Files add up. */
function mergeProviders(
  current: SecretSettings["providers"],
  next: NonNullable<Static<typeof SettingsSchema>["providers"]>,
  source: LayeredSettingScope,
): SecretSettings["providers"] {
  const merged = { ...current };
  if (next["1password"] !== undefined) merged["1password"] = next["1password"];
  const files = next.dotenv?.files;
  if (files !== undefined) {
    // Anything but global settings is held to the project, failing closed.
    const scope: ListedEnvFile["scope"] = source === "global" ? "global" : "project";
    merged.dotenv = {
      files: [...(current.dotenv?.files ?? []), ...files.map((path) => ({ path, scope }))],
    };
  }
  return merged;
}

const layered = defineLayeredSettings({
  namespace: "secret",
  label: "Pi Secret",
  schema: SettingsSchema,
  defaults: { lifetimeMinutes: DEFAULT_LIFETIME_MINUTES, providers: {} } satisfies SecretSettings,
  merge: { providers: mergeProviders },
});

/** Settings as read, with why any part of them was ignored. */
export interface ReadSecretSettings {
  settings: SecretSettings;
  warnings: string[];
}

/**
 * Effective settings, or the defaults with a warning when the authored ones are invalid. Project
 * settings may not list Env Files outside the project, nor switch the Env File provider.
 */
export function readSecretSettings(
  session: {
    settingsManager: SettingsManager;
    sessionManager: Pick<SessionManager, "getBranch">;
  },
  projectDirectory: string,
): ReadSecretSettings {
  const authored = layered.readLayers(session.settingsManager);
  let settings: SecretSettings;
  try {
    settings = layered.readSettings(session, authored).settings;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      // Fail closed: an unreadable vault allowlist must not widen to every vault, and an
      // unreadable file list reads only the project's own Env Files.
      settings: {
        lifetimeMinutes: DEFAULT_LIFETIME_MINUTES,
        providers: { "1password": { vaults: [] }, dotenv: { files: [] } },
      },
      warnings: [
        `${message}; using a ${DEFAULT_LIFETIME_MINUTES}-minute Secret Lifetime, no 1Password vaults, and only the project's own Env Files until it is fixed`,
      ],
    };
  }
  const warnings: string[] = [];
  const project = authored.project;
  if (
    session.settingsManager.isProjectTrusted() &&
    !(project instanceof Error) &&
    project.providers?.dotenv?.enabled !== undefined
  )
    warnings.push(
      "secret.providers.dotenv.enabled in project settings is ignored; only global settings can turn the Env File Secret Provider on or off",
    );
  const dotenv = settings.providers.dotenv;
  if (dotenv !== undefined) {
    const outside = dotenv.files.filter(
      (file) => file.scope === "project" && !isInsideProject(projectDirectory, file.path),
    );
    for (const file of outside)
      warnings.push(
        `ignoring ${file.path} in project secret.providers.dotenv.files; only global settings may list Env Files outside the project`,
      );
    settings.providers.dotenv = { files: dotenv.files.filter((file) => !outside.includes(file)) };
  }
  return { settings, warnings };
}

/**
 * Whether global settings turn the Env File Secret Provider on (`true`) or off (`false`), or
 * leave it to the project directory (undefined). Read once at load, from global settings only:
 * Pi tells extensions neither the session directory nor project trust before a session starts.
 */
export function globalEnvFileSwitch(cwd: string, agentDirectory: string): boolean | undefined {
  const global = layered.readLayers(
    SettingsManager.create(cwd, agentDirectory, { projectTrusted: false }),
  ).global;
  // Invalid settings list no files, so only a project Env File can turn the provider on.
  if (global instanceof Error) return undefined;
  const dotenv = global.providers?.dotenv;
  if (dotenv?.enabled !== undefined) return dotenv.enabled;
  return (dotenv?.files?.length ?? 0) > 0 ? true : undefined;
}
