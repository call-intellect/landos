/**
 * User service. Thin domain layer over the in-memory repository.
 */

import { generateId, getRepository } from "../../common/db.js";
import { logger } from "../../common/logger.js";
import { isEmail, ValidationError } from "../../common/validation.js";
import type { CreateUserInput, User } from "./user.entity.js";

const users = getRepository<User>("users");

export async function createUser(input: CreateUserInput): Promise<User> {
  if (!isEmail(input.email)) {
    throw new ValidationError(["email must be a valid address"]);
  }

  const user: User = {
    id: generateId("user"),
    email: input.email.trim().toLowerCase(),
    displayName: input.displayName.trim(),
    role: input.role ?? "agent",
    active: true,
    createdAt: new Date().toISOString(),
  };

  await users.insert(user);
  logger.info("user created", { userId: user.id, role: user.role });
  return user;
}

export async function getUser(id: string): Promise<User | undefined> {
  return users.findById(id);
}

export async function listUsers(): Promise<User[]> {
  return users.list();
}
