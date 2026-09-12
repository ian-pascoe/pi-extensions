import { AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
/** Native session identity only; callers validate the capabilities they require. */
export type DiscoverPiAgentSessionResult = {
    readonly ok: true;
    readonly session: AgentSession;
} | {
    readonly ok: false;
    readonly warning: string;
};
/** Discovers the synchronous getAllTools receiver and restores its exact prototype descriptor. */
export declare function discoverPiAgentSession(pi: Pick<ExtensionAPI, "getAllTools">): DiscoverPiAgentSessionResult;
