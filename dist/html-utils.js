function serializeNode($, node, depth = 0) {
    if (depth > 50)
        return '';
    if (node.type === 'text') {
        return node.data ?? '';
    }
    if (node.type === 'comment') {
        return `<!--${node.data ?? ''}-->`;
    }
    if (node.type === 'tag') {
        const el = node;
        const tagName = el.name.toLowerCase();
        if (tagName === 'html' || tagName === 'body' || tagName === 'head') {
            const chunks = [];
            $(node)
                .contents()
                .each((_, child) => {
                chunks.push(serializeNode($, child, depth + 1));
            });
            return chunks.join('');
        }
        return $.html(node) ?? '';
    }
    return '';
}
function normalizeStackableAttributes(html) {
    return html.replace(/(<!--\s*wp:stackable\/([a-z0-9-]+)\s+)(\{[\s\S]*?\})(\s*-->)/gi, (match, prefix, blockName, jsonPart, suffix) => {
        let fixedJson = jsonPart;
        if (blockName === 'video-popup') {
            fixedJson = fixedJson.replace(/("blockHeight"\s*:\s*)(-?\d+(?:\.\d+)?)(?=[,\}])/g, (_match, key, value) => `${key}"${value}"`);
        }
        const escapedJson = fixedJson.replace(/(^|[^\\])\\u/g, (_match, prefix) => `${prefix}\\\\u`);
        return `${prefix}${escapedJson}${suffix}`;
    });
}
export function serializeFragment($) {
    const pieces = [];
    $.root()
        .contents()
        .each((_, node) => {
        pieces.push(serializeNode($, node));
    });
    return normalizeStackableAttributes(pieces.join(''));
}
