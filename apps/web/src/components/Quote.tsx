import { plainText } from "../lib/format";
import { markName } from "../lib/matrix";
import { Sources } from "./Sources";

interface QuoteProps {
  /** The assistant that gave the answer. */
  assistant: string;
  prompt: string | undefined;
  excerpt: string;
  /** The business, highlighted wherever the answer names it. */
  name: string;
  citedUrls: string[];
  /** The audit sets its quotes a size up. */
  large?: boolean;
}

/** One quoted answer, with the pages it cited. The yellow mark is the business's own name. */
export function Quote({ assistant, prompt, excerpt, name, citedUrls, large }: QuoteProps) {
  return (
    <figure className="card quote">
      <figcaption>
        <strong>{assistant}</strong>
        {prompt && <> · “{prompt}”</>}
      </figcaption>
      <blockquote className={large ? "quote-text quote-lg" : "quote-text"}>
        {markName(plainText(excerpt), name).map((part, index) =>
          part.marked ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
            <mark key={index}>{part.text}</mark>
          ) : (
            part.text
          ),
        )}
      </blockquote>
      <Sources urls={citedUrls} />
    </figure>
  );
}
