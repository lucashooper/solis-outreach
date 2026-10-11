/**
 * n8n Code node (paste-ready) — Creator personalisation
 *
 * Mode A — build prompt (run BEFORE the OpenAI/Anthropic node):
 *   Input:  $json.bio, $env.APP_NAME, $env.APP_VALUE_PROP
 *   Output: { prompt }
 *
 * Mode B — parse + merge (run AFTER the LLM node):
 *   Input:  $json.raw or $json.text or $json.message.content (LLM output),
 *           $json.template (email body with {{hook}} / {{key}} placeholders),
 *           optional $json.vars (object of extra replacements)
 *   Output: { hook, emailBody }
 *
 * Set MODE below, or pass $json.mode = 'build' | 'merge'.
 */

const MODE = $json.mode || 'build'; // 'build' | 'merge'

function buildPersonalizationPrompt(bio, appName, valueProp) {
  return [
    `Analyze this creator's bio and content: ${bio}.`,
    `Generate 1 personalized, informal sentence explaining why our app (${appName}) fits their specific style.`,
    `Our value proposition: ${valueProp}.`,
    `Output JSON only.`,
    `Expected shape: { "hook": "..." }`,
  ].join(' ');
}

function extractJsonObject(raw) {
  const trimmed = String(raw).trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch && fenceMatch[1] ? fenceMatch[1].trim() : trimmed;
  const start = candidate.indexOf('{');
  if (start === -1) throw new Error('Could not find a JSON object in personalisation response');

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  throw new Error('Could not find a JSON object in personalisation response');
}

function parsePersonalizationResponse(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('Personalisation response is empty or not a string');
  }
  const jsonText = extractJsonObject(raw);
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error('Personalisation response is not valid JSON: ' + err.message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Personalisation response must be a JSON object');
  }
  const hook = parsed.hook;
  if (typeof hook !== 'string' || hook.trim() === '') {
    throw new Error('Personalisation response missing non-empty string "hook"');
  }
  return { hook: hook.trim() };
}

function mergeHookIntoTemplate(template, hook, vars) {
  const replacements = Object.assign({ hook: hook }, vars || {});
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, function (match, key) {
    if (Object.prototype.hasOwnProperty.call(replacements, key)) {
      return replacements[key] == null ? '' : String(replacements[key]);
    }
    return match;
  });
}

function pickLlmRaw(item) {
  if (typeof item.raw === 'string') return item.raw;
  if (typeof item.text === 'string') return item.text;
  if (item.message && typeof item.message.content === 'string') return item.message.content;
  if (item.choices && item.choices[0] && item.choices[0].message) {
    return item.choices[0].message.content;
  }
  if (typeof item.output === 'string') return item.output;
  throw new Error('Could not locate LLM raw text on item (expected raw/text/message.content)');
}

if (MODE === 'build') {
  const bio = $json.bio != null ? String($json.bio) : '';
  const appName = $env.APP_NAME || $json.appName || 'Our App';
  const valueProp = $env.APP_VALUE_PROP || $json.valueProp || '';
  if (!bio) throw new Error('Missing $json.bio');
  return [{ json: { prompt: buildPersonalizationPrompt(bio, appName, valueProp) } }];
}

if (MODE === 'merge') {
  const raw = pickLlmRaw($json);
  const { hook } = parsePersonalizationResponse(raw);
  const template = $json.template != null ? String($json.template) : '';
  if (!template) throw new Error('Missing $json.template for merge mode');
  const vars = $json.vars && typeof $json.vars === 'object' ? $json.vars : {};
  const emailBody = mergeHookIntoTemplate(template, hook, vars);
  return [{ json: { hook: hook, emailBody: emailBody } }];
}

throw new Error("Unknown mode — set mode to 'build' or 'merge'");
