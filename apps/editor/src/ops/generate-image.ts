import { rectOf } from '../canvas/measure.ts';
import { session } from '../doc/session.ts';
import { openGenerateImage } from '../panels/GenerateImage.tsx';
import { editor } from '../state/store.ts';
import { placeImage } from './clipboard.ts';
import { setFields } from './ops.ts';

/** Generate image for an image layer: the picked picture becomes its src, and the description its alt when it had none. */
export function generateIntoLayer(nodeId: string): void {
  const node = session().snap.nodes.get(nodeId);
  if (!node) return;
  const r = rectOf(nodeId);
  openGenerateImage({
    into: node.name,
    ...(r && r.w > 0 && r.h > 0 ? { box: { width: r.w, height: r.h } } : {}),
    onPick: ({ src, prompt }) => {
      const now = session().snap.nodes.get(nodeId);
      if (!now) return;
      const alt = now.attrs?.alt?.trim() ? now.attrs.alt : prompt.slice(0, 300);
      setFields([nodeId], { src, attrs: { ...(now.attrs ?? {}), alt } });
    },
  });
}

/** Generate image from the palette: into the selected image layer, else a new image in the middle of the view. */
export function generateImageCommand(): void {
  const { selection } = editor();
  const only = selection.length === 1 ? session().snap.nodes.get(selection[0]!) : undefined;
  if (only?.type === 'image') return generateIntoLayer(only.id);
  openGenerateImage({ onPick: ({ src }) => void placeImage(src) });
}
