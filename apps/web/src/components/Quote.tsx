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
}

/** One quoted answer, with the pages it cited. The yellow mark is the business's own name. */
export function Quote({ assistant, prompt, excerpt, name, citedUrls }: QuoteProps) {
  return (
    <figure className="card quote">
      <figcaption>
        <strong>{assistant}</strong>
        {prompt && <> · “{prompt}”</>}
      </figcaption>
      <blockquote>
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
