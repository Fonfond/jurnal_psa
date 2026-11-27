/* PoC G1 — ASR harness shell. Browser-only; no product code, no model bundled. */
(function () {
  'use strict';

  const status = document.getElementById('status');
  const result = document.getElementById('poc-result');
  const modelInput = document.getElementById('model-url');

  function log(text) {
    status.textContent = text;
  }

  /** 20 s chunks with 2 s overlap (ADR-12); testable with synthetic PCM. */
  function createChunker({ sampleRate = 16_000, chunkSec = 20, overlapSec = 2 } = {}) {
    const chunkSize = sampleRate * chunkSec;
    const overlapSize = sampleRate * overlapSec;
    const buffer = [];
    let pending = new Float32Array(0);
    return {
      push(samples) {
        const merged = new Float32Array(pending.length + samples.length);
        merged.set(pending, 0);
        merged.set(samples, pending.length);
        pending = merged;
        const chunks = [];
        while (pending.length >= chunkSize) {
          chunks.push(pending.slice(0, chunkSize));
          pending = pending.slice(chunkSize - overlapSize);
        }
        buffer.push(...chunks);
        return chunks;
      },
      flush() {
        const rest = pending;
        pending = new Float32Array(0);
        return rest.length > 0 ? [rest] : [];
      },
      get emitted() {
        return buffer.length;
      },
    };
  }

  function syntheticPcm(seconds, sampleRate = 16_000) {
    return new Float32Array(seconds * sampleRate);
  }

  async function probeEnvironment() {
    const modelUrl = modelInput.value.trim() || new URLSearchParams(location.search).get('model_url') || '';
    const checks = {
      secure_context: window.isSecureContext,
      media_devices: Boolean(navigator.mediaDevices?.getUserMedia),
      audio_context: Boolean(window.AudioContext || window.webkitAudioContext),
      web_worker: typeof Worker !== 'undefined',
      wasm: typeof WebAssembly !== 'undefined',
      model_url: modelUrl || null,
    };

    const chunker = createChunker();
    const pcm = syntheticPcm(120);
    const chunks = chunker.push(pcm);
    const flushed = chunker.flush();
    const pipeline = {
      audio_seconds: 120,
      chunks_emitted: chunks.length,
      flushed_chunks: flushed.length,
      chunk_size: chunks[0]?.length ?? 0,
      overlap_samples: 2 * 16_000,
    };

    // No ASR model or corpus is available in this workspace. The harness does
    // not fake a model: it reports the gate as blocked and leaves measurements
    // absent. The chunker self-test is pipeline-only.
    const blocked = !modelUrl;
    return {
      gate: 'G1',
      status: blocked ? 'blocked' : 'model_configured_but_not_run',
      reason: blocked
        ? 'No on-device ASR model, no 2h audio corpus, no devices D1-D7. Gate cannot be measured.'
        : 'Model URL provided; measurements require a real device/audio corpus and are not executed by this headless run.',
      device: 'D6 (desktop, headless Edge) — not an approved G1 device',
      checks,
      pipeline,
      scenarios: Array.from({ length: 12 }, (_, index) => ({
        id: `POC-G1-${String(index + 1).padStart(2, '0')}`,
        status: 'blocked',
      })),
      legalNote: 'Isolated prototype; audio is never uploaded; no product code imported.',
    };
  }

  async function main() {
    log('G1: checking environment...');
    const data = await probeEnvironment();
    window.__POC_G1__ = data;
    result.textContent = JSON.stringify(data);
    log(data.status === 'blocked' ? 'G1: BLOCKED — no model/corpus/devices' : 'G1: model URL present; measurement not executed');
    document.title = 'DONE';
  }

  main().catch((error) => {
    window.__POC_G1__ = { gate: 'G1', status: 'error', error: String(error) };
    result.textContent = JSON.stringify(window.__POC_G1__);
    document.title = 'DONE';
  });
})();
