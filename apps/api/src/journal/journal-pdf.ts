import {
  buildPdfPages,
  wrapPdfText,
  type PdfTextRun,
} from '../permits/pdf';

export interface JournalPdfEntry {
  id: string;
  journal_seq: number | null;
  performed_at: string;
  event_type: string;
  text: string;
  comment: string | null;
  verified_at: string | null;
  author_name: string | null;
  /** Signature state of the entry visa: valid/invalid/none. */
  signature_status?: 'valid' | 'invalid' | 'none';
}

export interface JournalPdfInput {
  journal_name: string;
  journal_key: string;
  from: string | null;
  to: string | null;
  generated_at: string;
  entries: JournalPdfEntry[];
  legal_note: string;
}

const EVENT_LABELS: Record<string, string> = {
  work: 'Работа',
  command: 'Команда',
  switching: 'Переключение',
  grounding: 'Заземление',
  incident: 'Инцидент',
  other: 'Другое',
};

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}`;
}

interface RowLayout {
  left: string[];
  middle: string[];
  right: string[];
  height: number;
}

/**
 * Server-side 3-column operational journal (order 757 form): date/sequence,
 * content, visas/remarks. Pages are paginated and include journal metadata.
 */
export function buildJournalPdf(input: JournalPdfInput): Buffer {
  const width = 595;
  const height = 842;
  const margin = 30;
  const leftWidth = 115;
  const middleWidth = 275;
  const rightWidth = 115;
  const lineHeight = 11;
  const rowPadding = 6;

  const rows: RowLayout[] = input.entries.map((entry) => {
    const left = [
      formatDateTime(entry.performed_at),
      `№ ${entry.journal_seq ?? '—'}`,
    ];
    const middle = [
      `[${EVENT_LABELS[entry.event_type] ?? entry.event_type}]`,
      ...wrapPdfText(entry.text, 9, middleWidth),
    ];
    if (entry.comment) {
      middle.push(...wrapPdfText(`Комментарий: ${entry.comment}`, 8, middleWidth));
    }
    const right: string[] = [];
    if (entry.verified_at) {
      right.push('Проверено:', formatDateTime(entry.verified_at));
    } else {
      right.push('Не проверено');
    }
    if (entry.signature_status === 'valid') {
      right.push('ЭП: подпись действительна');
    } else if (entry.signature_status === 'invalid') {
      right.push('ЭП: подпись недействительна');
    } else {
      right.push('ЭП: нет');
    }
    return {
      left,
      middle,
      right,
      height: Math.max(left.length, middle.length, right.length) * lineHeight + rowPadding,
    };
  });

  const pagesRuns: PdfTextRun[][] = [];
  let current: PdfTextRun[] = [];
  let y = height - margin - 10;

  const pageHeader = (): void => {
    y = height - margin - 10;
    current.push({ text: 'Оперативный журнал', size: 14, x: margin, y });
    y -= 18;
    current.push({
      text: `${input.journal_name} (${input.journal_key})`,
      size: 10,
      x: margin,
      y,
    });
    y -= 14;
    const period = `${input.from ?? 'начало'} — ${input.to ?? 'по настоящее время'}`;
    current.push({
      text: `Период: ${period} · сформировано: ${input.generated_at}`,
      size: 8,
      x: margin,
      y,
    });
    y -= 16;
    current.push({ text: 'Дата, время / №', size: 9, x: margin, y });
    current.push({
      text: 'Содержание сообщений в течение смены',
      size: 9,
      x: margin + leftWidth + 10,
      y,
    });
    current.push({
      text: 'Визы, замечания',
      size: 9,
      x: margin + leftWidth + middleWidth + 20,
      y,
    });
    y -= 12;
    current.push({
      text: '-'.repeat(96),
      size: 8,
      x: margin,
      y,
    });
    y -= 8;
  };

  pageHeader();

  for (const row of rows) {
    if (y - row.height < margin + 40) {
      pagesRuns.push(current);
      current = [];
      pageHeader();
    }
    const middleX = margin + leftWidth + 10;
    const rightX = margin + leftWidth + middleWidth + 20;
    const maxLines = Math.max(row.left.length, row.middle.length, row.right.length);
    for (let index = 0; index < maxLines; index += 1) {
      const lineY = y - index * lineHeight;
      if (row.left[index]) {
        current.push({ text: row.left[index]!, size: 8, x: margin, y: lineY });
      }
      if (row.middle[index]) {
        current.push({ text: row.middle[index]!, size: 9, x: middleX, y: lineY });
      }
      if (row.right[index]) {
        current.push({ text: row.right[index]!, size: 8, x: rightX, y: lineY });
      }
    }
    y -= row.height;
  }

  if (current.length > 0) {
    pagesRuns.push(current);
  }
  if (pagesRuns.length === 0) {
    pagesRuns.push([]);
  }

  const totalPages = pagesRuns.length;
  pagesRuns.forEach((runs, index) => {
    runs.push({
      text: `Страница ${index + 1} из ${totalPages}`,
      size: 8,
      x: margin,
      y: margin,
    });
    runs.push({
      text: 'ЭОЖ Logbook · хранение ≥ 3 лет · подпись/ЭП по OQ-04',
      size: 7,
      x: margin,
      y: margin + 12,
    });
    runs.push({
      text: input.legal_note.slice(0, 140),
      size: 7,
      x: margin,
      y: margin + 24,
    });
  });

  return buildPdfPages(pagesRuns, width, height);
}
