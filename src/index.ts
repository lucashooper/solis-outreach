export {
  buildPersonalizationPrompt,
  parsePersonalizationResponse,
  mergeHookIntoTemplate,
} from './personalization.js';

export {
  buildReplyClassificationPrompt,
  parseReplyClassification,
} from './reply-classifier.js';

export { buildColdEmailPayload } from './cold-email.js';

export { chatJson, isGroqConfigured } from './llm/client.js';
export type { ChatJsonOptions, ChatJsonResult } from './llm/client.js';

export {
  runDiscovery,
  discoverDemo,
  extractEmailFromBio,
  enrichCreatorEmail,
  runApifyDiscovery,
  buildApifyActorInput,
  parseApifyItem,
  parseTopVideo,
  mapApifyDatasetItems,
  aggregateTikTokCandidates,
} from './discovery/index.js';

export {
  runCampaign,
  approveAndPitchCreator,
  sendCreatorOutreach,
  notifyDiscord,
  templateHookFromBio,
  resolveOutreachRouting,
  campaignCompleteDiscordMessage,
  interestedReplyDiscordMessage,
} from './pipeline/index.js';

export type {
  Platform,
  OutreachStatus,
  SequenceStep,
  EmailProvider,
  ReplySentiment,
  Creator,
  OutreachLog,
  PersonalizationResult,
  ColdEmailInput,
  TopVideo,
} from './types.js';

export type {
  Campaign,
  CampaignStatus,
  CreatorCandidate,
  DiscoveryProviderName,
  DiscoveryRunResult,
} from './discovery/index.js';

export type { RunCampaignOptions, RunCampaignResult } from './pipeline/index.js';
