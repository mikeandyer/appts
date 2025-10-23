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
        TEMPLATE_SLUGS.includes(normalisedCandidate));
}
export function toAiBrief(value) {
    if (isAiBrief(value))
        return value;
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
    };
}
