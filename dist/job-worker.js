import { createPool } from 'mysql2/promise';
import { load } from 'cheerio';
import OpenAI from 'openai';
import { readFile } from 'fs/promises';
import path from 'path';
import { normalizeUsePexelsHero, toAiBrief } from './types.js';
import { serializeFragment } from './html-utils.js';
import { replacePageImagesWithPexels, shouldAttemptHeroReplacement, } from './pexels.js';
import { parseJsonArray } from './utils.js';
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY ??
    process.env.DEEPSEEK_API_KEY ??
    '').trim();
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL ??
    process.env.DEEPSEEK_BASE_URL ??
    'https://api.openai.com/v1').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL ??
    process.env.DEEPSEEK_MODEL ??
    'gpt-4.1-mini').trim();
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
if (!OPENAI_API_KEY) {
    console.warn('[worker] OPENAI_API_KEY not set — rewrites will fail until configured.');
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
    apiKey: OPENAI_API_KEY || 'missing-key',
    baseURL: OPENAI_BASE_URL,
});
const heroImageConfig = {
    pexelsApiKey: PEXELS_API_KEY,
    pexelsApiBaseUrl: PEXELS_API_BASE_URL,
    openaiApiKey: OPENAI_API_KEY,
    openaiModel: OPENAI_MODEL,
    openai,
};
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
        for (const page of payloadPages) {
            const textNodes = findAllTextNodes(page.html);
            const pageIntent = inferPageIntent(page.slug);
            const { rewrites: replacements, tokensUsed, tokensLeft } = await rewriteTextWithOpenAI(textNodes, job.payload?.description ?? '', language, pageIntent);
            logTextRewrites(page.slug, textNodes, replacements, tokensUsed, tokensLeft);
            let newHtml = replaceTextNodes(page.html, replacements);
            if (allowPexelsHero &&
                heroImageConfig.pexelsApiKey &&
                shouldAttemptHeroReplacement({
                    html: newHtml,
                    pageSlug: page.slug,
                    pageIndex: rewrittenPages.length,
                    apiKey: heroImageConfig.pexelsApiKey,
                })) {
                const imageResult = await replacePageImagesWithPexels(newHtml, job.payload, pageIntent, language, heroImageConfig, { maxImages: 10 });
                if (imageResult.replacements.length > 0) {
                    newHtml = imageResult.html;
                    console.log(`[worker] applied ${imageResult.replacements.length} Pexels image(s) on page "${page.slug}"`);
                }
            }
            let newTitle = page.title;
            let newSlug = page.slug;
            const meta = await rewriteMetaWithOpenAI({
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
            model: OPENAI_MODEL,
            messages: [
                { role: 'system', content: '你是一位專業網站翻譯與在地化專家，只需回傳改寫後的標題。' },
                { role: 'user', content: prompt },
            ],
            max_completion_tokens: 120,
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
function logTextRewrites(pageSlug, originals, rewrites, tokensUsed, tokensLeft) {
    if (!originals.length || !rewrites.length)
        return;
    const count = Math.min(originals.length, rewrites.length);
    for (let i = 0; i < count; i += 1) {
        const original = originals[i] ?? '';
        const rewrite = rewrites[i] ?? '';
        const trimmedOriginal = original.length > 200 ? `${original.slice(0, 197)}...` : original;
        const trimmedRewrite = rewrite.length > 200 ? `${rewrite.slice(0, 197)}...` : rewrite;
        const status = original === rewrite ? 'unchanged' : 'updated';
        const payload = {
            original: trimmedOriginal,
            rewrite: trimmedRewrite,
        };
        if (typeof tokensUsed === 'number') {
            payload.tokens_used = tokensUsed;
        }
        if (typeof tokensLeft === 'number') {
            payload.tokens_left = tokensLeft;
        }
        console.log(`[worker] text rewrite (${pageSlug}) [${status}]`, payload);
    }
}
const configuredMaxCompletionTokens = Number.parseInt(process.env.OPENAI_MAX_COMPLETION_TOKENS ?? '4000', 10);
const MAX_COMPLETION_TOKENS_TEXT = Number.isFinite(configuredMaxCompletionTokens) && configuredMaxCompletionTokens > 0
    ? configuredMaxCompletionTokens
    : 4000;
async function rewriteTextWithOpenAI(texts, description, language, intent) {
    if (!texts.length)
        return { rewrites: texts };
    if (!OPENAI_API_KEY)
        return { rewrites: texts };
    const languageHint = language ? describeLanguage(language) : '依照 WordPress 語系或原始語言輸出';
    const systemMessage = '你是一位網站文案助理。' +
        '任務：根據使用者提供的 `description` 與 `texts`，為網站改寫更專業且符合情境的字句。' +
        `請使用指定語言輸出內容（${languageHint}）。` +
        '嚴格規定：只回傳【純 JSON 字串陣列】（長度需與 texts 相同），不得包含解說、Markdown 或任何多餘文字。' +
        '若無法改寫，保留原字串。';
    const userMessage = 'description：\n' +
        `${description}\n\n` +
        (intent ? `intent：${intent}\n\n` : '') +
        `texts：${JSON.stringify(texts)}`;
    try {
        const response = await openai.chat.completions.create({
            model: OPENAI_MODEL,
            messages: [
                { role: 'system', content: systemMessage },
                { role: 'user', content: userMessage },
            ],
            max_completion_tokens: MAX_COMPLETION_TOKENS_TEXT,
        });
        const content = response.choices.at(0)?.message?.content?.trim() ?? '';
        const completionTokens = typeof response.usage?.completion_tokens === 'number' ? response.usage.completion_tokens : undefined;
        const tokensLeft = typeof completionTokens === 'number'
            ? Math.max(0, MAX_COMPLETION_TOKENS_TEXT - completionTokens)
            : undefined;
        const parsed = parseJsonArray(content);
        if (parsed.length === texts.length) {
            return {
                rewrites: parsed.map((item) => item.trim()),
                tokensUsed: completionTokens,
                tokensLeft,
            };
        }
        if (parsed.length > 0) {
            const merged = [...parsed.map((item) => item.trim()), ...texts].slice(0, texts.length);
            return {
                rewrites: merged,
                tokensUsed: completionTokens,
                tokensLeft,
            };
        }
    }
    catch (error) {
        console.error('[worker] text rewrite failed', error);
    }
    return { rewrites: texts };
}
async function rewriteMetaWithOpenAI(request, language) {
    if (!OPENAI_API_KEY)
        return {};
    const languageHint = language ? describeLanguage(language) : '依照 WordPress 語系或原始語言輸出';
    const systemMessage = '你是一位網站的 SEO 文案助理。' +
        '任務：根據提供的資訊，為頁面產生新的標題 (title) 與網址 slug。' +
        `請使用指定語言輸出內容（${languageHint}）。` +
        '嚴格規定：只回傳【JSON 物件】，格式為 {"title": "...", "slug": "..."}，不得包含其他文字。' +
        '若無合適建議，可省略對應欄位。';
    const payload = {
        description: request.description,
        intent: request.intent,
        originalTitle: request.title,
        originalSlug: request.slug,
        fallbackTitle: request.fallbackTitle,
        fallbackSlug: request.fallbackSlug,
        language,
    };
    const userMessage = JSON.stringify(payload, null, 2);
    try {
        const response = await openai.chat.completions.create({
            model: OPENAI_MODEL,
            messages: [
                { role: 'system', content: systemMessage },
                { role: 'user', content: userMessage },
            ],
            max_completion_tokens: 1500,
        });
        const content = response.choices.at(0)?.message?.content?.trim() ?? '';
        const parsed = parseJsonObject(content);
        const title = typeof parsed.title === 'string' ? parsed.title.trim() : undefined;
        const slug = typeof parsed.slug === 'string' ? parsed.slug.trim() : undefined;
        return { title, slug };
    }
    catch (error) {
        console.error('[worker] meta rewrite failed', error);
        return {};
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
