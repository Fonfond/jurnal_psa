export const MAX_SCAN_PAGES = 10;
export const MAX_SCAN_BYTES = 20 * 1024 * 1024;
const MAX_EDGE_PX = 1600;
const JPEG_QUALITY = 0.8;

/** Compress a camera image to JPEG, preserving aspect ratio. */
export async function compressScanImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Не удалось подготовить изображение');
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );
    if (!blob) throw new Error('Не удалось сжать изображение');
    return blob;
  } finally {
    bitmap.close();
  }
}

/** Build one PDF from the ordered camera pages. */
export async function buildScanPdf(pages: Blob[]): Promise<Blob> {
  if (pages.length < 1 || pages.length > MAX_SCAN_PAGES) {
    throw new Error(`Скан должен содержать от 1 до ${MAX_SCAN_PAGES} страниц`);
  }
  // Keep pdf-lib out of the initial PWA bundle; it is loaded only when the
  // operator actually assembles a scan.
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const A4 = { width: 595.28, height: 841.89 };
  for (const pageBlob of pages) {
    const image = await pdf.embedJpg(new Uint8Array(await pageBlob.arrayBuffer()));
    const page = pdf.addPage([A4.width, A4.height]);
    const scale = Math.min(
      (A4.width - 32) / image.width,
      (A4.height - 32) / image.height,
    );
    const width = image.width * scale;
    const height = image.height * scale;
    page.drawImage(image, {
      x: (A4.width - width) / 2,
      y: (A4.height - height) / 2,
      width,
      height,
    });
  }
  const bytes = await pdf.save();
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
  if (blob.size > MAX_SCAN_BYTES) {
    throw new Error('PDF больше 20 МБ');
  }
  return blob;
}

export async function sha256Blob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
