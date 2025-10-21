const TONES = ['professional', 'friendly', 'playful', 'minimal'];
export function isAiBrief(value) {
    if (!value || typeof value !== 'object')
        return false;
    const record = value;
    return (typeof record.businessName === 'string' &&
        typeof record.industry === 'string' &&
        typeof record.description === 'string' &&
        typeof record.tone === 'string' &&
        TONES.includes(record.tone) &&
        typeof record.color === 'string');
}
export function toAiBrief(value) {
    if (isAiBrief(value))
        return value;
    return {
        businessName: String(value?.businessName ?? ''),
        industry: String(value?.industry ?? ''),
        description: String(value?.description ?? ''),
        tone: 'professional',
        color: String(value?.color ?? '#4f46e5'),
    };
}
