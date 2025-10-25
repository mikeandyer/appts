import type { CheerioAPI } from 'cheerio';

function serializeNode($: CheerioAPI, node: any, depth = 0): string {
  if (depth > 50) return '';
  if (node.type === 'text') {
    return node.data ?? '';
  }
  if (node.type === 'comment') {
    return `<!--${node.data ?? ''}-->`;
  }
  if (node.type === 'tag') {
    const el = node as any;
    const tagName = el.name.toLowerCase();
    if (tagName === 'html' || tagName === 'body' || tagName === 'head') {
      const chunks: string[] = [];
      $(node)
        .contents()
        .each((_: unknown, child: any) => {
          chunks.push(serializeNode($, child, depth + 1));
        });
      return chunks.join('');
    }
    return $.html(node) ?? '';
  }
  return '';
}

function normalizeStackableAttributes(html: string): string {
  return html.replace(
    /(<!--\s*wp:stackable\/([a-z0-9-]+)\s+)(\{[\s\S]*?\})(\s*-->)/gi,
    (match, prefix, blockName, jsonPart, suffix) => {
      let fixedJson = jsonPart;
      if (blockName === 'video-popup') {
        fixedJson = fixedJson.replace(
          /("blockHeight"\s*:\s*)(-?\d+(?:\.\d+)?)(?=[,\}])/g,
          (_match: string, key: string, value: string) => `${key}"${value}"`,
        );
      }
      const escapedJson = fixedJson.replace(/(^|[^\\])\\u/g, (_match: string, prefix: string) => `${prefix}\\\\u`);
      return `${prefix}${escapedJson}${suffix}`;
    },
  );
}

export function serializeFragment($: CheerioAPI): string {
  const pieces: string[] = [];
  $.root()
    .contents()
    .each((_: unknown, node: any) => {
      pieces.push(serializeNode($, node));
    });
  return normalizeStackableAttributes(pieces.join(''));
}

