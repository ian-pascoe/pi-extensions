import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ContextFile } from "./guardian-evidence.js";

/** The resource loader and project trust of the Guarded Agent's session. */
export type ResourceSession = Pick<AgentSession, "resourceLoader" | "settingsManager">;

/**
 * Context files as Pi loaded them into the Guarded Agent's system prompt. Pi loads the global
 * file from its agent directory and `AGENTS.md`/`CLAUDE.md` from the working directory and its
 * ancestors whether or not the project is trusted, so only the global file and, in a trusted
 * project, the others are Trusted Evidence.
 */
export function contextFiles(session: ResourceSession, agentDir: string): ContextFile[] {
  const projectTrusted = session.settingsManager.isProjectTrusted();
  const agentDirectory = resolve(agentDir);
  return session.resourceLoader.getAgentsFiles().agentsFiles.map((file) => ({
    path: file.path,
    content: file.content,
    trusted: projectTrusted || dirname(resolve(file.path)) === agentDirectory,
  }));
}

/** What {@link loadedResourcePaths} reads from Pi's resource loader. */
export interface LoadedResources {
  getAgentsFiles(): { agentsFiles: readonly { path: string }[] };
  getSkills(): { skills: readonly { filePath: string; baseDir: string }[] };
  getPrompts(): { prompts: readonly { filePath: string }[] };
  getExtensions(): { extensions: readonly { resolvedPath: string }[] };
  getAppendSystemPromptSources(): readonly { path: string }[];
  getSystemPromptSource(): { path: string } | undefined;
}

function inside(path: string, root: string): boolean {
  const relation = relative(root, path);
  return relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

/**
 * Paths of the resources Pi loaded into the Guarded Agent: context files, Skills (their whole
 * directory when a Skill is a `SKILL.md` directory), prompt templates, system prompt files, and
 * extensions outside the workspace. Changing any of them changes trusted instructions or code.
 * Extensions inside the workspace are ordinary project code: a change runs only after the user
 * reloads, and in a repository that develops extensions every edit would otherwise be reviewed.
 * Extensions outside the workspace are sensitive by location anyway.
 */
export function loadedResourcePaths(loader: LoadedResources, cwd: string): string[] {
  const paths = [
    ...loader.getAgentsFiles().agentsFiles.map((file) => file.path),
    ...loader
      .getSkills()
      .skills.map((skill) =>
        basename(skill.filePath) === "SKILL.md" ? skill.baseDir : skill.filePath,
      ),
    ...loader.getPrompts().prompts.map((prompt) => prompt.filePath),
    ...loader
      .getExtensions()
      .extensions.flatMap((extension) =>
        isAbsolute(extension.resolvedPath) && !inside(resolve(extension.resolvedPath), resolve(cwd))
          ? [extension.resolvedPath]
          : [],
      ),
    ...loader.getAppendSystemPromptSources().map((source) => source.path),
  ];
  const systemPrompt = loader.getSystemPromptSource();
  if (systemPrompt) paths.push(systemPrompt.path);
  // Inline and built-in extensions have no file.
  return [...new Set(paths.filter((path) => isAbsolute(path)))];
}
