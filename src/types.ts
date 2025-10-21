export type Tone = 'professional' | 'friendly' | 'playful' | 'minimal';

export interface AiBrief {
  businessName: string;
  industry: string;
  description: string;
  tone: Tone;
  color: string;
}

const TONES: readonly Tone[] = ['professional', 'friendly', 'playful', 'minimal'];

export function isAiBrief(value: unknown): value is AiBrief {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.businessName === 'string' &&
    typeof record.industry === 'string' &&
    typeof record.description === 'string' &&
    typeof record.tone === 'string' &&
    TONES.includes(record.tone as Tone) &&
    typeof record.color === 'string'
  );
}

export function toAiBrief(value: unknown): AiBrief {
  if (isAiBrief(value)) return value;
  return {
    businessName: String((value as Record<string, unknown>)?.businessName ?? ''),
    industry: String((value as Record<string, unknown>)?.industry ?? ''),
    description: String((value as Record<string, unknown>)?.description ?? ''),
    tone: 'professional',
    color: String((value as Record<string, unknown>)?.color ?? '#4f46e5'),
  };
}
