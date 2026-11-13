import { clip, endPath, PDFDocument, PDFName, PDFOperator, popGraphicsState, pushGraphicsState, rectangle, rgb, StandardFonts } from 'pdf-lib';
import { encodePng } from '../src/pdf-import.ts';

/**
 * A small PDF with each kind of content the import handles: text in two fonts and sizes, a filled and stroked
 * rectangle, a line and a circle, an image, and a gradient that only works as a picture. A second page has one line.
 */
export async function fixturePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Quarterly report');
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  page.drawRectangle({ x: 50, y: 600, width: 200, height: 100, color: rgb(0.9, 0.3, 0.2), borderColor: rgb(0, 0, 0), borderWidth: 2 });
  page.drawText('Quarterly report', { x: 50, y: 720, size: 28, font: bold, color: rgb(0.1, 0.1, 0.4) });
  page.drawText('Revenue grew in every region.', { x: 50, y: 560, size: 12, font });
  page.drawText('Costs stayed flat.', { x: 50, y: 540, size: 12, font });
  page.drawLine({ start: { x: 50, y: 520 }, end: { x: 400, y: 520 }, thickness: 1, color: rgb(0.5, 0.5, 0.5) });
  page.drawCircle({ x: 400, y: 650, size: 40, color: rgb(0.2, 0.6, 0.3) });
  // A 4 x 4 picture, red on the left half and blue on the right.
  const px = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) px.set(i % 4 < 2 ? [220, 30, 30, 255] : [30, 30, 220, 255], i * 4);
  const image = await pdf.embedPng(encodePng(4, 4, px));
  page.drawImage(image, { x: 300, y: 380, width: 120, height: 120 });
  // An axial gradient, painted with sh inside a clip.
  const fn = pdf.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [1, 0.8, 0], C1: [0, 0.4, 1], N: 1 });
  const shading = pdf.context.register(pdf.context.obj({ ShadingType: 2, ColorSpace: 'DeviceRGB', Coords: [50, 0, 250, 0], Function: fn, Extend: [true, true] }));
  page.node.Resources()!.set(PDFName.of('Shading'), pdf.context.obj({ Sh1: shading }));
  page.pushOperators(pushGraphicsState(), rectangle(50, 380, 200, 120), clip(), endPath(), PDFOperator.of('sh' as never, [PDFName.of('Sh1')]), popGraphicsState());
  const second = pdf.addPage([400, 300]);
  second.drawText('Appendix', { x: 40, y: 240, size: 20, font: bold });
  return pdf.save();
}
