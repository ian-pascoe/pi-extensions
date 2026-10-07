import { basename, dirname, isAbsolute, resolve } from "node:path";
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

/**
 * Paths of the resources Pi loaded into the Guarded Agent: context files, Skills (their whole
 * directory when a Skill is a `SKILL.md` directory), prompt templates, system prompt files, and
 * extensions. Changing any of them changes trusted instructions or code.
 */
export function loadedResourcePaths(session: ResourceSession): string[] {
  const loader = session.resourceLoader;
  const paths = [
    ...loader.getAgentsFiles().agentsFiles.map((file) => file.path),
    ...loader
      .getSkills()
      .skills.map((skill) =>
        basename(skill.filePath) === "SKILL.md" ? skill.baseDir : skill.filePath,
      ),
    ...loader.getPrompts().prompts.map((prompt) => prompt.filePath),
    ...loader.getExtensions().extensions.map((extension) => extension.resolvedPath),
    ...loader.getAppendSystemPromptSources().map((source) => source.path),
  ];
  const systemPrompt = loader.getSystemPromptSource();
  if (systemPrompt) paths.push(systemPrompt.path);
  // Inline and built-in extensions have no file.
  return [...new Set(paths.filter((path) => isAbsolute(path)))];
}
