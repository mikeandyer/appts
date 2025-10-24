export type Tone = 'professional' | 'friendly' | 'playful' | 'minimal';
export interface AiBrief {
  businessName: string;
  industry: string;
  description: string;
  tone: Tone;
  color: string;
  templateSlug: string;
  language?: string;
  usePexelsHero?: boolean;
}

const TONES: readonly Tone[] = ['professional', 'friendly', 'playful', 'minimal'];
export const TEMPLATE_SLUGS = [
  'wood',
  'modern-shop',
  'app',
  'news',
  'photo-studio',
  'restaurant',
  'renovation',
  'beverr',
  'catering',
  'barber-shop',
  'bizconsult',
  'gadgets',
  'home-decor',
  'cleaning-service',
  'car-service',
  'floreo',
  'garderobe',
  'petsy',
  'justice',
  'wedding',
  'web-agency',
  'persona',
  'yogi',
  'homi',
  'tasty',
  'business',
  'product-reviews',
  'charity',
  'travel',
] as const;

export type TemplateSlug = (typeof TEMPLATE_SLUGS)[number];

const FALSE_LITERALS = new Set(['false', '0', 'off', 'no']);
const TRUE_LITERALS = new Set(['true', '1', 'on', 'yes']);

function normalizeBooleanLike(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return undefined;
    return raw !== 0;
  }
  if (typeof raw === 'string') {
    const normalised = raw.trim().toLowerCase();
    if (normalised === '') return undefined;
    if (FALSE_LITERALS.has(normalised)) return false;
    if (TRUE_LITERALS.has(normalised)) return true;
  }
  return undefined;
}

export function normalizeUsePexelsHero(raw: unknown): boolean {
  const parsed = normalizeBooleanLike(raw);
  if (parsed === undefined) {
    return true;
  }
  return parsed;
}

function normaliseTemplateSlug(raw: unknown): TemplateSlug {
  const slug = typeof raw === 'string' ? raw : '';
  const candidate = slug
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/_/g, '-');
  if ((TEMPLATE_SLUGS as readonly string[]).includes(candidate)) {
    return candidate as TemplateSlug;
  }
  return 'wood';
}

export function isAiBrief(value: unknown): value is AiBrief {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const templateCandidate = record.templateSlug ?? record.templateKey;
  const normalisedCandidate =
    typeof templateCandidate === 'string'
      ? templateCandidate.trim().toLowerCase().replace(/\s+/g, '-').replace(/_/g, '-')
      : null;
  return (
    typeof record.businessName === 'string' &&
    typeof record.industry === 'string' &&
    typeof record.description === 'string' &&
    typeof record.tone === 'string' &&
    TONES.includes(record.tone as Tone) &&
    typeof record.color === 'string' &&
    typeof normalisedCandidate === 'string' &&
    (TEMPLATE_SLUGS as readonly string[]).includes(normalisedCandidate) &&
    (record.language === undefined || typeof record.language === 'string') &&
    (record.usePexelsHero === undefined || normalizeBooleanLike(record.usePexelsHero) !== undefined)
  );
}

export function toAiBrief(value: unknown): AiBrief {
  if (isAiBrief(value)) {
    const brief = value as AiBrief;
    return {
      ...brief,
      usePexelsHero: normalizeUsePexelsHero(brief.usePexelsHero),
    };
  }
  const record = (value as Record<string, unknown>) ?? {};
  const tone = typeof record.tone === 'string' && TONES.includes(record.tone as Tone)
    ? (record.tone as Tone)
    : 'professional';
  const templateSource = record.templateSlug ?? record.templateKey ?? null;
  const templateSlug = normaliseTemplateSlug(templateSource);

  return {
    businessName: String(record.businessName ?? ''),
    industry: String(record.industry ?? ''),
    description: String(record.description ?? ''),
    tone,
    color: typeof record.color === 'string' ? record.color : '#4f46e5',
    templateSlug,
    language: typeof record.language === 'string' ? record.language : undefined,
    usePexelsHero: normalizeUsePexelsHero(record.usePexelsHero),
  };
}
