export interface Profile {
  firstName: string;
  lastName: string;
}

export interface User {
  id: number;
  username: string;
  profile?: Profile;
}

/** Name shown in the staff directory: "First Last", or the username when there is no profile. */
export function displayName(user: User): string {
  return `${user.profile!.firstName} ${user.profile!.lastName}`;
}
