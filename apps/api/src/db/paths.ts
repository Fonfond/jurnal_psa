import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Walks up from the current file until it finds the workspace root
 * (package.json with a "workspaces" field).
 */
export function findRepoRoot(start: string = __dirname): string {
  let current = path.resolve(start);
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = path.join(current, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as {
          workspaces?: unknown;
        };
        if (parsed.workspaces) {
          return current;
        }
      } catch {
        // ignore malformed package.json and keep walking
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return process.cwd();
}

export function migrationsDirectory(): string {
  return process.env.MIGRATIONS_DIR ?? path.join(findRepoRoot(), 'db', 'migrations');
}
