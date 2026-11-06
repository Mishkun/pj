import { expect, test } from 'bun:test';
import { rewriteMarkdownLinks } from '../src/markdown.ts';

test('rewrites ordinary, angle and titled link destinations without touching layout', () => {
  const input = '[plain](docs/plain.md)\n'
    + '[angle](<docs/with space.md>)\n'
    + '[double](docs/double.md "Title [x](keep.md)")\n'
    + "[single](docs/single.md 'Single title')\n"
    + '[paren](docs/paren.md (Parenthesis title))\n';
  const seen: string[] = [];
  const actual = rewriteMarkdownLinks(input, url => { seen.push(url); return `moved/${url}`; });
  expect(actual).toBe('[plain](moved/docs/plain.md)\n'
    + '[angle](<moved/docs/with space.md>)\n'
    + '[double](moved/docs/double.md "Title [x](keep.md)")\n'
    + "[single](moved/docs/single.md 'Single title')\n"
    + '[paren](moved/docs/paren.md (Parenthesis title))\n');
  expect(seen).toEqual(['docs/plain.md', 'docs/with space.md', 'docs/double.md', 'docs/single.md', 'docs/paren.md']);
});

test('updates reference definitions while retaining labels, indentation and multiline titles', () => {
  const input = '[full][Ref]\n[collapsed][]\n[shortcut]\n\n'
    + '  [Ref]: <docs/ref space.md> "Reference title"\n'
    + "[collapsed]: docs/collapsed.md 'Another title'\n"
    + '[shortcut]: docs/shortcut.md\n  "Title on its own line"\n';
  const seen: string[] = [];
  expect(rewriteMarkdownLinks(input, url => { seen.push(url); return `moved/${url}`; })).toBe(
    '[full][Ref]\n[collapsed][]\n[shortcut]\n\n'
    + '  [Ref]: <moved/docs/ref space.md> "Reference title"\n'
    + "[collapsed]: moved/docs/collapsed.md 'Another title'\n"
    + '[shortcut]: moved/docs/shortcut.md\n  "Title on its own line"\n');
  expect(seen).toEqual(['docs/ref space.md', 'docs/collapsed.md', 'docs/shortcut.md']);
});

test('keeps YAML, fenced, indented and inline code byte-exact beside a real link', () => {
  const preserved = '---\nexample: "[yaml](docs/yaml.md)"\n---\n\n'
    + '```markdown\n[fenced](docs/fenced.md)\n[ref]: docs/ref.md\n```\n\n'
    + '~~~markdown\n[tilde](docs/tilde.md)\n~~~\n\n'
    + '    [indented](docs/indented.md)\n\n'
    + '`[inline](docs/inline.md)` and ``[double](docs/double.md) ` tick``\n\n';
  const seen: string[] = [];
  expect(rewriteMarkdownLinks(preserved + '[real](docs/real.md)\n', url => {
    seen.push(url); return `moved/${url}`;
  })).toBe(preserved + '[real](moved/docs/real.md)\n');
  expect(seen).toEqual(['docs/real.md']);
});

test('passes complete query and fragment suffixes to the callback', () => {
  const input = '[query](docs/a.md?x=1&y=two#section)\n'
    + '[fragment](docs/b.md#part?literal)\n'
    + '[encoded](docs/a%20b.md?next=a%2Fb#%D1%82)\n';
  const seen: string[] = [];
  expect(rewriteMarkdownLinks(input, url => { seen.push(url); return `moved/${url}`; })).toBe(
    '[query](moved/docs/a.md?x=1&y=two#section)\n'
    + '[fragment](moved/docs/b.md#part?literal)\n'
    + '[encoded](moved/docs/a%20b.md?next=a%2Fb#%D1%82)\n');
  expect(seen).toEqual(['docs/a.md?x=1&y=two#section', 'docs/b.md#part?literal', 'docs/a%20b.md?next=a%2Fb#%D1%82']);
});

test('finds image destinations inside a linked nested label and keeps label formatting', () => {
  const input = '[outer [nested] **bold** ![preview](images/thumb.png "Image title")](docs/page.md "Page title")\n';
  const seen: string[] = [];
  expect(rewriteMarkdownLinks(input, url => { seen.push(url); return `moved/${url}`; })).toBe(
    '[outer [nested] **bold** ![preview](moved/images/thumb.png "Image title")](moved/docs/page.md "Page title")\n');
  expect(seen).toEqual(['images/thumb.png', 'docs/page.md']);
});

test('decodes escaped parentheses and entities for rewriting and retains untouched source spelling', () => {
  const input = String.raw`[escaped](docs/a\(b\).md) [balanced](docs/a(b).md) [space](<docs/a b.md>) [entity](docs/a&#40;b&#41;.md)`;
  const seen: string[] = [];
  expect(rewriteMarkdownLinks(input, url => {
    seen.push(url);
    return `moved/${url.split('/').map(part => encodeURIComponent(part).replace(/[()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')}`;
  })).toBe('[escaped](moved/docs/a%28b%29.md) [balanced](moved/docs/a%28b%29.md) [space](<moved/docs/a%20b.md>) [entity](moved/docs/a%28b%29.md)');
  expect(seen).toEqual(['docs/a(b).md', 'docs/a(b).md', 'docs/a b.md', 'docs/a(b).md']);
  expect(rewriteMarkdownLinks(input, url => url)).toBe(input);
});

test('keeps CRLF and Unicode byte-exact with length-changing destination edits', () => {
  const input = '---\r\nexample: "[пример](старый.md)"\r\n---\r\n'
    + '😀 Кириллица e\u0301 [первый](docs/один.md) — [второй](<docs/два слова.md> "✓")\r\n\r\n'
    + '[ref]: docs/три.md "Заголовок"\r\n'
    + '`[код](docs/код.md)`\r\n';
  const expected = '---\r\nexample: "[пример](старый.md)"\r\n---\r\n'
    + '😀 Кириллица e\u0301 [первый](longer/prefix/docs/один.md) — [второй](<longer/prefix/docs/два слова.md> "✓")\r\n\r\n'
    + '[ref]: longer/prefix/docs/три.md "Заголовок"\r\n'
    + '`[код](docs/код.md)`\r\n';
  const seen: string[] = [];
  const actual = rewriteMarkdownLinks(input, url => { seen.push(url); return `longer/prefix/${url}`; });
  expect(Buffer.from(actual)).toEqual(Buffer.from(expected));
  expect(seen).toEqual(['docs/один.md', 'docs/два слова.md', 'docs/три.md']);
});
