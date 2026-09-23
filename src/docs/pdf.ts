import PDFDocument from 'pdfkit';
import { resolve } from 'node:path';
import type { ClaimDoc } from './claim.ts';
import { DEFAULT_REQUESTS_TITLE } from './claim.ts';

const FONT_DIR = process.env.FONT_DIR ?? resolve('assets/fonts');

/** PDF любого документа жителя: заявление, акт, требование, жалоба. */
export function claimToPdf(doc: ClaimDoc): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const heading = doc.heading ?? 'ЗАЯВЛЕНИЕ';
    const pdf = new PDFDocument({
      size: 'A4',
      margins: { top: 56, bottom: 56, left: 70, right: 56 },
      info: { Title: (doc.fileName ?? 'Заявление о перерасчёте').replace(/_/g, ' ').replace(/\.pdf$/, ''), Author: 'Бот «Вернём»', Subject: 'ПП РФ № 354' },
    });
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => ok(Buffer.concat(chunks)));
    pdf.on('error', fail);

    pdf.registerFont('regular', `${FONT_DIR}/DejaVuSans.ttf`);
    pdf.registerFont('bold', `${FONT_DIR}/DejaVuSans-Bold.ttf`);

    const left = pdf.page.margins.left;
    const width = pdf.page.width - left - pdf.page.margins.right;
    const headerX = left + width * 0.45;
    const headerW = width * 0.55;

    pdf.font('regular').fontSize(10);
    const header = [...doc.to, ...doc.from];
    for (const line of header) pdf.text(line, headerX, undefined, { width: headerW });

    if (header.length) pdf.moveDown(2);
    pdf.font('bold').fontSize(12).text(heading, left, undefined, { width, align: 'center' });
    pdf.font('regular').fontSize(10).text(doc.title.replace(/^\S+\s/, ''), { width, align: 'center' });
    pdf.moveDown(1.2);

    const para = (t: string, opts: PDFKit.Mixins.TextOptions = {}) => pdf.font('regular').fontSize(10.5).text(t, left, undefined, { width, align: 'left', lineGap: 2, ...opts });
    const title = (t: string) => pdf.font('bold').fontSize(10.5).text(t, left, undefined, { width });

    for (const f of doc.facts) para(f, f.startsWith('—') ? { indent: 16, align: 'left' } : {});
    if (doc.norm.length) {
      pdf.moveDown(0.6);
      for (const n of doc.norm) para(n);
    }

    if (doc.calc.length) {
      pdf.moveDown(0.6);
      title(doc.calcTitle ?? 'Расчёт');
      for (const c of doc.calc) {
        const indented = c.startsWith('  ');
        pdf.font('regular').fontSize(10).text(c.trim(), left + (indented ? 14 : 0), undefined, { width: width - (indented ? 14 : 0), lineGap: doc.calcGap ?? 1.5 });
      }
    }

    if (doc.requests.length) {
      pdf.moveDown(0.6);
      title(doc.requestsTitle ?? DEFAULT_REQUESTS_TITLE);
      for (const r of doc.requests) para(r, { indent: 0 });
    }

    if (doc.attachments?.length) {
      pdf.moveDown(0.6);
      title('Приложения:');
      doc.attachments.forEach((a, i) => para(`${i + 1}. ${a}`));
    }

    pdf.moveDown(0.8);
    pdf.font('regular').fontSize(8.5).fillColor('#444444').text(doc.note, left, undefined, { width, align: 'left' });
    pdf.fillColor('#000000');
    pdf.moveDown(2);
    pdf.font('regular').fontSize(10.5).text(doc.signature, left, undefined, { width });

    // Отметка о принятии — отделена пунктиром: её заполняет исполнитель на экземпляре жителя.
    if (doc.receipt?.length) {
      pdf.moveDown(1.5);
      const top = pdf.y;
      pdf.moveTo(left, top).lineTo(left + width, top).dash(3, { space: 3 }).strokeColor('#888888').stroke().undash().strokeColor('#000000');
      pdf.moveDown(0.6);
      const [head, ...rest] = doc.receipt;
      pdf.font('bold').fontSize(9.5).text(head, left, undefined, { width });
      pdf.moveDown(0.4);
      for (const line of rest) pdf.font('regular').fontSize(10).text(line, left, undefined, { width, lineGap: 6 });
    }

    pdf.end();
  });
}
