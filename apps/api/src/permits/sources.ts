import { parseCsv, toIso } from './csv';

/**
 * Permit source adapter abstraction (OQ-03).
 *
 * A source may be a CSV export from the permit system, a JSON feed, or a
 * deep-link payload. The import pipeline is source-agnostic: adapters only
 * normalise rows, while idempotency and persistence live in PermitsService.
 */

export interface PermitSourceInput {
  csv?: string;
  records?: Array<Record<string, unknown>>;
}

export interface ParsedPermitRow {
  /** 1-based line/record number for error reports. */
  row: number;
  data: Record<string, unknown>;
}

export interface PermitSourceAdapter {
  readonly id: string;
  readonly kind: 'csv' | 'json';
  parse(input: PermitSourceInput): ParsedPermitRow[];
}

function normalizeRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...record,
    year: record.year,
    valid_from: toIso(String(record.valid_from ?? '')),
    valid_to: toIso(String(record.valid_to ?? '')),
    type: record.type || 'permit_to_work',
    external_url: record.external_url || undefined,
    pdf_url: record.pdf_url || undefined,
    pdf_hash: record.pdf_hash || undefined,
  };
}

export class CsvPermitSourceAdapter implements PermitSourceAdapter {
  readonly id = 'csv';
  readonly kind = 'csv' as const;

  parse(input: PermitSourceInput): ParsedPermitRow[] {
    if (!input.csv) {
      throw new Error('CSV-источник: не передано содержимое файла');
    }
    const rows = parseCsv(input.csv);
    if (rows.length < 2) {
      throw new Error('CSV должен содержать заголовок и хотя бы одну строку');
    }
    const header = rows[0]!.map((cell) => cell.trim());
    return rows.slice(1).map((values, index) => {
      const record: Record<string, unknown> = {};
      header.forEach((key, column) => {
        record[key] = values[column] ?? '';
      });
      return { row: index + 2, data: normalizeRecord(record) };
    });
  }
}

export class JsonPermitSourceAdapter implements PermitSourceAdapter {
  readonly id = 'json';
  readonly kind = 'json' as const;

  parse(input: PermitSourceInput): ParsedPermitRow[] {
    if (!input.records || input.records.length === 0) {
      throw new Error('JSON-источник: не переданы записи нарядов');
    }
    return input.records.map((record, index) => ({
      row: index + 2,
      data: normalizeRecord(record),
    }));
  }
}

export const permitSourceAdapters: Record<string, PermitSourceAdapter> = {
  csv: new CsvPermitSourceAdapter(),
  json: new JsonPermitSourceAdapter(),
};

/** Picks the adapter from the payload shape; JSON records win over CSV. */
export function selectPermitSourceAdapter(input: PermitSourceInput): PermitSourceAdapter {
  return input.records && input.records.length > 0
    ? permitSourceAdapters.json!
    : permitSourceAdapters.csv!;
}
