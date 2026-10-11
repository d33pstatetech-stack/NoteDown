import { useMemo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { resolveImageSource, useAttachmentResolver, type AttachmentResolver } from "./attachment";

export interface MarkdownPreviewProps {
  markdown: string;
  /**
   * Reference → displayable URL. Resolved by the app (IndexedDB or the native
   * attachment store) so the preview never needs to know where bytes live.
   */
  imageUrls?: ReadonlyMap<string, string>;
  /** Fallback for references not present in `imageUrls`. */
  resolver?: AttachmentResolver;
  /** Archive/relative path of the note, used to resolve legacy relative refs. */
  notePath?: string;
  className?: string;
}

/**
 * Renders GitHub-Flavored Markdown. Raw HTML in a note is **not** executed or
 * inlined (no `rehype-raw`), so a note that came from an untrusted archive
 * cannot inject markup; HTML shows as escaped text instead.
 */
export function MarkdownPreview(props: MarkdownPreviewProps): ReactNode {
  const contextResolver = useAttachmentResolver();
  const resolver = props.resolver ?? contextResolver ?? undefined;
  const imageUrls = props.imageUrls;

  const components = useMemo<Components>(
    () => ({
      img: ({ src, alt, title }: { src?: string | undefined; alt?: string | undefined; title?: string | undefined }) => {
        const source = src
          ? resolveImageSource(src, {
              ...(imageUrls ? { imageUrls } : {}),
              ...(resolver ? { resolver } : {}),
              ...(props.notePath ? { notePath: props.notePath } : {}),
            })
          : null;
        if (!source) {
          return (
            <span className="ln-image-missing" role="img" aria-label={`Image not available: ${alt ?? src ?? "unknown"}`}>
              🖼 {alt ?? src ?? "image"} <em>(image not available)</em>
            </span>
          );
        }
        return <img src={source} alt={alt ?? ""} title={title ?? undefined} loading="lazy" />;
      },
      a: ({ href, children }) => (
        <a href={href ?? "#"} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      ),
    }),
    [imageUrls, resolver, props.notePath],
  );

  return (
    <div
      className={props.className ? `ln-preview ${props.className}` : "ln-preview"}
      data-testid="markdown-preview"
    >
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {props.markdown}
      </Markdown>
    </div>
  );
}
