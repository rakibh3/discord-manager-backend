/**
 * Official Discord Username Validation Regex
 * - 2 to 32 characters
 * - Only lowercase a-z, 0-9, underscore (_), period (.)
 * - Cannot have consecutive periods (..)
 *
 * A leading or trailing `_` / `.` IS permitted. An earlier version of this
 * regex forbade it, which rejected 115 of 2189 live guild members (5.3%) -
 * names like `itzazad_`, `.rabbil`, `shahriarratul.`. 59 of those accounts
 * were created after Discord's Pomelo rollout, so they are current, valid
 * handles rather than grandfathered legacy ones.
 *
 * A leading `@` is not matched here because `normalizeDiscordUsername` strips
 * it before validation.
 */
export const DISCORD_USERNAME_REGEX = /^(?!.*\.{2})[a-z0-9_.]{2,32}$/;

/**
 * Normalizes user input by trimming whitespace, removing leading '@',
 * and converting to lowercase. Discord stores usernames lowercased, so the
 * normalized form is the only value that should ever be persisted or compared.
 */
export const normalizeDiscordUsername = (rawUsername: string): string =>
  rawUsername.trim().replace(/^@+/, '').toLowerCase();

/**
 * Validates a username against the official Discord standard.
 * Normalizes first, so callers may pass raw form input.
 */
export const isValidDiscordUsername = (rawUsername: string): boolean =>
  DISCORD_USERNAME_REGEX.test(normalizeDiscordUsername(rawUsername));
