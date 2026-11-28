import { useEffect, useRef, useState } from 'react';
import type { AttachmentRow } from '../db/schema';
import {
  buildScanPdf,
  compressScanImage,
  MAX_SCAN_PAGES,
  sha256Blob,
} from '../attachments/permit-scan';

export interface ScanPayload {
  pdf: Blob;
  pages: number;
  sha256: string;
}

interface ScanPage {
  id: string;
  image: Blob;
  preview: string;
}

interface Props {
  existing?: AttachmentRow;
  onChange: (payload: ScanPayload | null) => void;
  onBusy?: (busy: boolean) => void;
}

/**
 * Offline paper-permit scan: camera capture, up to 10 pages, client-side JPEG
 * compression and PDF assembly. No network is used until the entry syncs.
 */
export function PermitScanField({ existing, onChange, onBusy }: Props): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pages, setPages] = useState<ScanPage[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  useEffect(() => {
    return () => {
      for (const page of pagesRef.current) URL.revokeObjectURL(page.preview);
    };
  }, []);

  useEffect(() => {
    if (existing || pages.length === 0) {
      onChange(null);
      return;
    }
    let active = true;
    setBusy(true);
    onBusy?.(true);
    void (async () => {
      try {
        const pdf = await buildScanPdf(pages.map((page) => page.image));
        const sha256 = await sha256Blob(pdf);
        if (active) {
          setMessage(null);
          onChange({ pdf, pages: pages.length, sha256 });
        }
      } catch (error) {
        if (active) {
          setMessage(error instanceof Error ? error.message : 'Не удалось собрать PDF');
          onChange(null);
        }
      } finally {
        if (active) {
          setBusy(false);
          onBusy?.(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [existing, pages, onChange, onBusy]);

  const addFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    setMessage(null);
    const selected = [...files];
    if (pages.length + selected.length > MAX_SCAN_PAGES) {
      setMessage(`Не более ${MAX_SCAN_PAGES} страниц в одном скане`);
      return;
    }
    const next: ScanPage[] = [];
    for (const file of selected) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const image = await compressScanImage(file);
        next.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          image,
          preview: URL.createObjectURL(image),
        });
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Не удалось обработать фото');
      }
    }
    setPages((current) => [...current, ...next]);
    if (inputRef.current) inputRef.current.value = '';
  };

  const remove = (id: string): void => {
    setPages((current) => {
      const target = current.find((page) => page.id === id);
      if (target) URL.revokeObjectURL(target.preview);
      return current.filter((page) => page.id !== id);
    });
  };

  const move = (index: number, direction: -1 | 1): void => {
    setPages((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  };

  if (existing) {
    return (
      <div className="scan-box">
        <p>
          <strong>Скан наряда прикреплён</strong> · {existing.pages} стр. · статус:{' '}
          {existing.status}
        </p>
        <p className="hint">
          Копия бумажного наряда. Оригинал хранится на объекте. Повторная замена
          скана в демо не выполняется.
        </p>
      </div>
    );
  }

  return (
    <div className="scan-box">
      <div className="scan-box__actions">
        <button
          type="button"
          className="button button--ghost"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          📷 Прикрепить скан наряда
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          hidden
          onChange={(event) => void addFiles(event.target.files)}
        />
        <span className="hint">
          До {MAX_SCAN_PAGES} стр., до 20 МБ. Сжатие 1600 px / JPEG 0.8.
        </span>
      </div>
      {pages.length > 0 ? (
        <ol className="scan-pages">
          {pages.map((page, index) => (
            <li key={page.id} className="scan-page">
              <img src={page.preview} alt={`Страница скана ${index + 1}`} />
              <div className="scan-page__actions">
                <button
                  type="button"
                  className="button button--ghost button--small"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  aria-label="Выше"
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="button button--ghost button--small"
                  disabled={index === pages.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label="Ниже"
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="button button--ghost button--small"
                  onClick={() => remove(page.id)}
                  aria-label="Удалить страницу"
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      {busy ? <p className="hint">Собираем PDF…</p> : null}
      {message ? <p className="field__error">{message}</p> : null}
    </div>
  );
}
