/**
 * Extremely small in-memory data store used to stand in for a real database.
 * It only supports the operations the modules in this fixture need.
 */

import { logger } from "./logger.js";

export interface Repository<T extends { id: string }> {
  insert(entity: T): Promise<T>;
  findById(id: string): Promise<T | undefined>;
  list(): Promise<T[]>;
}

class InMemoryRepository<T extends { id: string }> implements Repository<T> {
  private readonly rows = new Map<string, T>();

  constructor(private readonly name: string) {}

  async insert(entity: T): Promise<T> {
    this.rows.set(entity.id, entity);
    logger.debug("row inserted", { table: this.name, id: entity.id });
    return entity;
  }

  async findById(id: string): Promise<T | undefined> {
    return this.rows.get(id);
  }

  async list(): Promise<T[]> {
    return Array.from(this.rows.values());
  }
}

const repositories = new Map<string, InMemoryRepository<{ id: string }>>();

export function getRepository<T extends { id: string }>(
  name: string,
): Repository<T> {
  let repo = repositories.get(name);
  if (!repo) {
    repo = new InMemoryRepository<{ id: string }>(name);
    repositories.set(name, repo);
  }
  return repo as unknown as Repository<T>;
}

export function generateId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}
