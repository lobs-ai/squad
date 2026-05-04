import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  text: string;
  className?: string;
}

// Matches http/https URLs as the *entire* string. Used only on inline code
// spans, so we know the agent meant the contents to be a single URL — not
// a sentence containing one.
const URL_RE = /^https?:\/\/\S+$/;

const components: Components = {
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  // Agents routinely wrap URLs in backticks (`http://localhost:8080`).
  // remark-gfm's autolink-literal extension only fires on bare text, so
  // those land as inert <code> spans. Detect the URL-only case and wrap
  // the code in an anchor so it stays styled as code but is clickable.
  code: ({ children, className, ...props }) => {
    const text = typeof children === "string" ? children : "";
    const isFenced = className?.startsWith("language-") || text.includes("\n");
    if (!isFenced && URL_RE.test(text.trim())) {
      return (
        <a href={text.trim()} target="_blank" rel="noreferrer noopener">
          <code className={className} {...props}>
            {children}
          </code>
        </a>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

export const Markdown = memo(function Markdown({ text, className }: Props): JSX.Element {
  return (
    <div className={"md " + (className ?? "")}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
