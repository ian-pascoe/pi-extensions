import {
  BrvBridge,
  type BrvBridgeConfig,
  type PersistOptions,
  type PersistResult,
  type RecallOptions,
  type RecallResult,
  type SearchOptions,
  type SearchResult,
} from "@byterover/brv-bridge";

/** Options that specialize a ByteRover bridge for one operation. */
export type ByteRoverBridgeOverride = Pick<
  BrvBridgeConfig,
  "cwd" | "searchTimeoutMs" | "recallTimeoutMs" | "persistTimeoutMs"
>;

/** The ByteRover operations used by this extension. */
export interface ByteRoverBridge {
  ready(): Promise<boolean>;
  recall(query: string, options?: RecallOptions): Promise<RecallResult>;
  search(query: string, options?: SearchOptions): Promise<SearchResult>;
  persist(context: string, options?: PersistOptions): Promise<PersistResult>;
}

/** Creates bridges with the runtime configuration or a one-operation override. */
export type ByteRoverBridgeFactory = (override?: ByteRoverBridgeOverride) => ByteRoverBridge;

/** Builds one bridge configuration with operation overrides taking precedence. */
export const createBrvBridgeConfig = (
  config: BrvBridgeConfig,
  defaultCwd: string,
  override?: ByteRoverBridgeOverride,
): BrvBridgeConfig => {
  const bridgeConfig: BrvBridgeConfig = { cwd: override?.cwd ?? defaultCwd };
  const brvPath = config.brvPath;
  const searchTimeoutMs = override?.searchTimeoutMs ?? config.searchTimeoutMs;
  const recallTimeoutMs = override?.recallTimeoutMs ?? config.recallTimeoutMs;
  const persistTimeoutMs = override?.persistTimeoutMs ?? config.persistTimeoutMs;
  if (brvPath !== undefined) bridgeConfig.brvPath = brvPath;
  if (searchTimeoutMs !== undefined) bridgeConfig.searchTimeoutMs = searchTimeoutMs;
  if (recallTimeoutMs !== undefined) bridgeConfig.recallTimeoutMs = recallTimeoutMs;
  if (persistTimeoutMs !== undefined) bridgeConfig.persistTimeoutMs = persistTimeoutMs;
  return bridgeConfig;
};

/** Creates the production ByteRover bridge adapter from captured extension configuration. */
export const createBrvBridgeFactory = (
  config: BrvBridgeConfig,
  defaultCwd: string,
): ByteRoverBridgeFactory => {
  return (override) => new BrvBridge(createBrvBridgeConfig(config, defaultCwd, override));
};
