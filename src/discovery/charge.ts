import { roundUsd } from './budget.js';

/** Fields read from GET /v2/actor-runs/:id after the run has finished. */
export interface ApifyRunUsage {
  usageTotalUsd?: number | null;
  chargedEventCounts?: Record<string, number> | null;
  /** Event name → dollars per event. */
  pricingPerEvent?: Record<string, number> | null;
}

/**
 * What Apify actually charged. Prefer usageTotalUsd. Otherwise multiply
 * chargedEventCounts by the run's event prices. The start cap is only a fallback.
 */
export function actualRunChargeUsd(
  usage: ApifyRunUsage | null | undefined,
  fallbackUsd: number,
): number {
  const direct = Number(usage?.usageTotalUsd);
  if (Number.isFinite(direct) && direct >= 0) return roundUsd(direct);
  const counts = usage?.chargedEventCounts;
  const prices = usage?.pricingPerEvent;
  if (counts && prices) {
    let sum = 0;
    let priced = false;
    for (const [name, count] of Object.entries(counts)) {
      const price = Number(prices[name]);
      const n = Number(count);
      if (!Number.isFinite(price) || !Number.isFinite(n) || n < 0 || price < 0) continue;
      sum += price * n;
      priced = true;
    }
    if (priced) return roundUsd(sum);
  }
  const fallback = Number(fallbackUsd);
  return Number.isFinite(fallback) && fallback >= 0 ? roundUsd(fallback) : 0;
}

function asCountMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const n = Number(raw);
    if (!key || !Number.isFinite(n) || n < 0) continue;
    out[key] = n;
  }
  return out;
}

function asPriceMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const price = Number((raw as { eventPriceUsd?: unknown }).eventPriceUsd);
      if (Number.isFinite(price) && price >= 0) out[key] = price;
      continue;
    }
    const price = Number(raw);
    if (Number.isFinite(price) && price >= 0) out[key] = price;
  }
  return out;
}

/** Pull usage off an Apify run payload. Ignores anything that is not a charge. */
export function usageFromApifyRun(data: Record<string, unknown> | null | undefined): ApifyRunUsage {
  if (!data) return {};
  const usageTotalUsd = Number(data.usageTotalUsd);
  const chargedEventCounts = asCountMap(data.chargedEventCounts);
  const pricing = data.pricingInfo;
  const pricingRecord =
    pricing && typeof pricing === 'object' && !Array.isArray(pricing)
      ? (pricing as Record<string, unknown>)
      : null;
  const perEvent =
    pricingRecord?.pricingPerEvent && typeof pricingRecord.pricingPerEvent === 'object'
      ? (pricingRecord.pricingPerEvent as Record<string, unknown>)
      : null;
  const events = perEvent?.actorChargeEvents ?? perEvent;
  const pricingPerEvent = asPriceMap(events);
  return {
    ...(Number.isFinite(usageTotalUsd) && usageTotalUsd >= 0 ? { usageTotalUsd } : {}),
    ...(Object.keys(chargedEventCounts).length > 0 ? { chargedEventCounts } : {}),
    ...(Object.keys(pricingPerEvent).length > 0 ? { pricingPerEvent } : {}),
  };
}
