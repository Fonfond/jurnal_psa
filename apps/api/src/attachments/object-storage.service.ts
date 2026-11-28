import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { loadEnv } from '../config/env';
import { findRepoRoot } from '../db/paths';

/**
 * Object storage for paper-permit scans. PostgreSQL keeps metadata only; the
 * PDF bytes live in a dedicated object-storage volume. The demo uses a
 * file-backed driver because the MinIO image is unavailable in the registry;
 * the interface is deliberately isolated so an S3/MinIO adapter can replace
 * it without touching the journal or attachment metadata.
 */
@Injectable()
export class ObjectStorageService {
  private readonly root: string;

  constructor() {
    const env = loadEnv();
    const configured = env.ATTACHMENTS_DIR ?? '.data/attachments';
    this.root = path.isAbsolute(configured)
      ? configured
      : path.resolve(findRepoRoot(), configured);
    mkdirSync(this.root, { recursive: true });
  }

  private filePath(key: string): string {
    const safe = key.replace(/\\/g, '/').replace(/\.\./g, '');
    return path.join(this.root, safe);
  }

  async putPdf(key: string, pdf: Buffer): Promise<void> {
    const target = this.filePath(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, pdf);
  }

  async getPdf(key: string): Promise<NodeJS.ReadableStream> {
    const target = this.filePath(key);
    if (!existsSync(target)) {
      throw new Error('Объект скана не найден');
    }
    return createReadStream(target);
  }

  async remove(key: string): Promise<void> {
    await fs.rm(this.filePath(key), { force: true });
  }
}

