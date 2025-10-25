import { load } from 'cheerio';
import { serializeFragment } from './html-utils.js';
import { parseJsonArray } from './utils.js';
export function shouldAttemptHeroReplacement({ html, pageSlug, pageIndex, apiKey, }) {
    if (!apiKey)
        return false;
    if (!html.trim())
        return false;
    const hasImg = /<img\b/i.test(html);
    const hasBackground = /background-image:\s*url\(/i.test(html) || /"blockBackgroundMediaUrl"\s*:\s*"/i.test(html);
    if (!hasImg && !hasBackground)
        return false;
    if (/data-pexels-url/i.test(html))
        return false;
    if (pageIndex === 0)
        return true;
    const normalized = pageSlug.toLowerCase();
    return normalized.includes('home') || normalized.includes('landing') || normalized.includes('hero');
}
export async function selectHeroImage(brief, pageIntent, language, target, config) {
    const pexelsKey = config.pexelsApiKey.trim();
    if (!pexelsKey)
        return null;
    if (!brief)
        return null;
    const hasContext = Boolean(brief.description && brief.description.trim()) ||
        Boolean(brief.industry && brief.industry.trim()) ||
        Boolean(brief.businessName && brief.businessName.trim());
    if (!hasContext)
        return null;
    const suggestions = await deepseekSuggestImageQueries(brief, pageIntent, language, config);
    const fallbacks = [
        [brief.businessName, brief.industry].filter(Boolean).join(' '),
        [brief.industry, pageIntent].filter(Boolean).join(' '),
        brief.description?.split(/[.!?]/, 1)?.[0] ?? '',
    ];
    const combined = [...suggestions, ...fallbacks].slice(0, 8);
    const seen = new Set();
    for (const candidate of combined) {
        const query = candidate?.trim();
        if (!query)
            continue;
        const key = query.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        const photo = await fetchPexelsHeroImage(query, target ?? undefined, config);
        if (photo) {
            const dims = photo.width && photo.height ? ` (${Math.round(photo.width)}x${Math.round(photo.height)})` : '';
            console.log(`[worker] hero image selected via Pexels query "${query}"${dims}`);
            return photo;
        }
    }
    return null;
}
async function deepseekSuggestImageQueries(brief, pageIntent, language, config) {
    const apiKey = config.deepseekApiKey.trim();
    if (!apiKey)
        return [];
    const descriptionLines = [
        brief.businessName ? `品牌名稱：${brief.businessName}` : '',
        brief.industry ? `產業：${brief.industry}` : '',
        brief.description ? `描述：${brief.description}` : '',
        brief.tone ? `語氣：${brief.tone}` : '',
        pageIntent ? `頁面用途：${pageIntent}` : '',
        language ? `語言：${language}` : '',
    ]
        .filter(Boolean)
        .join('\n');
    const systemMessage = '你是一位網站視覺設計助理。任務：根據提供的品牌資訊，產出 1 到 3 個英文關鍵字組合，用於搜尋符合品牌形象的形象照片。' +
        '嚴格規定：只回傳 JSON 字串陣列，元素需為簡潔的英文片語，不得包含解說或其他文字。';
    const userMessage = `${descriptionLines}\n\n請提供 JSON 陣列，例如 ["modern bakery storefront", "artisan bread display"].`;
    try {
        const response = await config.openai.chat.completions.create({
            model: config.deepseekModel,
            messages: [
                { role: 'system', content: systemMessage },
                { role: 'user', content: userMessage },
            ],
            temperature: 0.4,
            max_tokens: 400,
        });
        const content = response.choices.at(0)?.message?.content?.trim() ?? '';
        const parsed = parseJsonArray(content);
        return parsed.map((item) => item.trim()).filter(Boolean);
    }
    catch (error) {
        console.error('[worker] deepseek image query suggestion failed', error);
        return [];
    }
}
async function fetchPexelsHeroImage(query, target, config) {
    const apiKey = config.pexelsApiKey.trim();
    if (!apiKey)
        return null;
    const params = new URLSearchParams();
    params.set('query', query);
    params.set('per_page', '6');
    params.set('orientation', 'landscape');
    params.set('size', 'large');
    const baseUrl = (config.pexelsApiBaseUrl || 'https://api.pexels.com/v1').replace(/\/+$/, '');
    const endpoint = `${baseUrl}/search?${params.toString()}`;
    try {
        const response = await fetch(endpoint, {
            headers: {
                Authorization: apiKey,
            },
        });
        if (!response.ok) {
            console.warn(`[worker] Pexels search failed (status=${response.status}) for query "${query}"`);
            return null;
        }
        const data = (await response.json());
        const photos = Array.isArray(data.photos) ? data.photos : [];
        if (!photos.length)
            return null;
        const selected = chooseBestPhoto(photos, target);
        if (!selected)
            return null;
        const { url, width, height } = buildPexelsUrl(selected, target);
        if (!url)
            return null;
        return {
            url,
            alt: selected.alt?.trim() || query,
            photographer: selected.photographer ?? '',
            attributionUrl: selected.url ?? selected.photographer_url ?? '',
            query,
            width,
            height,
        };
    }
    catch (error) {
        console.error(`[worker] Pexels search error for query "${query}"`, error);
        return null;
    }
}
export function replaceHeroImage(html, hero) {
    if (!html.trim())
        return html;
    const $ = load(html, { decodeEntities: false });
    const firstImg = $('img').first();
    let replaced = false;
    if (firstImg.length) {
        firstImg.attr('src', hero.url);
        firstImg.attr('alt', hero.alt || 'Hero image');
        if (hero.width && !firstImg.attr('width')) {
            firstImg.attr('width', String(Math.round(hero.width)));
        }
        if (hero.height && !firstImg.attr('height')) {
            firstImg.attr('height', String(Math.round(hero.height)));
        }
        if (hero.photographer) {
            firstImg.attr('data-pexels-photographer', hero.photographer);
        }
        else {
            firstImg.removeAttr('data-pexels-photographer');
        }
        if (hero.attributionUrl) {
            firstImg.attr('data-pexels-url', hero.attributionUrl);
        }
        else {
            firstImg.removeAttr('data-pexels-url');
        }
        firstImg.attr('data-pexels-query', hero.query);
        firstImg.removeAttr('srcset');
        replaced = true;
    }
    if (!replaced) {
        const backgroundElement = $('[style*="background-image"]').first();
        if (backgroundElement.length) {
            const styleAttr = backgroundElement.attr('style') ?? '';
            const updatedStyle = styleAttr.replace(/background-image:\s*url\((['"]?)[^\)]+?\1\)/i, (match) => {
                return match.replace(/url\((['"]?)[^\)]+?\1\)/i, `url(${hero.url})`);
            });
            if (updatedStyle !== styleAttr) {
                backgroundElement.attr('style', updatedStyle);
                backgroundElement.attr('data-pexels-query', hero.query);
                if (hero.photographer) {
                    backgroundElement.attr('data-pexels-photographer', hero.photographer);
                }
                else {
                    backgroundElement.removeAttr('data-pexels-photographer');
                }
                if (hero.attributionUrl) {
                    backgroundElement.attr('data-pexels-url', hero.attributionUrl);
                }
                else {
                    backgroundElement.removeAttr('data-pexels-url');
                }
                replaced = true;
            }
        }
    }
    let serialized = serializeFragment($);
    if (!serialized) {
        return html;
    }
    if (!replaced) {
        serialized = replaceFirstBackgroundUrl(serialized, hero.url);
        return serialized;
    }
    serialized = replaceFirstBackgroundUrl(serialized, hero.url);
    return serialized;
}
export function detectHeroTarget(html) {
    if (!html.trim())
        return null;
    const $ = load(html, { decodeEntities: false });
    const img = $('img').first();
    const imgWidth = parseDimension(img.attr('width')) ?? parseDimension(img.attr('data-width'));
    const imgHeight = parseDimension(img.attr('height')) ?? parseDimension(img.attr('data-height'));
    const style = img.attr('style') ?? '';
    const styleWidth = parseDimensionFromStyle(style, 'width');
    const styleHeight = parseDimensionFromStyle(style, 'height');
    const aspectFromStyle = parseAspectRatio(style);
    const width = imgWidth ?? styleWidth;
    const height = imgHeight ?? styleHeight;
    let aspect = aspectFromStyle;
    if (width && height) {
        aspect = aspect ?? width / height;
        return { width, height, aspectRatio: aspect };
    }
    if (width && aspect) {
        const inferredHeight = Math.max(1, Math.round(width / aspect));
        return { width, height: inferredHeight, aspectRatio: aspect };
    }
    if (height && aspect) {
        const inferredWidth = Math.max(1, Math.round(height * aspect));
        return { width: inferredWidth, height, aspectRatio: aspect };
    }
    const background = $('[style*="background-image"]').first();
    if (background.length) {
        const bgStyle = background.attr('style') ?? '';
        const bgWidth = parseDimensionFromStyle(bgStyle, 'width') ?? parseDimension(background.attr('data-width'));
        const bgHeight = parseDimensionFromStyle(bgStyle, 'height') ??
            parseDimension(background.attr('data-height')) ??
            parseDimensionFromStyle(bgStyle, 'min-height');
        const bgAspect = parseAspectRatio(bgStyle) ?? aspect;
        if (bgWidth && bgHeight) {
            return { width: bgWidth, height: bgHeight, aspectRatio: bgAspect ?? bgWidth / bgHeight };
        }
        if (bgWidth && bgAspect) {
            return { width: bgWidth, height: Math.max(1, Math.round(bgWidth / bgAspect)), aspectRatio: bgAspect };
        }
        if (bgHeight && bgAspect) {
            return { width: Math.max(1, Math.round(bgHeight * bgAspect)), height: bgHeight, aspectRatio: bgAspect };
        }
    }
    const commentTarget = extractDimensionsFromComments(html);
    if (commentTarget) {
        return commentTarget;
    }
    if (aspect) {
        return { aspectRatio: aspect };
    }
    return null;
}
function replaceFirstBackgroundUrl(html, url) {
    let updated = html;
    let replacedJson = false;
    updated = updated.replace(/("blockBackgroundMediaUrl"\s*:\s*")([^"]+)(")/, (_match, prefix, _oldUrl, suffix) => {
        replacedJson = true;
        return `${prefix}${escapeForJson(url)}${suffix}`;
    });
    let replacedCover = false;
    updated = updated.replace(/("url"\s*:\s*")([^"]+)(")/, (match, prefix, _oldUrl, suffix) => {
        if (replacedCover)
            return match;
        if (!match.includes('http'))
            return match;
        replacedCover = true;
        return `${prefix}${escapeForJson(url)}${suffix}`;
    });
    let replacedStyle = false;
    updated = updated.replace(/(background-image:\s*url\()([^)]+)(\))/i, (_match, prefix, _old, suffix) => {
        replacedStyle = true;
        return `${prefix}${url}${suffix}`;
    });
    if (!replacedJson && !replacedCover && !replacedStyle) {
        return updated;
    }
    return updated;
}
function escapeForJson(value) {
    return JSON.stringify(value).slice(1, -1);
}
function parseDimension(value) {
    if (!value)
        return undefined;
    const match = String(value).match(/(-?\d+(?:\.\d+)?)/);
    if (!match)
        return undefined;
    const num = Number.parseFloat(match[1]);
    if (!Number.isFinite(num) || num <= 0)
        return undefined;
    return num;
}
function parseDimensionFromStyle(style, property) {
    if (!style)
        return undefined;
    const regexp = new RegExp(`${property}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)(px|rem|em|vw|vh)?`, 'i');
    const match = style.match(regexp);
    if (!match)
        return undefined;
    const num = Number.parseFloat(match[1]);
    if (!Number.isFinite(num) || num <= 0)
        return undefined;
    const unit = match[2]?.toLowerCase() ?? 'px';
    switch (unit) {
        case 'px':
            return num;
        case 'rem':
        case 'em':
            return num * 16;
        case 'vw':
            return (num / 100) * 1920;
        case 'vh':
            return (num / 100) * 1080;
        default:
            return num;
    }
}
function parseAspectRatio(style) {
    if (!style)
        return undefined;
    const ratioMatch = style.match(/aspect-ratio\s*:\s*(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/i);
    if (ratioMatch) {
        const width = Number.parseFloat(ratioMatch[1]);
        const height = Number.parseFloat(ratioMatch[2]);
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
            return width / height;
        }
    }
    const single = style.match(/aspect-ratio\s*:\s*(-?\d+(?:\.\d+)?)/i);
    if (single) {
        const ratio = Number.parseFloat(single[1]);
        if (Number.isFinite(ratio) && ratio > 0) {
            return ratio;
        }
    }
    return undefined;
}
function extractDimensionsFromComments(html) {
    const commentRegex = /<!--\s*wp:stackable\/(?:hero|image|columns)[^>]*?({[\s\S]*?})\s*-->/gi;
    let match;
    while ((match = commentRegex.exec(html))) {
        const jsonPart = match[1];
        try {
            const parsed = JSON.parse(jsonPart);
            const width = parseDimension(parsed.width) ||
                parseDimension(parsed.imageWidth) ||
                parseDimension(parsed.resizedWidth);
            const height = parseDimension(parsed.height) ||
                parseDimension(parsed.imageHeight) ||
                parseDimension(parsed.resizedHeight);
            if (width && height) {
                return { width, height, aspectRatio: width / height };
            }
            const ratio = parseDimension(parsed.aspectRatio ?? undefined);
            if (width && ratio) {
                return { width, height: Math.max(1, Math.round(width / ratio)), aspectRatio: ratio };
            }
            if (height && ratio) {
                return { width: Math.max(1, Math.round(height * ratio)), height, aspectRatio: ratio };
            }
        }
        catch {
            continue;
        }
    }
    return null;
}
function chooseBestPhoto(photos, target) {
    if (!photos.length)
        return undefined;
    const targetRatio = target?.aspectRatio ??
        (target?.width && target?.height && target.height !== 0 ? target.width / target.height : undefined);
    const targetArea = target?.width && target?.height ? target.width * target.height : undefined;
    let best;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestArea = 0;
    for (const photo of photos) {
        const width = photo.width ?? 0;
        const height = photo.height ?? 0;
        const area = width * height;
        const ratio = width && height ? width / height : undefined;
        if (!targetRatio && !targetArea) {
            if (!best || area > bestArea) {
                best = photo;
                bestArea = area;
            }
            continue;
        }
        let score = 0;
        if (targetRatio && ratio) {
            score += Math.abs(ratio - targetRatio);
        }
        if (targetArea && area) {
            const areaDiff = Math.abs(area - targetArea);
            const normalized = targetArea > 0 ? areaDiff / targetArea : areaDiff;
            score += normalized * 0.1;
        }
        if (!best || score < bestScore || (score === bestScore && area > bestArea)) {
            best = photo;
            bestScore = score;
            bestArea = area;
        }
    }
    return best ?? photos[0];
}
function buildPexelsUrl(photo, target) {
    const base = photo.src?.original ??
        photo.src?.large2x ??
        photo.src?.landscape ??
        photo.src?.large ??
        photo.src?.medium ??
        photo.src?.small ??
        '';
    if (!base) {
        return { url: '', width: photo.width, height: photo.height };
    }
    const targetRatio = target?.aspectRatio ??
        (target?.width && target?.height && target.height !== 0 ? target.width / target.height : undefined);
    let width = target?.width;
    let height = target?.height;
    if (width && !height && targetRatio) {
        height = Math.max(1, Math.round(width / targetRatio));
    }
    if (height && !width && targetRatio) {
        width = Math.max(1, Math.round(height * targetRatio));
    }
    if (!width && !height && targetRatio) {
        width = Math.min(photo.width ?? 1600, 1600);
        if (width && targetRatio) {
            height = Math.max(1, Math.round(width / targetRatio));
        }
    }
    if (width && height) {
        const cropped = buildCroppedUrl(base, width, height);
        return { url: cropped, width, height };
    }
    const fallbackUrl = photo.src?.landscape ??
        photo.src?.large2x ??
        photo.src?.large ??
        photo.src?.original ??
        photo.src?.medium ??
        base;
    const inferred = inferVariantDimensions(fallbackUrl, photo);
    return { url: ensureDefaultParams(fallbackUrl), width: inferred?.width, height: inferred?.height };
}
function buildCroppedUrl(base, width, height) {
    try {
        const url = new URL(base);
        url.searchParams.set('auto', 'compress');
        url.searchParams.set('cs', 'tinysrgb');
        url.searchParams.set('fit', 'crop');
        url.searchParams.set('w', String(Math.max(1, Math.round(width))));
        url.searchParams.set('h', String(Math.max(1, Math.round(height))));
        return url.toString();
    }
    catch {
        return ensureDefaultParams(base);
    }
}
function ensureDefaultParams(url) {
    try {
        const parsed = new URL(url);
        if (!parsed.searchParams.has('auto')) {
            parsed.searchParams.set('auto', 'compress');
        }
        if (!parsed.searchParams.has('cs')) {
            parsed.searchParams.set('cs', 'tinysrgb');
        }
        return parsed.toString();
    }
    catch {
        return url;
    }
}
function inferVariantDimensions(url, photo) {
    if (!url)
        return {};
    try {
        const parsed = new URL(url);
        const width = parseDimension(parsed.searchParams.get('w')) ?? photo.width;
        const height = parseDimension(parsed.searchParams.get('h')) ?? photo.height;
        return { width: width ?? undefined, height: height ?? undefined };
    }
    catch {
        return { width: photo.width ?? undefined, height: photo.height ?? undefined };
    }
}
