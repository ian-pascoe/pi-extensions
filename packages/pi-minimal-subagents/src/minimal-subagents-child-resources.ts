import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  type ExtensionFactory,
  getPackageDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
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

const ExtensionModuleSchema = Type.Object({
  default: Type.Function([Type.Unknown()], Type.Unknown()),
});

/** Built-in extension name, and the provider ID it registers. */
const LLAMA = "llama.cpp";

/** Pi ships a file-backed llama.cpp factory but does not export it; undefined when it is absent. */
function piLlamaExtensionPath(): string | undefined {
  const path = join(getPackageDir(), "dist", "extensions", "llama", "index.js");
  return existsSync(path) ? path : undefined;
}

function llamaExtension(): InlineExtension[] {
  const path = piLlamaExtensionPath();
  if (!path) return [];
  const factory: ExtensionFactory = async (pi) => {
    const module: unknown = await import(pathToFileURL(path).href);
    if (!Value.Check(ExtensionModuleSchema, module))
      throw new Error(`Pi's built-in llama.cpp file has no extension factory (${path})`);
    await module.default(pi);
  };
  return [{ name: LLAMA, factory, builtin: true }];
}

/** Whether a child can register a provider the root has; llama.cpp needs Pi's unexported factory. */
export function childProviderAvailable(provider: string): boolean {
  return provider !== LLAMA || piLlamaExtensionPath() !== undefined;
}

/** Child scripts must not call models outside their Launch Contract. */
export const CHILD_CODEMODE_MODELS = false;

/** Pi's built-in extensions in Pi's order, so children match the root's built-in surface. */
export function childBuiltinExtensions(): InlineExtension[] {
  return [
    ...llamaExtension(),
    {
      name: "codemode",
      factory: createCodemodeExtension({ models: CHILD_CODEMODE_MODELS }),
      builtin: true,
      replaceable: true,
    },
    { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
    { name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
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
