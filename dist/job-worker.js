import { createPool } from 'mysql2/promise';
import { load } from 'cheerio';
import OpenAI from 'openai';
import { readFile } from 'fs/promises';
import path from 'path';
import { toAiBrief } from './types.js';
const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY ?? '').trim();
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1').trim();
const DEEPSEEK_MODEL = (process.env.DEEPSEEK_MODEL ?? 'deepseek-chat').trim();
const TEMPLATE_EXPORT_PATH = process.env.TEMPLATE_EXPORT_PATH ?? path.resolve(process.cwd(), '../goldihost_pages_export.json');
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
        const rewrittenPages = [];
        for (const page of payloadPages) {
            const textNodes = findAllTextNodes(page.html);
            const pageIntent = inferPageIntent(page.slug);
            const replacements = await deepseekRewrite(textNodes, job.payload?.description ?? '', language, pageIntent);
            const newHtml = replaceTextNodes(page.html, replacements);
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
