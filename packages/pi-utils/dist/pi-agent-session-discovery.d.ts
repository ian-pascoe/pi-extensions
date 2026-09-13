import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
/** Native session identity only; callers validate the capabilities they require. */
export type DiscoverPiAgentSessionResult = {
    readonly ok: true;
    readonly session: AgentSession;
} | {
    readonly ok: false;
    readonly warning: string;
};
/** Use the extension's host-resolved class: a compiled dependency's SDK import may be a different instance. */
export declare function discoverPiAgentSession(pi: Pick<ExtensionAPI, "getAllTools">, sessionClass: typeof AgentSession): DiscoverPiAgentSessionResult;
