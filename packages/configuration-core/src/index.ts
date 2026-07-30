export {
  FLAG_REGISTRY,
  getFlagDefinition,
  resolveProjectRoot,
  getFlagsPath,
  readFlags,
  readEffectiveFlags,
  setFlag,
  unsetFlag,
  isFlagEnabled,
  withForwardedFlags,
  getForwardedFlags,
  type FlagScope,
  type FlagDefinition,
  type FlagsPathOptions,
} from "./flags.js";

export {
  FLAG_FORWARD_HEADER,
  FLAG_FORWARD_ACK_HEADER,
  ForwardedFlagsError,
  encodeForwardedFlags,
  decodeForwardedFlags,
} from "./flag-transport.js";

export { argentHomeDir, configFilePath } from "./paths.js";

export {
  readConfigObject,
  updateConfig,
  getRememberedAgent,
  setRememberedAgent,
  clearRememberedAgent,
} from "./config.js";
