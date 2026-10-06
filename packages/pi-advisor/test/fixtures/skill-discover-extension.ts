import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Contributes the skills under `<cwd>/extension-skills` through `resources_discover`. */
export default function skillDiscoverFixture(pi: ExtensionAPI): void {
  pi.on("resources_discover", (event) => ({
    skillPaths: [`${event.cwd}/extension-skills`],
  }));
}
