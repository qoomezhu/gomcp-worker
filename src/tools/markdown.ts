type PreferredMarkdownConverter = {
  translate(html: string): string;
};

let preferredConverter: PreferredMarkdownConverter | null = null;
let preferredConverterError: Error | null = null;

export async function convertHtmlToMarkdown(html: string): Promise<string> {
  try {
    const converter = await getPreferredConverter();
    const markdown = converter.translate(html);

    if (markdown.trim().length > 0) {
      return normalizeMarkdown(markdown);
    }

    throw new Error('Preferred converter returned empty Markdown');
  } catch (error: any) {
    console.warn('Preferred markdown conversion failed, using fallback converter.', error);
    return fallbackHtmlToMarkdown(html);
  }
}

export function fallbackHtmlToMarkdown(html: string): string {
  let sanitizedHtml = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, '')
    .replace(/<(meta|link)\b[^>]*>/gi, '');

  const placeholders: string[] = [];
  const stash = (value: string): string => {
    const token = `__GOMCP_MARKDOWN_${placeholders.length}__`;
    placeholders.push(value);
    return token;
  };

  sanitizedHtml = sanitizedHtml
    .replace(/<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_match, code) => {
      const decoded = decodeHtmlEntities(stripTags(code)).trim();
      return stash(`\n\`\`\`\n${decoded}\n\`\`\`\n`);
    })
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, code) => {
      const decoded = decodeHtmlEntities(stripTags(code)).trim();
      return stash(`\`${decoded}\``);
    });

  let markdown = sanitizedHtml
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, content) => {
      return `\n${'#'.repeat(Number(level))} ${collapseWhitespace(decodeHtmlEntities(stripTags(content)))}\n\n`;
    })
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, content) => {
      const text = collapseWhitespace(decodeHtmlEntities(stripTags(content)));
      return text ? `\n> ${text}\n\n` : '\n';
    })
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, text) => {
      const label = collapseWhitespace(decodeHtmlEntities(stripTags(text))) || href;
      return `[${label}](${href})`;
    })
    .replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*>/gi, (_match, alt, src) => {
      return `![${alt || ''}](${src})`;
    })
    .replace(/<img\b[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi, (_match, src, alt) => {
      return `![${alt || ''}](${src})`;
    })
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_match, content) => {
      return `\n- ${collapseWhitespace(decodeHtmlEntities(stripTags(content)))}`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|section|article|header|footer|main|aside|ul|ol|table|tr|tbody|thead|tfoot)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  markdown = decodeHtmlEntities(markdown);
  markdown = restorePlaceholders(markdown, placeholders);
  return normalizeMarkdown(markdown);
}

async function getPreferredConverter(): Promise<PreferredMarkdownConverter> {
  if (!preferredConverter && !preferredConverterError) {
    try {
      const module = await import('node-html-markdown-cloudflare');
      const NodeHtmlMarkdown = module.NodeHtmlMarkdown;
      preferredConverter = new NodeHtmlMarkdown({
        preferNativeParser: false,
        bulletMarker: '-',
        codeBlockStyle: 'fenced',
        emDelimiter: '*',
        strongDelimiter: '**',
        ignore: ['script', 'style', 'noscript', 'iframe', 'svg', 'meta', 'link'],
      });
    } catch (error: any) {
      preferredConverterError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (!preferredConverter) {
    throw preferredConverterError || new Error('node-html-markdown-cloudflare unavailable');
  }

  return preferredConverter;
}

function restorePlaceholders(markdown: string, placeholders: string[]): string {
  return placeholders.reduce((result, value, index) => {
    return result.replaceAll(`__GOMCP_MARKDOWN_${index}__`, value);
  }, markdown);
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, '');
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeMarkdown(markdown: string): string {
  return markdown
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}
