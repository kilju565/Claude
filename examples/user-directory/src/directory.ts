import { displayName, type User } from './users.ts';

/** Alphabetical list of display names for the staff directory. */
export function buildDirectory(users: readonly User[]): string[] {
  return users.map(displayName).sort((a, b) => a.localeCompare(b));
}
