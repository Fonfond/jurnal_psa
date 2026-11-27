/**
 * ASR abstraction (05/06, 18 §6).
 * Manual mode is always available; on-device ASR is behind a feature flag.
 * TODO(G1): on-device engine selection after PoC G1.
 * TODO(OQ-10): Web Speech permission/consent is not enabled.
 */
export interface AsrEngine {
  readonly kind: 'manual' | 'on_device' | 'web_speech';
  readonly available: boolean;
  start(): Promise<void>;
  stop(): Promise<string>;
}

export class ManualAsrEngine implements AsrEngine {
  readonly kind = 'manual' as const;
  readonly available = false;

  async start(): Promise<void> {
    // Manual input: nothing to start.
  }

  async stop(): Promise<string> {
    return '';
  }
}

export class OnDeviceAsrEngine implements AsrEngine {
  readonly kind = 'on_device' as const;
  readonly available = false;

  async start(): Promise<void> {
    throw new Error('On-device ASR не подключён. TODO(G1)');
  }

  async stop(): Promise<string> {
    return '';
  }
}

export function createAsrEngine(): AsrEngine {
  if (import.meta.env.VITE_ENABLE_ON_DEVICE_ASR === 'true') {
    return new OnDeviceAsrEngine();
  }
  if (import.meta.env.VITE_ENABLE_WEB_SPEECH === 'true') {
    // TODO(OQ-10): consent and Web Speech integration.
    return new OnDeviceAsrEngine();
  }
  return new ManualAsrEngine();
}
