/**
 * n8n Code node (paste-ready) — Reply classifier
 *
 * Modes:
 *   build  — output { prompt } from $json.replyText / $json.text / $json.body
 *   parse  — parse LLM raw into sentiment + routing flags (default when raw present)
 *
 * Output (parse mode):
 *   {
 *     sentiment: 'Interested' | 'Not Interested' | 'Price Question' | 'Unsubscribe',
 *     shouldNotify: boolean,   // true when Interested or Price Question
 *     updateStatus: 'replied' | null  // set outreach_status when we got any classified reply
 *   }
 */

const VALID = ['Interested', 'Not Interested', 'Price Question', 'Unsubscribe'];

function buildReplyClassificationPrompt(replyText) {
  return [
    'Classify the following creator email reply into exactly one label.',
    'Allowed labels (case-sensitive): Interested | Not Interested | Price Question | Unsubscribe.',
    'Rules:',
    '- Interested: positive interest, wants to learn more, open to collab.',
    '- Not Interested: decline, not a fit, no thanks.',
    '- Price Question: asks about rates, pricing, payment, budget.',
    '- Unsubscribe: asks to stop emailing / remove from list.',
    'Output JSON only: { "sentiment": "<one of the labels>" }.',
    '',
    'Reply:',
    replyText,
  ].join('\n');
}

function tryExtractJson(text) {
  const fenceMatch = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch && fenceMatch[1] ? fenceMatch[1].trim() : String(text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

function normaliseLabel(value) {
  const trimmed = String(value).trim();
  for (let i = 0; i < VALID.length; i++) {
    if (VALID[i].toLowerCase() === trimmed.toLowerCase()) return VALID[i];
  }
  return null;
}

function parseReplyClassification(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('Reply classification response is empty or not a string');
  }
  const trimmed = raw.trim();
  const jsonCandidate = tryExtractJson(trimmed);
  if (jsonCandidate) {
    try {
      const parsed = JSON.parse(jsonCandidate);
      if (parsed && typeof parsed === 'object' && typeof parsed.sentiment === 'string') {
        const n = normaliseLabel(parsed.sentiment);
        if (n) return n;
      }
    } catch (_e) {
      // fall through
    }
  }
  for (let i = 0; i < VALID.length; i++) {
    const label = VALID[i];
    if (trimmed === label || trimmed.toLowerCase().indexOf(label.toLowerCase()) !== -1) {
      return label;
    }
  }
  throw new Error('Could not parse reply sentiment from: ' + trimmed.slice(0, 200));
}

function pickReplyText(item) {
  if (typeof item.replyText === 'string') return item.replyText;
  if (typeof item.text === 'string') return item.text;
  if (typeof item.body === 'string') return item.body;
  if (item.data && typeof item.data.text === 'string') return item.data.text;
  return null;
}

function pickLlmRaw(item) {
  if (typeof item.raw === 'string') return item.raw;
  if (typeof item.classificationRaw === 'string') return item.classificationRaw;
  if (item.message && typeof item.message.content === 'string') return item.message.content;
  if (item.choices && item.choices[0] && item.choices[0].message) {
    return item.choices[0].message.content;
  }
  if (typeof item.output === 'string') return item.output;
  if (typeof item.text === 'string' && item.text.indexOf('sentiment') !== -1) return item.text;
  return null;
}

const MODE = $json.mode || (pickLlmRaw($json) ? 'parse' : 'build');

if (MODE === 'build') {
  const replyText = pickReplyText($json);
  if (!replyText) throw new Error('Missing reply text ($json.replyText / text / body)');
  return [{ json: { prompt: buildReplyClassificationPrompt(replyText) } }];
}

if (MODE === 'parse') {
  const raw = pickLlmRaw($json);
  if (!raw) throw new Error('Missing LLM raw text for parse mode');
  const sentiment = parseReplyClassification(raw);
  const shouldNotify = sentiment === 'Interested' || sentiment === 'Price Question';
  const updateStatus = 'replied';
  return [
    {
      json: {
        sentiment: sentiment,
        shouldNotify: shouldNotify,
        updateStatus: updateStatus,
      },
    },
  ];
}

throw new Error("Unknown mode — set mode to 'build' or 'parse'");
