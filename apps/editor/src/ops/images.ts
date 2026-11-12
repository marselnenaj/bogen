import { pasteImage } from './clipboard.ts';

/** Opens the file picker and places what is chosen in the middle of the view. */
export function pickImage(onPicked?: (file: File) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = !onPicked;
  input.onchange = () => {
    const files = [...(input.files ?? [])];
    if (onPicked) {
      if (files[0]) onPicked(files[0]);
      return;
    }
    files.forEach((f) => void pasteImage(f));
  };
  input.click();
}
