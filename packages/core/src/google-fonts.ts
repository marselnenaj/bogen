/** Width ranges of Google Fonts families with a `wdth` axis whose css2 request below is checked to answer. The legacy API serves only their normal width. */
export const GOOGLE_WIDTH_AXES: Record<string, readonly [number, number]> = {
  Anybody: [50, 150],
  Archivo: [62, 125],
  'Encode Sans': [75, 125],
  'Noto Sans': [62.5, 100],
  Roboto: [75, 100],
  'Roboto Flex': [25, 151],
  Saira: [50, 125],
};

/**
 * Stylesheets that load a family. The lenient v1 API returns whichever weights a family has, where css2
 * fails on a missing one; a family with a width axis also gets a css2 sheet for its whole width range.
 */
export function googleFontsHrefs(family: string): string[] {
  const name = encodeURIComponent(family).replace(/%20/g, '+');
  const hrefs = [`https://fonts.googleapis.com/css?family=${name}:100,200,300,400,500,600,700,800,900,400i,700i&display=swap`];
  const width = GOOGLE_WIDTH_AXES[family];
  if (width && width[0] !== width[1]) {
    const range = `${width[0]}..${width[1]}`;
    hrefs.push(`https://fonts.googleapis.com/css2?family=${name}:ital,wdth,wght@0,${range},100..900;1,${range},100..900&display=swap`);
  }
  return hrefs;
}
