import type { Asking } from "@nearcited/shared";
import { QRCodeCanvas, QRCodeSVG } from "qrcode.react";
import { useRef, useState } from "react";
import { CODE, CODE_WORDS, codeFileName, codeTitle } from "../lib/asking";

/**
 * The link a customer is sent, as a QR code. It is drawn here, in the browser: the link goes
 * nowhere to be made into one, and the code holds the site's own address, so it opens for as
 * long as that page is there. Its size is the stylesheet's to set.
 */
export function ReviewCode({ link }: { link: string }) {
  return (
    <QRCodeSVG
      className="review-code"
      role="img"
      value={link}
      title={codeTitle(link)}
      level={CODE.level}
      marginSize={CODE.margin}
      fgColor={CODE.dark}
      bgColor={CODE.light}
    />
  );
}

/**
 * The same code as a picture to save, for a receipt, a sign or anything else the owner lays out
 * themselves. It is drawn large and out of sight, and saved from there when asked for.
 */
export function DownloadCode({ given }: { given: Asking }) {
  const picture = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  function download() {
    try {
      const drawn = picture.current;
      if (!drawn) throw new Error("The picture has not been drawn");
      const save = document.createElement("a");
      save.href = drawn.toDataURL("image/png");
      save.download = codeFileName(given);
      save.click();
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  return (
    <>
      <button type="button" className="secondary" onClick={download}>
        {CODE_WORDS.download}
      </button>
      <span role="status">
        {failed && "It could not be saved for you. Print the card, or take a picture of the code."}
      </span>
      <QRCodeCanvas
        ref={picture}
        style={{ display: "none" }}
        aria-hidden="true"
        value={given.link}
        size={CODE.picture}
        level={CODE.level}
        marginSize={CODE.margin}
        fgColor={CODE.dark}
        bgColor={CODE.light}
      />
    </>
  );
}
