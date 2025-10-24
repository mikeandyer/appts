import { createPool } from 'mysql2/promise';
import { load } from 'cheerio';
import OpenAI from 'openai';
import { readFile } from 'fs/promises';
import path from 'path';
import { normalizeUsePexelsHero, toAiBrief } from './types.js';
const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY ?? '').trim();
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1').trim();
const DEEPSEEK_MODEL = (process.env.DEEPSEEK_MODEL ?? 'deepseek-chat').trim();
const TEMPLATE_EXPORT_PATH = process.env.TEMPLATE_EXPORT_PATH ?? path.resolve(process.cwd(), '../goldihost_pages_export.json');
const PEXELS_API_KEY = (process.env.PEXELS_API_KEY ?? '').trim();
const PEXELS_API_BASE_URL = (process.env.PEXELS_API_BASE_URL ?? 'https://api.pexels.com/v1').trim();
const TEMPLATE_PAGE_HINTS = {
    home: { title: 'Home', slug: 'home', intent: 'home page' },
    homepage: { title: 'Home', slug: 'home', intent: 'home page' },
    services: { title: 'Services', slug: 'services', intent: 'services page' },
    service: { title: 'Services', slug: 'services', intent: 'services page' },
    about: { title: 'About Us', slug: 'about', intent: 'about page' },
    contact: { title: 'Contact', slug: 'contact', intent: 'contact page' },
    contactus: { title: 'Contact', slug: 'contact', intent: 'contact page' },
    blog: { title: 'Blog', slug: 'blog', intent: 'blog page' },
    faq: { title: 'FAQ', slug: 'faq', intent: 'FAQ page' },
    testimonials: { title: 'Testimonials', slug: 'testimonials', intent: 'testimonials page' },
};
if (!DEEPSEEK_API_KEY) {
    console.warn('[worker] DEEPSEEK_API_KEY not set — rewrites will fail until configured.');
}
if (!PEXELS_API_KEY) {
    console.warn('[worker] PEXELS_API_KEY not set — hero image replacement will be skipped.');
}
const mysqlPool = createPool({
    host: process.env.WP_DB_HOST ?? '127.0.0.1',
    user: process.env.WP_DB_USER ?? 'root',
    password: process.env.WP_DB_PASS ?? '',
    database: process.env.WP_DB_NAME ?? 'goldiwaycom',
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: Number(process.env.WP_DB_POOL_SIZE ?? 4),
});
const DEFAULT_TEMPLATE_SLUG = 'wood';
const openai = new OpenAI({
    apiKey: DEEPSEEK_API_KEY || 'missing-key',
    baseURL: DEEPSEEK_BASE_URL,
});
let started = false;
let processing = false;
let pgPool;
const templateCache = new Map();
const localizedTitleCache = new Map();
export function startJobWorker(pool) {
    pgPool = pool;
    if (started)
        return;
    started = true;
    console.log('[worker] background processor online');
    setInterval(() => {
        void processQueue();
    }, Number(process.env.WORKER_INTERVAL_MS ?? 2000));
}
export function triggerJobWorker() {
    if (!started)
        return;
    // Kick the loop asynchronously; avoid re-entrancy if already running.
    void processQueue();
}
async function processQueue() {
    if (processing)
        return;
    processing = true;
    try {
        while (true) {
            const job = await claimJob();
            if (!job)
                break;
            await handleJob(job);
        }
    }
    catch (error) {
        console.error('[worker] processQueue error', error);
    }
    finally {
        processing = false;
    }
}
async function claimJob() {
    let client;
    try {
        client = await pgPool.connect();
        await client.query('BEGIN');
        const result = await client.query(`
        SELECT id, payload
        FROM aib_jobs
        WHERE status = 'pending'
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);
        if (result.rowCount === 0) {
            await client.query('COMMIT');
            return null;
        }
        const row = result.rows[0];
        await client.query(`UPDATE aib_jobs SET status = 'processing' WHERE id = $1`, [row.id]);
        await client.query('COMMIT');
        const payloadRaw = row.payload;
        let parsed = payloadRaw;
        if (typeof payloadRaw === 'string') {
            try {
                parsed = JSON.parse(payloadRaw);
            }
            catch (error) {
                console.warn(`[worker] job ${row.id} payload JSON parse failed`, error);
                parsed = {};
            }
        }
        const payload = toAiBrief(parsed);
        return {
            id: row.id,
            payload,
        };
    }
    catch (error) {
        if (client) {
            try {
                await client.query('ROLLBACK');
            }
            catch (rollbackErr) {
                console.error('[worker] rollback failed', rollbackErr);
            }
        }
        console.error('[worker] claimJob error', error);
        return null;
    }
    finally {
        client?.release();
    }
}
async function handleJob(job) {
    try {
        const requestedTemplate = job.payload?.templateSlug ?? DEFAULT_TEMPLATE_SLUG;
        const { template: effectiveTemplate, pages } = await fetchTemplatePagesFromWp(requestedTemplate);
        const payloadPages = pages.length > 0 ? pages : fallbackPage();
        if (pages.length === 0) {
            console.warn(`[worker] template '${effectiveTemplate}' returned no pages; using placeholder fallback.`);
        }
        const language = typeof job.payload?.language === 'string' ? job.payload.language.trim() : '';
        const allowPexelsHero = normalizeUsePexelsHero(job.payload?.usePexelsHero);
        const rewrittenPages = [];
        let heroImage = null;
        for (const page of payloadPages) {
            const textNodes = findAllTextNodes(page.html);
            const pageIntent = inferPageIntent(page.slug);
            const replacements = await deepseekRewrite(textNodes, job.payload?.description ?? '', language, pageIntent);
            let newHtml = replaceTextNodes(page.html, replacements);
            const heroTarget = allowPexelsHero ? detectHeroTarget(newHtml) : null;
            if (allowPexelsHero &&
                !heroImage &&
                shouldAttemptHeroReplacement({
                    html: newHtml,
                    pageSlug: page.slug,
                    pageIndex: rewrittenPages.length,
                })) {
                heroImage = await selectHeroImage(job.payload, pageIntent, language, heroTarget);
            }
            if (allowPexelsHero && heroImage) {
                const swapped = replaceHeroImage(newHtml, heroImage);
                if (swapped !== newHtml) {
                    newHtml = swapped;
                }
            }
            let newTitle = page.title;
            let newSlug = page.slug;
            const meta = await deepseekRewriteMeta({
                title: page.title,
                slug: page.slug,
                description: job.payload?.description ?? '',
                intent: pageIntent,
                fallbackTitle: getFallbackTitle(pageIntent, page.title),
                fallbackSlug: getFallbackSlug(pageIntent, page.slug),
            }, language);
            const fallbackTitle = getFallbackTitle(pageIntent, page.title);
            const fallbackSlug = getFallbackSlug(pageIntent, page.slug);
            const localizedFallbackTitle = await localizeTitle(fallbackTitle, language, pageIntent);
            newTitle = localizedFallbackTitle;
            if (meta?.title) {
                const candidateTitle = meta.title.trim();
                if (candidateTitle && !containsTemplateTokens(candidateTitle, page.slug)) {
                    newTitle = candidateTitle;
                }
            }
            let candidateSlug = meta?.slug ? slugify(meta.slug) : '';
            const originalNormalized = slugify(page.slug);
            if (!candidateSlug || candidateSlug === originalNormalized) {
                candidateSlug = fallbackSlug;
            }
            newSlug = ensureUniqueSlug(candidateSlug, fallbackSlug, rewrittenPages);
            rewrittenPages.push({
                slug: newSlug,
                title: newTitle,
                html: newHtml,
            });
        }
        const bundle = JSON.stringify({ pages: rewrittenPages }, null, 0);
        await pgPool.query(`
        UPDATE aib_jobs
        SET status = 'done',
            result_html = $1,
            error_message = NULL
        WHERE id = $2
      `, [bundle, job.id]);
        console.log(`[worker] job ${job.id}: done (template=${effectiveTemplate}, pages=${rewrittenPages.length})`);
    }
    catch (error) {
        console.error(`[worker] job ${job.id} failed`, error);
        await pgPool.query(`
        UPDATE aib_jobs
        SET status = 'failed',
            error_message = $1
        WHERE id = $2
      `, [error instanceof Error ? error.message : String(error), job.id]);
    }
}
async function fetchTemplatePagesFromWp(templateSlug) {
    const sql = `
    SELECT ID, post_title, post_name, post_content
    FROM wp_posts
    WHERE post_type = 'page'
      AND post_status = 'publish'
      AND post_name LIKE ?
    ORDER BY ID
  `;
    const pattern = `${templateSlug}-%`;
    let [rows] = await mysqlPool.execute(sql, [pattern]);
    let effectiveTemplate = templateSlug;
    if (rows.length === 0 && templateSlug !== DEFAULT_TEMPLATE_SLUG) {
        console.warn(`[worker] no pages found for template '${templateSlug}', falling back to '${DEFAULT_TEMPLATE_SLUG}'.`);
        [rows] = await mysqlPool.execute(sql, [`${DEFAULT_TEMPLATE_SLUG}-%`]);
        effectiveTemplate = DEFAULT_TEMPLATE_SLUG;
    }
    const pages = rows.map((row) => ({
        slug: row.post_name,
        title: row.post_title,
        html: row.post_content,
    }));
    if (pages.length > 0) {
        return { template: effectiveTemplate, pages };
    }
    const fallbackTemplates = await loadTemplatesFromExport(templateSlug);
    if (fallbackTemplates.length > 0) {
        return { template: templateSlug, pages: fallbackTemplates };
    }
    return { template: effectiveTemplate, pages };
}
function fallbackPage() {
    return [
        {
            slug: 'generated-landing',
            title: 'Generated Landing',
            html: '<!-- wp:paragraph --><p>Placeholder page</p><!-- /wp:paragraph -->',
        },
    ];
}
async function loadTemplatesFromExport(templateSlug) {
    if (templateCache.has(templateSlug)) {
        return templateCache.get(templateSlug) ?? [];
    }
    try {
        const raw = await readFile(TEMPLATE_EXPORT_PATH, 'utf8');
        const json = JSON.parse(raw);
        const prefix = `${templateSlug}-`;
        const subset = [];
        for (const entry of json) {
            const post = entry.post;
            if (!post)
                continue;
            const slug = post.post_name ?? '';
            if (!slug.startsWith(prefix))
                continue;
            subset.push({
                slug,
                title: post.post_title ?? slug,
                html: post.post_content ?? '',
            });
        }
        templateCache.set(templateSlug, subset);
        return subset;
    }
    catch (error) {
        console.error('[worker] failed to load template export', TEMPLATE_EXPORT_PATH, error);
        templateCache.set(templateSlug, []);
        return [];
    }
}
function slugify(text) {
    return text
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 200);
}
function findAllTextNodes(html) {
    if (!html.trim())
        return [];
    const $ = load(html, { decodeEntities: false });
    const texts = [];
    $('*')
        .contents()
        .each((_, node) => {
        if (node.type !== 'text')
            return;
        const parent = node.parent || null;
        if (!parent || parent.type !== 'tag')
            return;
        const tagName = parent.name;
        if (tagName === 'style' || tagName === 'script')
            return;
        const raw = (node.data ?? '').trim();
        if (!raw)
            return;
        if (raw.includes('wp:'))
            return;
        if (raw.startsWith('[') && raw.endsWith(']'))
            return;
        const classes = new Set((parent.attribs?.class ?? '').split(/\s+/).filter(Boolean));
        const hasAlpha = /[A-Za-z\u00C0-\u024F]/.test(raw);
        const hasDigit = /\d/.test(raw);
        const isCountupText = classes.has('stk-block-count-up__text');
        if (!hasAlpha && !hasDigit)
            return;
        if (hasDigit && !hasAlpha && !isCountupText)
            return;
        texts.push(raw);
    });
    return texts;
}
function serializeNode($, node, depth = 0) {
    if (depth > 50)
        return ''; // safety guard against deep recursion
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
function serializeFragment($) {
    const pieces = [];
    $.root()
        .contents()
        .each((_, node) => {
        pieces.push(serializeNode($, node));
    });
    return normalizeStackableAttributes(pieces.join(''));
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
function replaceTextNodes(html, replacements) {
    if (!html.trim())
        return html;
    const $ = load(html, { decodeEntities: false });
    let index = 0;
    $('*')
        .contents()
        .each((_, node) => {
        if (node.type !== 'text')
            return;
        const parent = node.parent || null;
        if (!parent || parent.type !== 'tag')
            return;
        const tagName = parent.name;
        if (tagName === 'style' || tagName === 'script')
            return;
        const raw = (node.data ?? '').trim();
        if (!raw)
            return;
        if (raw.includes('wp:'))
            return;
        if (raw.startsWith('[') && raw.endsWith(']'))
            return;
        const classes = new Set((parent.attribs?.class ?? '').split(/\s+/).filter(Boolean));
        const hasAlpha = /[A-Za-z\u00C0-\u024F]/.test(raw);
        const hasDigit = /\d/.test(raw);
        const isCountupText = classes.has('stk-block-count-up__text');
        if (!hasAlpha && !hasDigit)
            return;
        if (hasDigit && !hasAlpha && !isCountupText)
            return;
        if (index < replacements.length) {
            const originalSlug = slugify(raw);
            const newText = replacements[index];
            node.data = newText;
            if (originalSlug) {
                const newSlug = slugify(newText);
                if (newSlug && newSlug !== originalSlug) {
                    let ancestor = parent;
                    while (ancestor && ancestor.type === 'tag') {
                        const idAttr = ancestor.attribs?.id?.trim() ?? '';
                        if (idAttr && slugify(idAttr) === originalSlug) {
                            ancestor.attribs.id = newSlug;
                            break;
                        }
                        ancestor = ancestor.parent ?? null;
                    }
                }
            }
            index += 1;
        }
    });
    const serialized = serializeFragment($);
    return serialized.length > 0 ? serialized : html;
}
function describeLanguage(locale) {
    if (!locale)
        return '';
    return locale.replace(/_/g, '-');
}
function inferPageIntent(slug) {
    if (!slug)
        return '';
    const parts = slug.split('-');
    const last = parts.at(-1)?.toLowerCase() ?? '';
    const hint = TEMPLATE_PAGE_HINTS[last];
    return hint?.intent ?? '';
}
function getFallbackTitle(intent, original) {
    for (const hint of Object.values(TEMPLATE_PAGE_HINTS)) {
        if (hint.intent === intent) {
            return hint.title;
        }
    }
    return original;
}
function getFallbackSlug(intent, original) {
    for (const hint of Object.values(TEMPLATE_PAGE_HINTS)) {
        if (hint.intent === intent) {
            return slugify(hint.slug);
        }
    }
    return slugify(original);
}
async function localizeTitle(baseTitle, language, intent) {
    if (!language)
        return baseTitle;
    const cacheKey = `${language}|${intent}|${baseTitle}`;
    if (localizedTitleCache.has(cacheKey)) {
        return localizedTitleCache.get(cacheKey) ?? baseTitle;
    }
    const languageHint = describeLanguage(language);
    const prompt = '請將以下標題翻譯或改寫成指定語言，保持簡潔且符合頁面用途。' +
        `語言：${languageHint}` +
        (intent ? `，用途：${intent}` : '') +
        `
標題：${baseTitle}`;
    try {
        const response = await openai.chat.completions.create({
            model: DEEPSEEK_MODEL,
            messages: [
                { role: 'system', content: '你是一位專業網站翻譯與在地化專家，只需回傳改寫後的標題。' },
                { role: 'user', content: prompt },
            ],
            temperature: 0.2,
            max_tokens: 120,
        });
        const content = response.choices.at(0)?.message?.content?.trim() ?? '';
        if (content) {
            localizedTitleCache.set(cacheKey, content);
            return content;
        }
    }
    catch (error) {
        console.error('[worker] localizeTitle failed', error);
    }
    localizedTitleCache.set(cacheKey, baseTitle);
    return baseTitle;
}
function containsTemplateTokens(title, originalSlug) {
    const tokens = originalSlug.split('-');
    const lowerTitle = title.toLowerCase();
    for (let i = 0; i < tokens.length - 1; i += 1) {
        const token = tokens[i];
        if (!token)
            continue;
        if (lowerTitle.includes(token.toLowerCase())) {
            return true;
        }
    }
    return false;
}
function ensureUniqueSlug(candidate, fallbackSlug, existing) {
    let base = candidate || fallbackSlug || 'page';
    const used = new Set(existing.map((page) => page.slug));
    if (!used.has(base)) {
        return base;
    }
    let index = 2;
    let next = `${base}-${index}`;
    while (used.has(next)) {
        index += 1;
        next = `${base}-${index}`;
    }
    return next;
}
function shouldAttemptHeroReplacement({ html, pageSlug, pageIndex, }) {
    if (!PEXELS_API_KEY)
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
async function selectHeroImage(brief, pageIntent, language, target) {
    if (!PEXELS_API_KEY)
        return null;
    if (!brief)
        return null;
    const hasContext = Boolean(brief.description && brief.description.trim()) ||
        Boolean(brief.industry && brief.industry.trim()) ||
        Boolean(brief.businessName && brief.businessName.trim());
    if (!hasContext)
        return null;
    const suggestions = await deepseekSuggestImageQueries(brief, pageIntent, language);
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
        const photo = await fetchPexelsHeroImage(query, target ?? undefined);
        if (photo) {
            const dims = photo.width && photo.height
                ? ` (${Math.round(photo.width)}x${Math.round(photo.height)})`
                : '';
            console.log(`[worker] hero image selected via Pexels query "${query}"${dims}`);
            return photo;
        }
    }
    return null;
}
async function deepseekSuggestImageQueries(brief, pageIntent, language) {
    if (!DEEPSEEK_API_KEY)
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
        const response = await openai.chat.completions.create({
            model: DEEPSEEK_MODEL,
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
async function fetchPexelsHeroImage(query, target) {
    if (!PEXELS_API_KEY)
        return null;
    const params = new URLSearchParams();
    params.set('query', query);
    params.set('per_page', '6');
    params.set('orientation', 'landscape');
    params.set('size', 'large');
    const endpoint = `${PEXELS_API_BASE_URL.replace(/\/+$/, '')}/search?${params.toString()}`;
    try {
        const response = await fetch(endpoint, {
            headers: {
                Authorization: PEXELS_API_KEY,
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
function replaceHeroImage(html, hero) {
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
            const updatedStyle = styleAttr.replace(/background-image:\s*url\((['"]?)[^)]+?\1\)/i, (match) => {
                return match.replace(/url\((['"]?)[^)]+?\1\)/i, `url(${hero.url})`);
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
        // Fallback to raw string replacement when DOM rewrite fails.
        serialized = replaceFirstBackgroundUrl(serialized, hero.url);
        return serialized;
    }
    serialized = replaceFirstBackgroundUrl(serialized, hero.url);
    return serialized;
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
function detectHeroTarget(html) {
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
    const match = style.match(/aspect-ratio\s*:\s*([0-9.]+)\s*\/\s*([0-9.]+)/i);
    if (match) {
        const numerator = Number.parseFloat(match[1]);
        const denominator = Number.parseFloat(match[2]);
        if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
            return numerator / denominator;
        }
    }
    const simple = style.match(/aspect-ratio\s*:\s*([0-9.]+)/i);
    if (simple) {
        const value = Number.parseFloat(simple[1]);
        if (Number.isFinite(value) && value > 0) {
            return value;
        }
    }
    return undefined;
}
function extractDimensionsFromComments(html) {
    const commentRegex = /<!--\s*wp:[^ ]+\s+(\{[\s\S]*?\})\s*-->/g;
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
        return base;
    }
}
function ensureDefaultParams(urlStr) {
    try {
        const url = new URL(urlStr);
        if (!url.searchParams.has('auto')) {
            url.searchParams.set('auto', 'compress');
        }
        if (!url.searchParams.has('cs')) {
            url.searchParams.set('cs', 'tinysrgb');
        }
        return url.toString();
    }
    catch {
        return urlStr;
    }
}
function inferVariantDimensions(url, photo) {
    if (!url) {
        return { width: photo.width, height: photo.height };
    }
    if (url === photo.src?.landscape) {
        return { width: 1200, height: 627 };
    }
    if (url === photo.src?.large2x) {
        return { width: 1880, height: 1253 };
    }
    if (url === photo.src?.large) {
        return { width: 940, height: 627 };
    }
    if (url === photo.src?.medium) {
        return { width: 350, height: 233 };
    }
    if (url === photo.src?.small) {
        return { width: 130, height: 86 };
    }
    return { width: photo.width, height: photo.height };
}
async function deepseekRewrite(texts, description, language, intent) {
    if (!texts.length)
        return texts;
    if (!DEEPSEEK_API_KEY)
        return texts;
    const languageHint = language ? describeLanguage(language) : '依照 WordPress 語系或原始語言輸出';
    const systemMessage = '你是一位網站文案助理。' +
        '任務：根據使用者給的 `description` 與 `texts`，為網站改寫更專業、符合情境的字句。' +
        `請使用指定語言輸出內容（${languageHint}）。` +
        '嚴格規定：只回傳【純 JSON 字串陣列】（長度需與 texts 相同），不得包含解說、Markdown 或任何多餘文字。' +
        '若無法改寫，保留原字串。';
    const userMessage = 'description：\n' +
        `${description}\n\n` +
        'language：\n' +
        `${language || '沿用 WordPress 使用者語言或原始語言'}\n\n` +
        'texts（請逐一改寫，保持順序一致）：\n' +
        `${JSON.stringify(texts)}\n\n` +
        '只回傳 JSON 陣列本體。';
    try {
        const response = await openai.chat.completions.create({
            model: DEEPSEEK_MODEL,
            messages: [
                { role: 'system', content: systemMessage },
                { role: 'user', content: userMessage },
            ],
            temperature: 0.3,
            max_tokens: 2000,
        });
        const content = response.choices.at(0)?.message?.content?.trim() ?? '';
        const parsed = parseJsonArray(content);
        if (parsed.length !== texts.length) {
            const fixed = parsed.slice(0, texts.length);
            while (fixed.length < texts.length) {
                fixed.push(texts[fixed.length]);
            }
            return fixed;
        }
        return parsed;
    }
    catch (error) {
        console.error('[worker] deepseek rewrite failed', error);
        return texts;
    }
}
function parseJsonArray(raw) {
    if (!raw)
        return [];
    try {
        const parsed = JSON.parse(raw);
        return validateArray(parsed);
    }
    catch {
        const start = raw.indexOf('[');
        const end = raw.lastIndexOf(']');
        if (start === -1 || end === -1 || start >= end)
            return [];
        try {
            return validateArray(JSON.parse(raw.slice(start, end + 1)));
        }
        catch {
            return [];
        }
    }
}
function validateArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.map((item) => (typeof item === 'string' ? item : String(item ?? '')));
}
async function deepseekRewriteMeta(request, language) {
    if (!DEEPSEEK_API_KEY)
        return null;
    const languageHint = language ? describeLanguage(language) : '依照 WordPress 語系或原始語言輸出';
    const systemMessage = '你是一位網站導覽助理。' +
        '任務：根據提供的基本資料，產出網站頁面的顯示標題與網址 slug。' +
        `請使用指定語言輸出標題（${languageHint}），slug 必須使用英文字母、數字與連字號，全部小寫，不含空白或特殊符號。` +
        '若已提供預設標題與 slug，請以此為基礎做在地化或必要調整。' +
        '嚴格規定：只回傳 JSON 物件 {"title": "...", "slug": "..."}，不得包含其他文字。';
    const userMessage = [
        'current:',
        `title: ${request.title}`,
        `slug: ${request.slug}`,
        '',
        'description:',
        `${request.description}`,
        '',
        'language:',
        `${language || '沿用 WordPress 使用者語言或原始語言'}`,
        '',
        '請產出 JSON 物件。',
    ].join('\n');
    try {
        const response = await openai.chat.completions.create({
            model: DEEPSEEK_MODEL,
            messages: [
                { role: 'system', content: systemMessage },
                { role: 'user', content: userMessage },
            ],
            temperature: 0.2,
            max_tokens: 400,
        });
        const content = response.choices.at(0)?.message?.content?.trim() ?? '';
        const parsed = parseJsonObject(content);
        if (typeof parsed.intent === 'string' && !request.intent) {
            request.intent = parsed.intent.trim();
        }
        const result = {};
        if (typeof parsed.title === 'string') {
            result.title = parsed.title.trim();
        }
        if (typeof parsed.slug === 'string') {
            result.slug = parsed.slug.trim();
        }
        if (result.slug) {
            result.slug = result.slug.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
        }
        return result;
    }
    catch (error) {
        console.error('[worker] deepseek meta rewrite failed', error);
        return null;
    }
}
function parseJsonObject(raw) {
    if (!raw)
        return {};
    try {
        const parsed = JSON.parse(raw);
        return validateRecord(parsed);
    }
    catch {
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start === -1 || end === -1 || start >= end)
            return {};
        try {
            return validateRecord(JSON.parse(raw.slice(start, end + 1)));
        }
        catch {
            return {};
        }
    }
}
function validateRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return {};
    return value;
}
