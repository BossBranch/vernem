import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_SIGNED_SCAN_BYTES = 10 * 1024 * 1024;

export type StoredSignedScan = {
  storageName: string;
  filename: string;
  mime: 'application/pdf';
  bytes: number;
};

/** Подписанный экземпляр принимаем только единым PDF, а не по расширению имени. */
export function validateSignedScan(data: Buffer): Omit<StoredSignedScan, 'storageName'> {
  if (!data.length) throw new Error('Файл пустой');
  if (data.length > MAX_SIGNED_SCAN_BYTES) throw new Error('Скан больше 10 МБ');
  if (!data.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Нужен PDF со сканом заполненного и подписанного заявления');
  return { filename: 'Подписанное_заявление.pdf', mime: 'application/pdf', bytes: data.length };
}

/** Каталог не публикуется веб-сервером; имя файла не содержит имени или адреса жителя. */
export function saveSignedScan(dir: string, data: Buffer): StoredSignedScan {
  const meta = validateSignedScan(data);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const storageName = `${randomBytes(24).toString('hex')}.pdf`;
  const target = join(dir, storageName);
  const temp = `${target}.tmp`;
  writeFileSync(temp, data, { mode: 0o600, flag: 'wx' });
  renameSync(temp, target);
  return { ...meta, storageName };
}

export function readSignedScan(dir: string, storageName: string): Buffer | null {
  if (!/^[a-f0-9]{48}\.pdf$/.test(storageName)) return null;
  try {
    return readFileSync(join(dir, storageName));
  } catch {
    return null;
  }
}

export function removeSignedScan(dir: string, storageName: string | null | undefined) {
  if (!storageName || !/^[a-f0-9]{48}\.pdf$/.test(storageName)) return;
  try {
    rmSync(join(dir, storageName), { force: true });
  } catch {
    // Файл мог уже удалить предыдущий повторный запрос или очистка по сроку.
  }
}
