import { describe, expect, it } from 'vitest';
import { fallbackHtmlToMarkdown } from '../../src/tools/markdown';

describe('fallbackHtmlToMarkdown', () => {
  it('converts headings, links, and list items into readable markdown', () => {
    const markdown = fallbackHtmlToMarkdown(
      '<h1>Title</h1><p>Hello <a href="https://example.com">world</a></p><ul><li>One</li><li>Two</li></ul>'
    );

    expect(markdown).toContain('# Title');
    expect(markdown).toContain('Hello [world](https://example.com)');
    expect(markdown).toContain('- One');
    expect(markdown).toContain('- Two');
  });

  it('preserves fenced code blocks and decodes common entities', () => {
    const markdown = fallbackHtmlToMarkdown(
      '<pre><code>const x = 1 &lt; 2 &amp;&amp; 3 &gt; 2;</code></pre>'
    );

    expect(markdown).toContain('```');
    expect(markdown).toContain('const x = 1 < 2 && 3 > 2;');
  });
});
