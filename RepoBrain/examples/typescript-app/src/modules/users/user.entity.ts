/**
 * User entity and related value types.
 */

export type UserRole = "admin" | "agent" | "viewer";

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
}

export interface CreateUserInput {
  email: string;
  displayName: string;
  role?: UserRole;
}

/**
 * Returns true when the user is allowed to manage leads.
 */
export function canManageLeads(user: User): boolean {
  return user.active && (user.role === "admin" || user.role === "agent");
}
