import { createRequire } from "node:module";
import type { BrowserContext } from "@playwright/test";

/** The reader's one file, which puts `jsQR` on a page it is loaded into. */
const READER = createRequire(import.meta.url).resolve("jsqr");

/**
 * Reads a QR code out of a picture, as a phone's camera would, and gives back what it holds.
 * Null where no code can be read in it. A reader that had no part in drawing the code does the
 * reading (jsQR), on a blank page of its own, so nothing of the app's page is touched.
 */
export async function readCode(context: BrowserContext, png: Buffer): Promise<string | null> {
  const page = await context.newPage();
  try {
    await page.addScriptTag({ path: READER });
    return await page.evaluate(
      async (source) => {
        const picture = new Image();
        picture.src = source;
        await picture.decode();
        const canvas = document.createElement("canvas");
        canvas.width = picture.naturalWidth;
        canvas.height = picture.naturalHeight;
        const drawing = canvas.getContext("2d");
        if (!drawing) return null;
        drawing.drawImage(picture, 0, 0);
        const { data, width, height } = drawing.getImageData(0, 0, canvas.width, canvas.height);
        const read = (
          window as unknown as {
            jsQR: (
              data: Uint8ClampedArray,
              width: number,
              height: number,
            ) => { data: string } | null;
          }
        ).jsQR(data, width, height);
        return read?.data ?? null;
      },
      `data:image/png;base64,${png.toString("base64")}`,
    );
  } finally {
    await page.close();
  }
}
