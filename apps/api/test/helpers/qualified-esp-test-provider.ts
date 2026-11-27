import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface QualifiedEspMode {
  /** Return this HTTP status for every call (error contract). */
  errorStatus?: number;
  /** Return a non-JSON body. */
  invalidJson?: boolean;
  /** Delay the response to trigger the adapter timeout. */
  delayMs?: number;
  /** Certificate metadata returned by /sign. */
  certificateSerial?: string;
  certificateSubject?: string;
  keyId?: string;
}

interface RecordedCall {
  operation: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

/**
 * Test-only HTTP provider implementing the qualified e-signature contract
 * (docs/security/QUALIFIED_ES_CONTRACT.md). It never touches real УЦ/КЭП keys
 * and must not be deployed; production requires an accredited provider.
 */
export class QualifiedEspTestProvider {
  private server: Server | null = null;
  private signedHash: string | null = null;
  private signedSignature: string | null = null;
  private mode: QualifiedEspMode = {};
  readonly calls: RecordedCall[] = [];

  async start(mode: QualifiedEspMode = {}): Promise<string> {
    this.mode = mode;
    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: String(error) }));
      });
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test ESP provider failed to bind');
    }
    return `http://127.0.0.1:${address.port}/sign`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = null;
  }

  private async readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw.length === 0) {
      return {};
    }
    return JSON.parse(raw) as Record<string, unknown>;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await this.readBody(request);
    const authorization = request.headers.authorization;
    this.calls.push({ operation: String(body.operation ?? ''), authorization, body });

    if (this.mode.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.mode.delayMs));
    }
    if (this.mode.errorStatus) {
      response.statusCode = this.mode.errorStatus;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'provider_unavailable' }));
      return;
    }
    if (this.mode.invalidJson) {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end('not-json');
      return;
    }

    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    const operation = body.operation;
    if (operation === 'sign') {
      const hash = String(body.content_hash ?? '');
      this.signedHash = hash;
      this.signedSignature = Buffer.from(`cms:${hash}`).toString('base64');
      response.end(
        JSON.stringify({
          signature: this.signedSignature,
          algorithm: 'CMS-BES',
          key_id: this.mode.keyId ?? 'test-uc-key-1',
          certificate_serial: this.mode.certificateSerial ?? '0A1B2C3D',
          certificate_subject: this.mode.certificateSubject ?? 'CN=Test УЦ, O=Logbook Test',
          metadata: { provider: 'test-qualified', ts: '2026-11-27T00:00:00Z' },
        }),
      );
      return;
    }
    if (operation === 'verify') {
      const valid =
        this.signedHash !== null &&
        body.content_hash === this.signedHash &&
        body.signature === this.signedSignature;
      response.end(
        JSON.stringify({
          valid,
          reason: valid ? undefined : 'content_hash_or_signature_mismatch',
        }),
      );
      return;
    }
    response.statusCode = 400;
    response.end(JSON.stringify({ error: 'unknown_operation' }));
  }
}
