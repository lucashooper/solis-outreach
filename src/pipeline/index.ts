export { runCampaign, approveAndPitchCreator } from './runCampaign.js';
export type { RunCampaignOptions, RunCampaignResult } from './runCampaign.js';
export {
  sendCreatorOutreach,
  notifyDiscord,
  buildBestCreatorsDiscordPayload,
  templateHookFromBio,
  generateHookViaLlm,
  generateHookViaOpenAI,
} from './outreach.js';
export type { OutreachSendResult, OutreachDeps } from './outreach.js';
export {
  resolveOutreachRouting,
  campaignCompleteDiscordMessage,
  interestedReplyDiscordMessage,
} from './statusRouting.js';
