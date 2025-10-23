import { Pool, PoolClient } from 'pg';
import { createPool, Pool as MysqlPool } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import { load } from 'cheerio';
import OpenAI from 'openai';
import { toAiBrief } from './types.js';
import type { AiBrief, TemplateSlug } from './types.js';

type PendingJob = {
  id: number;
  payload: AiBrief;
};

type PagePayload = {
  slug: string;
  title: string;
  html: string;
};

const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY ?? '').trim();
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1').trim();
const DEEPSEEK_MODEL = (process.env.DEEPSEEK_MODEL ?? 'deepseek-chat').trim();

if (!DEEPSEEK_API_KEY) {
  console.warn('[worker] DEEPSEEK_API_KEY not set — rewrites will fail until configured.');
}

const mysqlPool: MysqlPool = createPool({
  host: process.env.WP_DB_HOST ?? '127.0.0.1',
  user: process.env.WP_DB_USER ?? 'root',
  password: process.env.WP_DB_PASS ?? '',
  database: process.env.WP_DB_NAME ?? 'goldiwaycom',
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: Number(process.env.WP_DB_POOL_SIZE ?? 4),
});

const DEFAULT_TEMPLATE_SLUG: TemplateSlug = 'wood';

const openai = new OpenAI({
  apiKey: DEEPSEEK_API_KEY || 'missing-key',
  baseURL: DEEPSEEK_BASE_URL,
});

let started = false;
let processing = false;
let pgPool: Pool;

export function startJobWorker(pool: Pool) {
  pgPool = pool;
  if (started) return;
  started = true;
  console.log('[worker] background processor online');
  setInterval(() => {
    void processQueue();
  }, Number(process.env.WORKER_INTERVAL_MS ?? 2000));
}

export function triggerJobWorker() {
  if (!started) return;
  // Kick the loop asynchronously; avoid re-entrancy if already running.
  void processQueue();
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (true) {
      const job = await claimJob();
      if (!job) break;
      await handleJob(job);
    }
  } catch (error) {
    console.error('[worker] processQueue error', error);
  } finally {
    processing = false;
  }
}

async function claimJob(): Promise<PendingJob | null> {
  let client: PoolClient | undefined;
  try {
    client = await pgPool.connect();
    await client.query('BEGIN');
    const result = await client.query<{ id: number; payload: unknown }>(
      `
        SELECT id, payload
        FROM aib_jobs
        WHERE status = 'pending'
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `,
    );
    if (result.rowCount === 0) {
      await client.query('COMMIT');
      return null;
    }

    const row = result.rows[0];
    await client.query(`UPDATE aib_jobs SET status = 'processing' WHERE id = $1`, [row.id]);
    await client.query('COMMIT');

    const payloadRaw = row.payload;
    let parsed: unknown = payloadRaw;
    if (typeof payloadRaw === 'string') {
      try {
        parsed = JSON.parse(payloadRaw);
      } catch (error) {
        console.warn(`[worker] job ${row.id} payload JSON parse failed`, error);
        parsed = {};
      }
    }
    const payload = toAiBrief(parsed);

    return {
      id: row.id,
      payload,
    };
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('[worker] rollback failed', rollbackErr);
      }
    }
    console.error('[worker] claimJob error', error);
    return null;
  } finally {
    client?.release();
  }
}

async function handleJob(job: PendingJob): Promise<void> {
  try {
    const requestedTemplate = (job.payload?.templateSlug as TemplateSlug) ?? DEFAULT_TEMPLATE_SLUG;
    const { template: effectiveTemplate, pages } = await fetchTemplatePagesFromWp(requestedTemplate);
    const payloadPages = pages.length > 0 ? pages : fallbackPage();
    if (pages.length === 0) {
      console.warn(
        `[worker] template '${effectiveTemplate}' returned no pages; using placeholder fallback.`,
      );
    }

    const rewrittenPages: PagePayload[] = [];
    for (const page of payloadPages) {
      const textNodes = findAllTextNodes(page.html);
      const replacements = await deepseekRewrite(textNodes, job.payload?.description ?? '');
      const newHtml = replaceTextNodes(page.html, replacements);
      rewrittenPages.push({
        slug: page.slug,
        title: page.title,
        html: newHtml,
      });
    }

    const bundle = JSON.stringify({ pages: rewrittenPages }, null, 0);
    await pgPool.query(
      `
        UPDATE aib_jobs
        SET status = 'done',
            result_html = $1,
            error_message = NULL
        WHERE id = $2
      `,
      [bundle, job.id],
    );

    console.log(
      `[worker] job ${job.id}: done (template=${effectiveTemplate}, pages=${rewrittenPages.length})`,
    );
  } catch (error) {
    console.error(`[worker] job ${job.id} failed`, error);
    await pgPool.query(
      `
        UPDATE aib_jobs
        SET status = 'failed',
            error_message = $1
        WHERE id = $2
      `,
      [error instanceof Error ? error.message : String(error), job.id],
    );
  }
}

interface PageRow extends RowDataPacket {
  ID: number;
  post_title: string;
  post_name: string;
  post_content: string;
}

async function fetchTemplatePagesFromWp(
  templateSlug: TemplateSlug,
): Promise<{ template: TemplateSlug; pages: PagePayload[] }> {
  const sql = `
    SELECT ID, post_title, post_name, post_content
    FROM wp_posts
    WHERE post_type = 'page'
      AND post_status = 'publish'
      AND post_name LIKE ?
    ORDER BY ID
  `;
  const pattern = `${templateSlug}-%`;
  let [rows] = await mysqlPool.execute<PageRow[]>(sql, [pattern]);
  let effectiveTemplate: TemplateSlug = templateSlug;

  if (rows.length === 0 && templateSlug !== DEFAULT_TEMPLATE_SLUG) {
    console.warn(
      `[worker] no pages found for template '${templateSlug}', falling back to '${DEFAULT_TEMPLATE_SLUG}'.`,
    );
    [rows] = await mysqlPool.execute<PageRow[]>(sql, [`${DEFAULT_TEMPLATE_SLUG}-%`]);
    effectiveTemplate = DEFAULT_TEMPLATE_SLUG;
  }

  const pages = rows.map((row) => ({
    slug: row.post_name,
    title: row.post_title,
    html: row.post_content,
  }));

  return { template: effectiveTemplate, pages };
}

function fallbackPage(): PagePayload[] {
  return [
    {
      slug: 'generated-landing',
      title: 'Generated Landing',
      html: '<!-- wp:paragraph --><p>Placeholder page</p><!-- /wp:paragraph -->',
    },
  ];
}

function findAllTextNodes(html: string): string[] {
  if (!html.trim()) return [];
  const $ = load(html);
  const texts: string[] = [];
  $('*')
    .contents()
    .each((_, node) => {
      if (node.type !== 'text') return;
      const parent = node.parent || null;
      if (!parent || parent.type !== 'tag') return;
      const tagName = parent.name;
      if (tagName === 'style' || tagName === 'script') return;
      const raw = (node.data ?? '').trim();
      if (!raw) return;
      if (raw.includes('wp:')) return;
      if (raw.startsWith('[') && raw.endsWith(']')) return;
      const classes = new Set((parent.attribs?.class ?? '').split(/\s+/).filter(Boolean));
      const hasAlpha = /[A-Za-z\u00C0-\u024F]/.test(raw);
      const hasDigit = /\d/.test(raw);
      const isCountupText = classes.has('stk-block-count-up__text');
      if (!hasAlpha && !hasDigit) return;
      if (hasDigit && !hasAlpha && !isCountupText) return;
      texts.push(raw);
    });
  return texts;
}

function replaceTextNodes(html: string, replacements: string[]): string {
  if (!html.trim()) return html;
  const $ = load(html);
  let index = 0;
  $('*')
    .contents()
    .each((_, node) => {
      if (node.type !== 'text') return;
      const parent = node.parent || null;
      if (!parent || parent.type !== 'tag') return;
      const tagName = parent.name;
      if (tagName === 'style' || tagName === 'script') return;
      const raw = (node.data ?? '').trim();
      if (!raw) return;
      if (raw.includes('wp:')) return;
      if (raw.startsWith('[') && raw.endsWith(']')) return;
      const classes = new Set((parent.attribs?.class ?? '').split(/\s+/).filter(Boolean));
      const hasAlpha = /[A-Za-z\u00C0-\u024F]/.test(raw);
      const hasDigit = /\d/.test(raw);
      const isCountupText = classes.has('stk-block-count-up__text');
      if (!hasAlpha && !hasDigit) return;
      if (hasDigit && !hasAlpha && !isCountupText) return;
      if (index < replacements.length) {
        node.data = replacements[index];
        index += 1;
      }
    });
  return $.root().html() ?? html;
}

async function deepseekRewrite(texts: string[], description: string): Promise<string[]> {
  if (!texts.length) return texts;
  if (!DEEPSEEK_API_KEY) return texts;

  const systemMessage =
    '你是一位網站文案助理。' +
    '任務：根據使用者給的 `description` 與 `texts`，為網站改寫更專業、符合情境的字句。' +
    '嚴格規定：只回傳【純 JSON 字串陣列】（長度需與 texts 相同），不得包含解說、Markdown 或任何多餘文字。' +
    '若無法改寫，保留原字串。';

  const userMessage =
    'description：\n' +
    `${description}\n\n` +
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
  } catch (error) {
    console.error('[worker] deepseek rewrite failed', error);
    return texts;
  }
}

function parseJsonArray(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return validateArray(parsed);
  } catch {
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start === -1 || end === -1 || start >= end) return [];
    try {
      return validateArray(JSON.parse(raw.slice(start, end + 1)));
    } catch {
      return [];
    }
  }
}

function validateArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === 'string' ? item : String(item ?? '')));
}
