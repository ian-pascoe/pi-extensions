/** Use the extension's host-resolved class: a compiled dependency's SDK import may be a different instance. */
export function discoverPiAgentSession(pi, sessionClass) {
    const prototype = sessionClass.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "getAllTools");
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: This native SDK descriptor boundary requires only a callable data method; session identity is validated after delegation and callers own capability checks.
    if (descriptor === undefined || typeof descriptor.value !== "function") {
        return { ok: false, warning: "AgentSession.getAllTools is not the tested data method" };
    }
    const originalGetAllTools = descriptor.value;
    let capturedSession;
    Object.defineProperty(prototype, "getAllTools", {
        ...descriptor,
        value() {
            // oxlint-disable-next-line typescript/no-this-alias -- SAFETY: Capturing the exact synchronous receiver is the approved transient AgentSession discovery mechanism; pi-codemode/test/pi-tool-bridge.test.ts verifies descriptor restoration.
            capturedSession = this;
            return originalGetAllTools.call(this);
        },
    });
    try {
        pi.getAllTools();
    }
    catch (cause) {
        return {
            ok: false,
            warning: `getAllTools capture failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
    }
    finally {
        Object.defineProperty(prototype, "getAllTools", descriptor);
    }
    if (!(capturedSession instanceof sessionClass)) {
        return { ok: false, warning: "getAllTools did not delegate to an AgentSession" };
    }
    return { ok: true, session: capturedSession };
}
