interface MinimalSubagentsShutdownCoordinator {
  waitForSettledOperations(): Promise<void>;
  shutdownAfterSettling(): Promise<void>;
  shutdown(): Promise<void>;
}

interface MinimalSubagentsRootIdleGate {
  isRootIdle(): boolean;
  waitForRootIdle(): Promise<void>;
}

/** Drain active child and root work before reload while preserving canceling shutdown elsewhere. */
export async function shutdownMinimalSubagentsSession(
  reason: string,
  coordinator: MinimalSubagentsShutdownCoordinator,
  rootIdleGate: MinimalSubagentsRootIdleGate,
): Promise<void> {
  if (reason !== "reload") {
    await coordinator.shutdown();
    return;
  }

  while (true) {
    await coordinator.waitForSettledOperations();
    if (rootIdleGate.isRootIdle()) break;
    await rootIdleGate.waitForRootIdle();
  }
  await coordinator.shutdownAfterSettling();
}
