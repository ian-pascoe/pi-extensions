import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import {
  DefaultResourceLoader,
  type ExtensionFactory,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { canonicalPath } from "./minimal-subagents-paths.js";
import type { ProjectContextMode } from "./minimal-subagents-types.js";

export interface ChildResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  projectContext: ProjectContextMode;
  extensionEntrypoint: string;
  systemPromptBlock: string;
  settingsManager?: SettingsManager;
}

type InlineExtension = NonNullable<
  ConstructorParameters<typeof DefaultResourceLoader>[0]["extensionFactories"]
>[number];

// SAFETY: Older Pi hosts lack these exports; the namespace yields undefined rather than failing.
const sdk = piCodingAgent as Partial<typeof piCodingAgent>;

/** Provider ID registered by Pi's built-in llama.cpp extension. */
export const LLAMA_PROVIDER_ID = "llama.cpp";

/** Pi ships a file-backed llama.cpp factory but does not export it; undefined when it is absent. */
export function piLlamaExtensionPath(): string | undefined {
  if (!sdk.getPackageDir) return undefined;
  const path = join(sdk.getPackageDir(), "dist", "extensions", "llama", "index.js");
  return existsSync(path) ? path : undefined;
}

function llamaExtension(): InlineExtension[] {
  const path = piLlamaExtensionPath();
  if (!path) return [];
  const factory: ExtensionFactory = async (pi) => {
    const module: { default: ExtensionFactory } = await import(pathToFileURL(path).href);
    await module.default(pi);
  };
  return [{ name: "llama.cpp", factory, builtin: true }];
}

/** Pi's built-in extensions (Pi 0.99+) in Pi's order; older hosts have none, so neither do children. */
export function childBuiltinExtensions(): InlineExtension[] {
  return [
    ...llamaExtension(),
    ...(
      [
        // Child scripts must not call models outside their Launch Contract.
        ["codemode", sdk.createCodemodeExtension?.bind(undefined, { models: false })],
        ["tool-search", sdk.createToolSearchExtension],
        ["mcp", sdk.createMcpExtension],
      ] as const
    ).flatMap(([name, create]) =>
      create ? [{ name, factory: create(), builtin: true, replaceable: true }] : [],
    ),
  ];
}

function createDefaultChildResourceLoaderOptions(
  input: ChildResourceLoaderOptions,
): ConstructorParameters<typeof DefaultResourceLoader>[0] {
  const extensionEntrypoint = canonicalPath(input.extensionEntrypoint);
  return {
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager: input.settingsManager,
    noExtensions: false,
    noContextFiles: false,
    noSkills: false,
    noPromptTemplates: false,
    extensionFactories: childBuiltinExtensions(),
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter(
        (extension) => canonicalPath(extension.resolvedPath) !== extensionEntrypoint,
      ),
      errors: base.errors.filter((error) => canonicalPath(error.path) !== extensionEntrypoint),
    }),
    appendSystemPromptOverride: (base) => [...base, input.systemPromptBlock],
  };
}

class ChildResourceLoader extends DefaultResourceLoader {
  private readonly omitProjectContext: boolean;
  private readonly userContextDirectory: string;
  private readonly userSkillLoader: DefaultResourceLoader | undefined;

  constructor(input: ChildResourceLoaderOptions) {
    super(createDefaultChildResourceLoaderOptions(input));
    this.omitProjectContext = input.projectContext === "omit";
    this.userContextDirectory = canonicalPath(input.agentDir);
    this.userSkillLoader = this.omitProjectContext
      ? new DefaultResourceLoader({
          cwd: input.cwd,
          agentDir: input.agentDir,
          settingsManager: SettingsManager.create(input.cwd, input.agentDir, {
            projectTrusted: false,
          }),
          noExtensions: true,
          noContextFiles: true,
          noPromptTemplates: true,
          noThemes: true,
        })
      : undefined;
  }

  override async reload(...parameters: Parameters<DefaultResourceLoader["reload"]>): Promise<void> {
    await super.reload(...parameters);
    await this.userSkillLoader?.reload();
  }

  override extendResources(paths: Parameters<DefaultResourceLoader["extendResources"]>[0]): void {
    super.extendResources(paths);
    const skillPaths = paths.skillPaths?.filter(({ metadata }) => metadata.scope !== "project");
    if (skillPaths && skillPaths.length > 0) this.userSkillLoader?.extendResources({ skillPaths });
  }

  override getAgentsFiles(): ReturnType<DefaultResourceLoader["getAgentsFiles"]> {
    const base = super.getAgentsFiles();
    if (!this.omitProjectContext) return base;
    return {
      agentsFiles: base.agentsFiles.filter(
        ({ path }) => canonicalPath(dirname(path)) === this.userContextDirectory,
      ),
    };
  }

  override getSkills(): ReturnType<DefaultResourceLoader["getSkills"]> {
    const base = super.getSkills();
    if (!this.omitProjectContext) return base;
    const skills = base.skills.filter((skill) => skill.sourceInfo.scope !== "project");
    const skillNames = new Set(skills.map((skill) => skill.name));
    for (const skill of this.userSkillLoader?.getSkills().skills ?? []) {
      if (skillNames.has(skill.name)) continue;
      skills.push(skill);
      skillNames.add(skill.name);
    }
    return { skills, diagnostics: base.diagnostics };
  }
}

/** Load Child Agent runtime resources while applying its Project Context choice. */
export function createChildResourceLoader(
  input: ChildResourceLoaderOptions,
): DefaultResourceLoader {
  return new ChildResourceLoader(input);
}
