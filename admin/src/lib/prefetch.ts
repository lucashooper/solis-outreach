import { fetchAnalytics, fetchCampaigns, fetchStatusCounts } from './supabase';
import type { AnalyticsSummary } from './supabase';
import type { Campaign, StatusCounts } from './types';
import { getCache, putCache } from './shellCache';

export interface DashboardCache {
  counts: StatusCounts;
  analytics: AnalyticsSummary | null;
}

export function dashboardCacheKey(appId: string): string {
  return `dashboard:${appId}`;
}

export function campaignsCacheKey(appId: string): string {
  return `campaigns:${appId}`;
}

export function prefetchAppShell(appId: string | null | undefined): void {
  if (!appId) return;
  if (!getCache<DashboardCache>(dashboardCacheKey(appId))) {
    void Promise.all([
      fetchStatusCounts(appId),
      fetchAnalytics(appId).catch(() => null),
    ])
      .then(([counts, analytics]) => {
        putCache<DashboardCache>(dashboardCacheKey(appId), { counts, analytics });
      })
      .catch(() => {
        /* the page will show its own error */
      });
  }
  if (!getCache<Campaign[]>(campaignsCacheKey(appId))) {
    void fetchCampaigns(appId)
      .then((rows) => putCache(campaignsCacheKey(appId), rows))
      .catch(() => {
        /* the page will show its own error */
      });
  }
}
