/**
 * The base class of every configuration error (HistoryConfigError, VoiceConfigError, AccountsConfigError, …): one
 * `instanceof ConfigError` catches them all. Each subclass keeps its own name and messages.
 */
export class ConfigError extends Error {}
