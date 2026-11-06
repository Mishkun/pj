import { fromMarkdown } from 'mdast-util-from-markdown';
import { decodeString } from 'micromark-util-decode-string';

/** Edit destination spans only; preserve frontmatter, code, titles and formatting. */
export function rewriteMarkdownLinks(text: string, rewrite: (url: string) => string): string {
  const start = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)?.[0].length ?? 0;
  const changes: Array<{ start: number; end: number; value: string }> = [];
  fromMarkdown(text.slice(start), {
    mdastExtensions: [{
      afterExit(token) {
        if (token.type !== 'resourceDestinationString' && token.type !== 'definitionDestinationString') return;
        const url = decodeString(this.sliceSerialize(token));
        const next = rewrite(url);
        if (next !== url) changes.push({ start: start + token.start.offset, end: start + token.end.offset, value: next });
      },
    }],
  });
  for (const change of changes.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, change.start) + change.value + text.slice(change.end);
  }
  return text;
}
