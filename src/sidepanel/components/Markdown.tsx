/**
 * 説明文の Markdown を、`renderMarkdown` で ref の要素に描く。
 * 画像の参照は、参照元ファイルの場所を起点に解決し、画像の URL 管理から表示できる URL を得てから描く
 * （得られなかったものは代替文になる）。画像が無ければすぐに描く。
 * 画像のパスは、取り込み・`renderMarkdown` と同じ形（decodeURIComponent したパス）で扱う。日本語やスペースを含む名前もこの形で一致する。
 */
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { decodeImagePath, extractMarkdownImages, isDataUrl, resolveRelative } from '../../core/package/index.ts';
import { renderMarkdown } from '../../core/markdown/index.ts';
import type { Assets } from '../assets/index.ts';

interface MarkdownProps {
  text: string;
  /** 画像の相対パスの起点（パッケージ内のパス）。 */
  baseFile: string;
  tourId: string;
  hash: string;
  origins: readonly string[];
  assets: Assets;
}

export function Markdown(props: MarkdownProps): ReactNode {
  const { text, baseFile, tourId, hash, origins, assets } = props;
  const ref = useRef<HTMLDivElement | null>(null);
  // 配列の同一性が毎回変わっても描き直さないよう、値で比べる
  const originsKey = origins.join('\n');

  useEffect(() => {
    const container = ref.current;
    if (container === null) return;
    let cancelled = false;
    const hosts = originsKey === '' ? [] : originsKey.split('\n');
    const draw = (urls: ReadonlyMap<string, string>): void => {
      if (!cancelled) renderMarkdown(text, container, (src) => urls.get(src) ?? null, hosts);
    };

    // 戻せないパス（不正な %）は表の鍵にしない。`renderMarkdown` も戻せずに代替文を出す
    const sources = [
      ...new Set(
        extractMarkdownImages(text)
          .map((image) => decodeImagePath(image.src))
          .filter((path): path is string => path !== null),
      ),
    ];
    if (sources.length === 0) {
      draw(new Map());
    } else {
      const resolveOne = async (src: string): Promise<string | null> => {
        if (isDataUrl(src)) return src;
        const resolved = resolveRelative(baseFile, src);
        return resolved.ok ? assets.resolve(tourId, hash, resolved.path) : null;
      };
      void Promise.all(
        sources.map(async (src) => {
          try {
            return [src, await resolveOne(src)] as const;
          } catch {
            return [src, null] as const;
          }
        }),
      ).then((pairs) => {
        const urls = new Map<string, string>();
        for (const [src, url] of pairs) if (url !== null) urls.set(src, url);
        draw(urls);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [text, baseFile, tourId, hash, originsKey, assets]);

  return <div className="markdown" ref={ref} />;
}
