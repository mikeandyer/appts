const TONES = ['professional', 'friendly', 'playful', 'minimal'];
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
];
const FALSE_LITERALS = new Set(['false', '0', 'off', 'no']);
const TRUE_LITERALS = new Set(['true', '1', 'on', 'yes']);
function normalizeBooleanLike(raw) {
    if (typeof raw === 'boolean')
        return raw;
    if (typeof raw === 'number') {
        if (!Number.isFinite(raw))
            return undefined;
        return raw !== 0;
    }
    if (typeof raw === 'string') {
        const normalised = raw.trim().toLowerCase();
        if (normalised === '')
            return undefined;
        if (FALSE_LITERALS.has(normalised))
            return false;
        if (TRUE_LITERALS.has(normalised))
            return true;
    }
    return undefined;
}
export function normalizeUsePexelsHero(raw) {
    const parsed = normalizeBooleanLike(raw);
    if (parsed === undefined) {
        return true;
    }
    return parsed;
}
function normaliseTemplateSlug(raw) {
    const slug = typeof raw === 'string' ? raw : '';
    const candidate = slug
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/_/g, '-');
    if (TEMPLATE_SLUGS.includes(candidate)) {
        return candidate;
    }
    return 'wood';
}
export function isAiBrief(value) {
    if (!value || typeof value !== 'object')
        return false;
    const record = value;
    const templateCandidate = record.templateSlug ?? record.templateKey;
    const normalisedCandidate = typeof templateCandidate === 'string'
        ? templateCandidate.trim().toLowerCase().replace(/\s+/g, '-').replace(/_/g, '-')
        : null;
    return (typeof record.businessName === 'string' &&
        typeof record.industry === 'string' &&
        typeof record.description === 'string' &&
        typeof record.tone === 'string' &&
        TONES.includes(record.tone) &&
        typeof record.color === 'string' &&
        typeof normalisedCandidate === 'string' &&
        TEMPLATE_SLUGS.includes(normalisedCandidate) &&
        (record.language === undefined || typeof record.language === 'string') &&
        (record.usePexelsHero === undefined || normalizeBooleanLike(record.usePexelsHero) !== undefined));
}
export function toAiBrief(value) {
    if (isAiBrief(value)) {
        const brief = value;
        return {
            ...brief,
            usePexelsHero: normalizeUsePexelsHero(brief.usePexelsHero),
        };
    }
    const record = value ?? {};
    const tone = typeof record.tone === 'string' && TONES.includes(record.tone)
        ? record.tone
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
