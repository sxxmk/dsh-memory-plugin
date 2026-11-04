/**
 * Host half of `@local/dsh-memory-plugin`.
 *
 * Two responsibilities:
 *
 * 1. After a turn closes, decide whether the conversation said anything worth
 *    remembering, ask the user to confirm it in the Web UI, and append the
 *    confirmed lines to `MEMORY.md` in the session's working directory.
 * 2. Keep feeding the current `MEMORY.md` into the system prompt of every live
 *    agent, re-read from disk on each assembly so an edit made by anything
 *    (this plugin, the model, you in an editor) is picked up on the next step.
 *
 * The browser half (`client.js`) renders the confirmation dialog and talks to
 * this file over the two routes registered at the bottom of `apply()`.
 */

import { createHash } from 'node:crypto';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/* ------------------------------------------------------------------ config */

/** Bumped whenever the Host half changes, so `/status` can prove what is loaded. */
const PLUGIN_BUILD = 'dsh-memory-plugin/1.4.3';

const DEFAULTS = {
  enabled: true,
  file: 'MEMORY.md',
  declinedFile: '.dsh-memory-declined.json',
  maxDeclinedPrompt: 60,
  provider: '',
  model: '',
  reasoningEffort: 'high',
  maxItems: 3,
  minConfidence: 0.6,
  maxItemChars: 320,
  maxTranscriptChars: 14000,
  confirmTimeoutMs: 900000,
  injectPrompt: true,
  maxInjectChars: 6000,
  debounceMs: 800,
  contextOrder: 200,
};

function normalizeConfig(raw) {
  const config = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return config;
  if (typeof raw.enabled === 'boolean') config.enabled = raw.enabled;
  if (typeof raw.injectPrompt === 'boolean') config.injectPrompt = raw.injectPrompt;
  if (typeof raw.file === 'string' && raw.file.trim()) config.file = raw.file.trim();
  if (typeof raw.declinedFile === 'string' && raw.declinedFile.trim()) config.declinedFile = raw.declinedFile.trim();
  if (typeof raw.provider === 'string') config.provider = raw.provider.trim();
  if (typeof raw.model === 'string') config.model = raw.model.trim();
  if (typeof raw.reasoningEffort === 'string' && raw.reasoningEffort.trim()) {
    config.reasoningEffort = raw.reasoningEffort.trim();
  }
  for (const key of ['maxItems', 'maxItemChars', 'maxTranscriptChars', 'maxInjectChars', 'maxDeclinedPrompt', 'debounceMs', 'contextOrder']) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) config[key] = Math.floor(value);
  }
  if (typeof raw.minConfidence === 'number' && Number.isFinite(raw.minConfidence)) {
    config.minConfidence = Math.min(1, Math.max(0, raw.minConfidence));
  }
  if (typeof raw.confirmTimeoutMs === 'number' && Number.isFinite(raw.confirmTimeoutMs) && raw.confirmTimeoutMs >= 0) {
    config.confirmTimeoutMs = Math.floor(raw.confirmTimeoutMs);
  }
  return config;
}

/* ----------------------------------------------------------------- prompts */

/** The kinds of memory the extractor is allowed to produce. */
const MEMORY_KINDS = new Set(['preference', 'convention', 'command', 'decision', 'correction']);

/**
 * The extraction prompt.
 *
 * The bar is deliberately three-part and conjunctive: a fact has to be about
 * this user or project, has to be something a fresh assistant could not read
 * off the repository, and has to cost the user something if forgotten. The
 * middle test is what keeps out "I learned how X works" — those are the items
 * that made the file noisy, and they are all rediscoverable.
 */
function analysisSystemPrompt(maxItems) {
  return [
    'You maintain a long-term memory file for a coding assistant.',
    'You are given the transcript of the turn that just finished, plus the current contents of the memory file.',
    '',
    'An item earns a place only if ALL THREE hold:',
    '1. It is about THIS user or THIS project: a preference, a convention, a command, a constraint, or a decision with the reason behind it.',
    '2. It is not general knowledge about a library, framework, or the environment. If a fresh assistant could look it up in documentation or a package\'s own source, it is not memory, even when it took you a while to find.',
    '3. Forgetting it costs the user something: they would have to repeat themselves, or correct the assistant a second time.',
    '',
    'A requirement that shaped this project still counts after it is implemented. The resulting code can look self-explanatory while the reason behind it is nowhere in the repository, and that reason is exactly what belongs here.',
    '',
    'Worth recording:',
    '- how the user wants the assistant to work (language, formatting, tooling, naming, review habits)',
    '- project conventions, commands and layout that will still be true next week',
    '- decisions the user made, with the reason, when that reason is not visible in the code',
    '- corrections the user issued about how the assistant should behave',
    '',
    'These two always pass, regardless of the tests above:',
    '- the user states directly how they want the assistant to behave ("be more conservative", "always answer in Chinese", "never run git push"): record it as one `preference` or `correction` item unless it is already in the file, even if that is the only thing in the turn',
    '- the user states a requirement or constraint for this project that is not written down in it (a fixed setting, a deliberate restriction, a non-obvious ordering): record it as one `convention` or `decision` item',
    '',
    'Never record:',
    '- API surface, library behaviour, environment capabilities, or how a tool works: the assistant can look these up, and verifying them is not the same as remembering',
    '- what the assistant did in this turn, or what it learned while doing it',
    '- anything already in the memory file, or a paraphrase of it',
    '- anything in the DECLINED list or a rewording of it: the user already said no, and repeating it in a later turn does not make it memorable',
    '- transient task state, progress, plans or to-do items',
    '- secrets, API keys, tokens, passwords',
    '- anything that only matters for this one request',
    '',
    'When a turn has nothing on the two lists above, record nothing: an empty list is the correct answer and the common case.',
    `One solid memory is worth more than five plausible ones. Never return more than ${maxItems}.`,
    '',
    'Each memory is one self-contained sentence, written in the language the user is using in the transcript, understandable with no surrounding context.',
    '',
    'Answer with JSON only, no prose and no code fences, in exactly this shape:',
    '{"memories":[{"kind":"preference|convention|command|decision|correction","confidence":0.0,"text":"..."}]}',
    '',
    '`confidence` is your honest probability that a careful reviewer would agree the item passes all three tests.',
    'Do not inflate it. An item you would defend only weakly belongs at or below 0.5, and will be discarded.',
  ].join('\n');
}

const ANALYSIS_USER = [
  'Current contents of the memory file (may be empty):',
  '<<<MEMORY',
  '{memory}',
  'MEMORY>>>',
  '',
  'Items the user has explicitly DECLINED before. Never propose these again, and',
  'never propose a rewording of one (an empty list means nothing was declined yet):',
  '<<<DECLINED',
  '{declined}',
  'DECLINED>>>',
  '',
  'Transcript of the turn that just finished:',
  '<<<TRANSCRIPT',
  '{transcript}',
  'TRANSCRIPT>>>',
  '',
  'Judge strictly. An empty list is the normal answer.',
].join('\n');

/**
 * Keep only the candidates that survive the confidence gate.
 *
 * The prompt asks for `kind` and `confidence`, but a model can always answer in
 * the older plain shape. If no entry carries a confidence, the gate is skipped
 * and the list is taken as-is rather than silently dropping everything.
 */
function selectCandidates(list, options) {
  const entries = Array.isArray(list) ? list : [];
  const maxItems = options && options.maxItems > 0 ? options.maxItems : 3;
  const minConfidence = options && typeof options.minConfidence === 'number' ? options.minConfidence : 0.7;
  const maxChars = options && options.maxItemChars > 0 ? options.maxItemChars : 320;
  const gated = entries.some((entry) => typeof entry?.confidence === 'number');
  const seen = new Set();
  const chosen = [];
  for (const entry of entries) {
    const text = String(entry?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (gated) {
      const confidence = typeof entry?.confidence === 'number' ? entry.confidence : 0;
      if (!(confidence >= minConfidence)) continue;
      const kind = typeof entry?.kind === 'string' ? entry.kind.trim().toLowerCase() : '';
      if (kind && !MEMORY_KINDS.has(kind)) continue;
    }
    const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
    const key = normalizeForCompare(clipped);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    chosen.push(clipped);
    if (chosen.length >= maxItems) break;
  }
  return chosen;
}

/* ----------------------------------------------------------------- helpers */

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  const parts = [];
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

function clampTail(text, limit) {
  if (text.length <= limit) return text;
  return '…' + text.slice(text.length - limit);
}

/** Text of one closed turn, rebuilt from the durable session log. */
function transcriptForTurn(session, turn) {
  let events;
  try {
    events = session.ownEvents();
  } catch {
    return '';
  }
  let end = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'turn/end' && event.data && event.data.turn === turn) {
      end = index;
      break;
    }
  }
  if (end < 0) return '';
  // Find this turn's own start. Falling back to the top of the session here
  // would silently widen the scope from "this exchange" to "the whole
  // conversation" — and the analysis would then mine old turns for memories
  // under the guise of reviewing the newest one.
  let start = -1;
  for (let index = end; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'turn/start' && event.data && event.data.turn === turn) {
      start = index;
      break;
    }
  }
  if (start < 0) {
    // No start marker (a compaction can replace the span that held it). Bound
    // the reply to the previous turn's end for the same reason.
    start = 0;
    for (let index = end - 1; index >= 0; index -= 1) {
      if (events[index]?.type === 'turn/end') {
        start = index + 1;
        break;
      }
    }
  }
  const lines = [];
  for (let index = start; index <= end; index += 1) {
    const event = events[index];
    // A compaction also writes a `user/message`: the checkpoint that replaces the
    // span it summarised. It is derived text, not something the user said, so it
    // must never reach the analysis — otherwise a mid-turn auto-compaction makes
    // the plugin re-extract "memories" out of a summary of the conversation.
    if (typeof event.surfaceOp === 'object' && event.surfaceOp !== null && event.surfaceOp.op === 'replace') continue;
    if (event.type === 'user/message') {
      const text = messageText(event.data);
      if (text) lines.push(`USER: ${text}`);
    } else if (event.type === 'assistant/message') {
      const text = messageText(event.data.message);
      if (text) lines.push(`ASSISTANT: ${text}`);
    }
  }
  return lines.join('\n\n');
}

/**
 * The turn number and the closing `turn/end` sequence of the most recent
 * closed, analysable turn of one session.
 *
 * The sequence is what the browser half anchors the confirmation card on: it
 * receives the Turn's closing sequence directly, so matching `seq` needs no
 * assumption about how the two halves number turns.
 */
function lastClosedTurn(session) {
  let events;
  try {
    events = session.ownEvents();
  } catch {
    return null;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== 'turn/end') continue;
    const kind = event.data?.reason?.kind;
    if (kind === 'completed' || kind === 'max-tokens') {
      return { turn: event.data.turn, seq: typeof event.seq === 'number' ? event.seq : null };
    }
  }
  return null;
}

/**
 * The closing `turn/end` of one specific turn, or null when that turn has not
 * closed yet. Used by `POST /scan` to re-run an older turn while tuning the
 * extraction prompt, which otherwise only knows how to look at the newest one.
 */
function closedTurnAt(session, turn) {
  let events;
  try {
    events = session.ownEvents();
  } catch {
    return null;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== 'turn/end') continue;
    if (event.data?.turn !== turn) continue;
    const kind = event.data?.reason?.kind;
    if (kind === 'completed' || kind === 'max-tokens') {
      return { turn, seq: typeof event.seq === 'number' ? event.seq : null };
    }
    return null;
  }
  return null;
}
/**
 * Whether this session currently has a turn open.
 *
 * Read from the log tail rather than tracked with an event counter. A counter
 * misses the `turn/start` of a turn that was already running when the plugin
 * loaded — a mid-turn reload is normal here — and from then on every later turn
 * looks closed. The tail is stateless, so it is right after any reload, and it
 * stops at the first boundary: two comparisons in the common case.
 */
function turnIsOpen(session) {
  if (!session) return false;
  let events;
  try {
    events = session.ownEvents();
  } catch {
    return false;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]?.type;
    if (type === 'turn/end') return false;
    if (type === 'turn/start') return true;
  }
  return false;
}

/** Pull the first JSON object out of a model answer, fences and prose included. */
function extractJson(text) {
  const source = String(text ?? '').trim();
  if (!source) return undefined;
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : source;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function normalizeForCompare(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Cheap language-agnostic fingerprint: latin words, plus CJK character bigrams
 * (Chinese has no spaces, so whole-text token comparison would never match).
 */
function fingerprint(text) {
  const normalized = normalizeForCompare(text).replace(/[，。；：！？、「」『』（）【】《》…—]/g, ' ');
  const tokens = new Set();
  for (const word of normalized.match(/[a-z0-9_.#:@/-]{2,}/g) ?? []) tokens.add(word);
  const cjk = normalized.replace(/[^\u3400-\u9fff]/g, '');
  if (cjk.length === 1) tokens.add(cjk);
  for (let index = 0; index + 1 < cjk.length; index += 1) tokens.add(cjk.slice(index, index + 2));
  return tokens;
}

function similarity(left, right) {
  const a = left instanceof Set ? left : fingerprint(left);
  const b = right instanceof Set ? right : fingerprint(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Does `text` restate anything already in `others`?
 *
 * Deliberately conservative. The prompt carries the whole declined list and is
 * the mechanism that catches paraphrases; this net only has to catch the case
 * where the model hands back a near-verbatim rewrite of something the user has
 * already refused. Word-boundary and character n-gram evidence is required, so
 * genuinely different facts that merely share vocabulary stay proposable.
 */
const CONTAINMENT_MIN_CHARS = 10;
const SHARED_TOKEN_MIN = 6;
const SHARED_TOKEN_RATIO = 0.45;

function restates(text, others) {
  const normalized = normalizeForCompare(text);
  if (!normalized) return true;
  const own = fingerprint(normalized);
  for (const other of others) {
    const candidate = normalizeForCompare(other);
    if (!candidate) continue;
    if (candidate === normalized) return true;
    if (normalized.length >= CONTAINMENT_MIN_CHARS && candidate.length >= CONTAINMENT_MIN_CHARS
      && (normalized.includes(candidate) || candidate.includes(normalized))) return true;
    const theirs = fingerprint(candidate);
    if (own.size === 0 || theirs.size === 0) continue;
    let shared = 0;
    for (const token of own) if (theirs.has(token)) shared += 1;
    if (shared >= SHARED_TOKEN_MIN && shared / Math.min(own.size, theirs.size) >= SHARED_TOKEN_RATIO) return true;
  }
  return false;
}

const DECLINED_VERSION = 1;

/**
 * Pure helpers exported for the offline checks only; the Loader reads `apply`,
 * `inject` and `Config` and ignores everything else.
 */
export const __internals = { fingerprint, similarity, restates, appendMemories, readDeclined, selectCandidates, transcriptForTurn };

/** Read the sidecar list of items the user refused to remember. */
function readDeclined(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return items
      .map((entry) => (typeof entry === 'string' ? entry : entry?.text))
      .filter((text) => typeof text === 'string' && text.trim().length > 0);
  } catch {
    return [];
  }
}

/** Append newly declined items, skipping ones already recorded as declined. */
function appendDeclined(path, lines) {
  const existing = readDeclined(path);
  const fresh = [];
  for (const line of lines) {
    const clean = String(line ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    if (restates(clean, existing)) continue;
    if (fresh.some((other) => restates(clean, [other]))) continue;
    fresh.push(clean);
  }
  if (fresh.length === 0) return 0;
  const now = Date.now();
  const merged = [...existing, ...fresh].slice(-500);
  writeFileSync(path, `${JSON.stringify({
    version: DECLINED_VERSION,
    updatedAt: now,
    items: merged.map((text) => ({ text, declinedAt: now })),
  }, null, 2)}\n`, 'utf8');
  return fresh.length;
}

/**
 * Settings the user can change from the sidebar.
 *
 * Kept beside the memory file rather than in the profile patch: the strictness
 * of extraction is a property of this project's memory, and the file lives next
 * to the data it governs, so it travels with the workspace and stays editable by
 * hand. A missing or broken file simply means "use the bundle default".
 */
const SETTINGS_FILE = '.dsh-memory-config.json';

function settingsPathFor(memoryPath) {
  return join(dirname(memoryPath), SETTINGS_FILE);
}

/** Read the workspace overrides; `{}` when the file is absent or unusable. */
function readSettings(memoryPath) {
  try {
    const parsed = JSON.parse(readFileSync(settingsPathFor(memoryPath), 'utf8'));
    const settings = {};
    if (typeof parsed?.minConfidence === 'number' && Number.isFinite(parsed.minConfidence)) {
      settings.minConfidence = Math.min(1, Math.max(0, parsed.minConfidence));
    }
    return settings;
  } catch {
    return {};
  }
}

/** Merge one change into the workspace overrides and return what was stored. */
function writeSettings(memoryPath, patch) {
  const next = Object.assign({}, readSettings(memoryPath), patch);
  writeFileSync(settingsPathFor(memoryPath), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

const MEMORY_HEADER = [
  '# MEMORY',
  '',
  '<!-- Maintained by @local/dsh-memory-plugin: confirmed facts the assistant should carry between conversations. -->',
  '',
  '## Remembered facts',
  '',
  '',
].join('\n');

/** One bullet line is one memory; the id is derived from its text, so it survives re-reads. */
function entryId(text) {
  return `m_${createHash('sha1').update(normalizeForCompare(text)).digest('hex').slice(0, 12)}`;
}

/**
 * Parse the managed bullet list.
 *
 * The file is the source of truth (the system prompt injects it verbatim), so the
 * panel edits bullets in place rather than keeping a second copy anywhere.
 * Anything that is not a `- ` bullet is not a memory and does not survive a
 * rewrite — the header comment says as much in the file itself.
 */
function readEntries(path) {
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  const seen = new Set();
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
    if (!match) continue;
    const text = match[1].trim();
    const id = entryId(text);
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, text });
  }
  return entries;
}

function writeEntries(path, entries) {
  const bullets = entries.map((entry) => `- ${entry.text}`).join('\n');
  writeFileSync(path, entries.length === 0 ? MEMORY_HEADER : `${MEMORY_HEADER}${bullets}\n`, 'utf8');
}

/** Append confirmed lines; returns how many were actually new. */
function appendMemories(path, lines) {
  const entries = readEntries(path);
  const texts = entries.map((entry) => entry.text);
  const fresh = [];
  for (const line of lines) {
    const clean = String(line ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    if (restates(clean, texts)) continue;
    if (fresh.some((other) => restates(clean, [other]))) continue;
    fresh.push(clean);
  }
  if (fresh.length === 0) return { written: 0, entries };
  const next = [...entries, ...fresh.map((text) => ({ id: entryId(text), text }))];
  writeEntries(path, next);
  return { written: fresh.length, entries: next };
}

/** Apply one panel edit. Throws on an unknown action or a missing id. */
function mutateEntries(path, action, payload) {
  const entries = readEntries(path);
  const clean = String(payload?.text ?? '').replace(/\s+/g, ' ').trim();
  if (action === 'add') {
    if (!clean) throw new Error('text is required');
    if (restates(clean, entries.map((entry) => entry.text))) {
      return { changed: false, entries, reason: 'already remembered' };
    }
    entries.push({ id: entryId(clean), text: clean });
  } else if (action === 'update') {
    const index = entries.findIndex((entry) => entry.id === String(payload?.id ?? ''));
    if (index < 0) throw new Error('no memory with that id');
    if (!clean) throw new Error('text is required');
    if (restates(clean, entries.filter((_, at) => at !== index).map((entry) => entry.text))) {
      return { changed: false, entries, reason: 'already remembered' };
    }
    entries[index] = { id: entryId(clean), text: clean };
  } else if (action === 'delete') {
    const index = entries.findIndex((entry) => entry.id === String(payload?.id ?? ''));
    if (index < 0) throw new Error('no memory with that id');
    entries.splice(index, 1);
  } else {
    throw new Error(`unknown action ${JSON.stringify(action)}`);
  }
  writeEntries(path, entries);
  return { changed: true, entries };
}

/** Read the file, caching on mtime+size so a live edit invalidates immediately. */
function makeLiveReader() {
  const cache = new Map();
  return function read(path) {
    try {
      const info = statSync(path);
      const hit = cache.get(path);
      if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.text;
      const text = readFileSync(path, 'utf8');
      cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, text });
      return text;
    } catch {
      cache.delete(path);
      return '';
    }
  };
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function readJsonBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

/** Same-origin guard: the route is a local control surface, not a public API. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ plugin */

export const inject = ['sessions', 'systemPrompt', 'llm', 'webServer', 'workingDirectory'];

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);

  /** Cordis ships its logger under a few shapes; fall back to the process console. */
  const log = (level, message) => {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-memory-plugin') : ctx.logger;
    const target = logger && typeof logger[level] === 'function' ? logger : console;
    target[level](`[memory] ${message}`);
  };

  if (!config.enabled) {
    log('info', 'disabled by config');
    return;
  }

  const readLive = makeLiveReader();
  /** sessionId -> { running, dirty, timer } — one analysis pipeline per session. */
  const pipelines = new Map();
  /** agentId -> disposer for that agent's prompt-context registration. */
  const agentEffects = new Map();
  const timers = new Set();
  const inflight = new Set();

  /**
   * sessionId -> batch waiting for the user. Keyed by session on purpose: two
   * workspaces can each finish a turn, and their batches target different
   * `MEMORY.md` files, so a single global slot would merge one workspace's
   * candidates into the other workspace's file.
   */
  const pendingBatches = new Map();
  /** sessionId -> in-flight analysis count, so the UI can say "extracting memory". */
  const analysing = new Map();
  /** Most recent memory-file path seen, so read-only routes can resolve the sidecar. */
  let lastMemoryPath = null;
  /** Last analysis attempt, stage by stage: the only observability a plugin gets. */
  let lastRun = null;
  /**
   * What the extractor was actually shown, kept apart from `lastRun` so it
   * survives into an `empty` verdict — "it found nothing, but what did it read?"
   * is the question that matters when tuning the prompt.
   */
  let lastTranscript = null;
  function noteRun(phase, extra) {
    lastRun = Object.assign({ at: Date.now(), phase }, extra || {});
  }

  ctx.effect(() => () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const controller of inflight) controller.abort();
    inflight.clear();
    for (const dispose of agentEffects.values()) {
      try {
        dispose();
      } catch {
        /* already gone */
      }
    }
    agentEffects.clear();
    pendingBatches.clear();
    analysing.clear();
  });

  function later(fn, delay) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      try {
        fn();
      } catch (error) {
        log('error', `scheduled work failed: ${error?.message ?? error}`);
      }
    }, delay);
    timers.add(timer);
    return timer;
  }

  /** The declined sidecar always sits beside the memory file it annotates. */
  function declinedPathFor(memoryPath) {
    return join(dirname(memoryPath), config.declinedFile);
  }

  /**
   * The memory file this plugin is actually working on, or `null` when no
   * analysis has run since the plugin loaded.
   *
   * Deliberately does not fall back to "some live session": as soon as a second
   * workspace is open that guess points at an unrelated project, and a diagnostic
   * route reporting the wrong file silently is worse than reporting none.
   */
  function knownMemoryPath() {
    return nextPendingBatch()?.path ?? lastMemoryPath ?? null;
  }

  /**
   * Memory file for one session id, falling back to whatever this process has
   * touched most recently. The sidebar tab is session-scoped, so it always passes
   * one; the fallback only serves callers that have no session (curl, diagnostics).
   */
  function memoryPathForSessionId(sessionId) {
    if (sessionId) {
      try {
        const session = ctx.sessions.get(sessionId);
        if (session) return memoryPathFor(session);
      } catch {
        /* unknown or disposed session */
      }
    }
    return knownMemoryPath();
  }

  function memoryPathFor(session) {
    let directory = '';
    try {
      directory = ctx.workingDirectory.get(session);
    } catch {
      directory = '';
    }
    if (!directory) {
      try {
        directory = ctx.workingDirectory.defaultDirectory;
      } catch {
        directory = process.cwd();
      }
    }
    return join(directory, config.file);
  }

  /** The enforcement threshold: this workspace's own setting, else the bundle's. */
  function effectiveMinConfidence(memoryPath) {
    if (!memoryPath) return config.minConfidence;
    const stored = readSettings(memoryPath);
    return typeof stored.minConfidence === 'number' ? stored.minConfidence : config.minConfidence;
  }

  /* --------------------------------------------------- system prompt side */

  function registerPromptContext(agent) {
    if (!config.injectPrompt) return;
    if (!agent || !agent.ctx || typeof agent.ctx.effect !== 'function') return;
    const agentId = String(agent.id);
    if (agentEffects.has(agentId)) return;
    const session = agent.session ?? ctx.sessions.get(agent.id);
    if (!session) return;
    try {
      const dispose = agent.ctx.effect(() =>
        agent.ctx.systemPrompt.context({
          name: 'dsh-memory-plugin',
          order: config.contextOrder,
          text: () => {
            // Re-resolve the directory every assembly: a session can change it.
            let path;
            try {
              path = memoryPathFor(session);
            } catch {
              return '';
            }
            const text = readLive(path).trim();
            if (!text) return '';
            const clipped = text.length > config.maxInjectChars ? `${text.slice(0, config.maxInjectChars)}\n…(truncated)` : text;
            return [
              'The workspace memory file (MEMORY.md) is reproduced below. Treat it as durable background context the user has already confirmed.',
              'It is not a task list: do not restate it, and follow anything in it that applies to the current request.',
              '',
              clipped,
            ].join('\n');
          },
        }),
      );
      agentEffects.set(agentId, typeof dispose === 'function' ? dispose : () => {});
    } catch (error) {
      log('warn', `could not register prompt context for ${agentId}: ${error?.message ?? error}`);
    }
  }

  ctx.on('agent/created', (payload) => {
    registerPromptContext(payload?.agent);
  });

  // Agents that already existed when the plugin loaded (install, reload, or an
  // HMR generation swap) never see `agent/created`, so adopt them here.
  try {
    const live = ctx.get('agents')?.list?.() ?? [];
    for (const agent of live) registerPromptContext(agent);
  } catch (error) {
    log('warn', `could not adopt existing agents: ${error?.message ?? error}`);
  }

  ctx.on('agent/disposed', (payload) => {
    const agentId = String(payload?.agent?.id ?? '');
    const dispose = agentEffects.get(agentId);
    if (!dispose) return;
    agentEffects.delete(agentId);
    try {
      dispose();
    } catch {
      /* already gone */
    }
  });

  /* ------------------------------------------------------- turn watching */

  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'turn/end') return;
    const reason = event.data?.reason?.kind;
    if (reason !== 'completed' && reason !== 'max-tokens') return;
    const header = session?.header;
    // Only the top-level, user-facing conversation — never a delegated child.
    if (!header || header.parentSession || header.origin === 'subagent') return;
    schedule(session, event.data.turn, typeof event.seq === 'number' ? event.seq : null);
  });

  function schedule(session, turn, seq) {
    const sessionId = String(session.id);
    let pipeline = pipelines.get(sessionId);
    if (!pipeline) {
      pipeline = { running: false, dirty: false, timer: null };
      pipelines.set(sessionId, pipeline);
    }
    pipeline.dirty = true;
    pipeline.lastTurn = turn;
    pipeline.lastSeq = seq ?? null;
    if (pipeline.running || pipeline.timer) return;
    pipeline.timer = later(() => {
      pipeline.timer = null;
      void drain(session, pipeline);
    }, config.debounceMs);
  }

  async function drain(session, pipeline) {
    if (pipeline.running) return;
    pipeline.running = true;
    try {
      while (pipeline.dirty) {
        pipeline.dirty = false;
        await analyse(session, pipeline.lastTurn, pipeline.lastSeq);
      }
    } catch (error) {
      log('error', `analysis failed: ${error?.message ?? error}`);
    } finally {
      pipeline.running = false;
    }
  }

  /* ---------------------------------------------------------- the model call */

  /**
   * Which model the analysis call should use.
   *
   * Order matters: a composer model switch is recorded in the session's request
   * header, not in the agent's creation options, so the durable request config
   * has to win. `agent.options` is only a fallback for a session that has not
   * issued a request yet.
   */
  function resolveRoute(session) {
    if (config.provider && config.model) {
      return { provider: config.provider, model: config.model, source: 'config' };
    }
    try {
      const frozen = session.requestHeader()?.config;
      if (frozen?.provider && frozen?.model) {
        return { provider: frozen.provider, model: frozen.model, source: 'session-request-header' };
      }
    } catch {
      /* no request recorded yet */
    }
    try {
      const context = session.requestContext();
      if (context?.provider && context?.model) {
        return { provider: context.provider, model: context.model, source: 'session-request-context' };
      }
    } catch {
      /* no request yet */
    }
    try {
      const agent = ctx.get('agents')?.get?.(session.id);
      const options = agent?.options;
      if (options?.provider && options?.model) {
        return { provider: options.provider, model: options.model, source: 'agent-options' };
      }
    } catch {
      /* no live agent */
    }
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
      if (selection?.provider && selection?.model) {
        return { provider: selection.provider, model: selection.model, source: 'default-model' };
      }
    } catch {
      /* not available */
    }
    return undefined;
  }

  /** Pull one turn's worth of text out of the model, strictly JSON on the wire. */
  async function askModel(session, turn, memoryText, declinedTexts, signal) {
    const route = resolveRoute(session);
    if (!route) {
      noteRun('no-route', { sessionTurn: turn });
      log('warn', 'no provider/model available, skipping analysis');
      return [];
    }
    let effort = config.reasoningEffort;
    try {
      const information = await ctx.llm.resolveModelInfo(route.provider, route.model, signal);
      const efforts = information?.reasoning?.efforts ?? [];
      if (efforts.length > 0 && effort && !efforts.some((entry) => String(entry.id) === effort)) {
        const fallback = information.reasoning.defaultEffort ?? efforts[efforts.length - 1]?.id;
        log('info', `${route.model} does not offer effort "${effort}", using "${fallback}"`);
        effort = fallback === undefined ? undefined : String(fallback);
      }
    } catch (error) {
      log('warn', `could not resolve ${route.provider}/${route.model}: ${error?.message ?? error}`);
    }

    const rawTranscript = transcriptForTurn(session, turn);
    if (!rawTranscript.trim()) {
      noteRun('no-transcript', { turn });
      return [];
    }
    const transcript = clampTail(rawTranscript, config.maxTranscriptChars);
    lastTranscript = {
      session: String(session.id),
      turn,
      chars: transcript.length,
      preview: transcript.replace(/\s+/g, ' ').trim().slice(0, 240),
    };
    noteRun('modelled', { turn, route, transcriptChars: transcript.length });
    const declinedBlock = declinedTexts.length === 0
      ? '(none)'
      : declinedTexts.slice(-config.maxDeclinedPrompt).map((text) => '- ' + text).join('\n');
    const user = ANALYSIS_USER
      .replace('{memory}', clampTail(memoryText, 4000))
      .replace('{declined}', clampTail(declinedBlock, 4000))
      .replace('{transcript}', transcript);

    const collected = [];
    const request = {
      provider: route.provider,
      model: route.model,
      system: analysisSystemPrompt(config.maxItems),
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      maxTokens: 3000,
      temperature: 0,
      signal,
    };
    if (effort) request.reasoningEffort = effort;

    for await (const chunk of ctx.llm.stream(request)) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') collected.push(chunk.text);
      else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
        throw new Error(chunk.reason.failure?.message ?? 'model call failed');
      } else if (chunk.type === 'finish' && chunk.reason?.kind === 'aborted') {
        return [];
      }
    }

    const parsed = extractJson(collected.join(''));
    const list = Array.isArray(parsed?.memories) ? parsed.memories : [];
    // The gate is code, not just instructions: `confidence` and `kind` are the
    // extractor's own claims, and a low-confidence or off-taxonomy item is
    // dropped here rather than shown to the user and declined by hand.
    // The sidebar's slider, when the user touched it, overrides the bundle.
    return selectCandidates(list, {
      maxItems: config.maxItems,
      minConfidence: effectiveMinConfidence(memoryPathFor(session)),
      maxItemChars: config.maxItemChars,
    });
  }

  /* ------------------------------------------------------------ one analysis */

  async function analyse(session, turn, seq) {
    const path = memoryPathFor(session);
    lastMemoryPath = path;
    const memoryText = readLive(path);
    const declinedTexts = readDeclined(declinedPathFor(path));
    const controller = new AbortController();
    inflight.add(controller);
    noteRun('start', { session: String(session.id), turn, path });
    // Drives the "extracting memory" note in the conversation UI.
    analysing.set(String(session.id), (analysing.get(String(session.id)) ?? 0) + 1);
    let items;
    try {
      items = await askModel(session, turn, memoryText, declinedTexts, controller.signal);
    } catch (error) {
      noteRun('error', { session: String(session.id), turn, error: error?.message ?? String(error) });
      throw error;
    } finally {
      inflight.delete(controller);
      const remaining = (analysing.get(String(session.id)) ?? 1) - 1;
      if (remaining > 0) analysing.set(String(session.id), remaining);
      else analysing.delete(String(session.id));
    }
    if (!Array.isArray(items) || items.length === 0) {
      noteRun('empty', { session: String(session.id), turn, modelItems: 0 });
      return;
    }

    // Second gate: the model's own judgement is not trusted to honour the
    // declined list, so anything that restates memory or a refusal is dropped
    // here as well.
    const memoryLines = memoryText.split(/\r?\n/);
    const fresh = items.filter((text) => !restates(text, memoryLines) && !restates(text, declinedTexts));
    if (fresh.length === 0) {
      noteRun('filtered-out', { session: String(session.id), turn, modelItems: items.length });
      return;
    }

    const batch = currentBatch(session);
    for (const text of fresh) {
      if (batch.items.some((item) => restates(text, [item.text]))) continue;
      batch.items.push({ id: `m${(batch.nextId += 1)}`, text });
    }
    batch.changedAt = Date.now();
    // Anchor the card to the reply that produced the newest candidates: the
    // turn number for humans, the closing sequence for the renderer.
    batch.turn = turn;
    batch.seq = typeof seq === 'number' ? seq : null;
    noteRun('batch', { session: String(session.id), turn, modelItems: items.length, fresh: fresh.length, queued: batch.items.length });
  }

  /* -------------------------------------------------- confirmation handshake */

  /**
   * One batch per session. The confirmation card is rendered inline by the
   * conversation view of the session that owns it — anchored to the turn whose
   * reply produced the candidates — so a batch never surfaces in another
   * session's window. Each batch carries the `file` it will write and the
   * `turn` it belongs to.
   */
  function currentBatch(session) {
    const sessionId = String(session.id);
    const existing = pendingBatches.get(sessionId);
    if (existing) return existing;
    const batch = {
      id: `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      path: memoryPathFor(session),
      turn: null,
      seq: null,
      createdAt: Date.now(),
      changedAt: 0,
      nextId: 0,
      items: [],
      timer: null,
    };
    pendingBatches.set(sessionId, batch);
    batch.timer = later(() => {
      batch.timer = null;
      if (pendingBatches.get(sessionId) !== batch) return;
      pendingBatches.delete(sessionId);
      log('info', `no confirmation arrived for ${batch.path}, discarding the candidates`);
    }, config.confirmTimeoutMs);
    return batch;
  }

  function retireBatch(batch) {
    if (batch.timer) {
      clearTimeout(batch.timer);
      timers.delete(batch.timer);
      batch.timer = null;
    }
    if (pendingBatches.get(batch.sessionId) === batch) pendingBatches.delete(batch.sessionId);
  }

  /** Oldest batch first, so a queue drains in the order it arrived. */
  function nextPendingBatch() {
    for (const batch of pendingBatches.values()) return batch;
    return null;
  }

  /** Write the accepted items, then retire the batch. */
  function settleBatch(batch, acceptedIds) {
    const accepted = new Set((Array.isArray(acceptedIds) ? acceptedIds : []).map(String));
    const lines = batch.items.filter((item) => accepted.has(item.id)).map((item) => item.text);
    const rejected = batch.items.filter((item) => !accepted.has(item.id)).map((item) => item.text);
    let written = 0;
    let failure;
    if (lines.length > 0) {
      try {
        const outcome = appendMemories(batch.path, lines);
        written = outcome.written;
        log('info', `wrote ${written} item(s) to ${batch.path}`);
      } catch (error) {
        failure = error?.message ?? String(error);
        log('error', `could not write ${batch.path}: ${failure}`);
      }
    }
    // Whatever the user left unticked is a decision, not a delay: record it so a
    // later turn cannot offer the same thing again.
    if (rejected.length > 0) {
      try {
        const recorded = appendDeclined(declinedPathFor(batch.path), rejected);
        if (recorded > 0) log('info', `recorded ${recorded} declined item(s)`);
      } catch (error) {
        log('warn', `could not record declined items: ${error?.message ?? error}`);
      }
    }
    retireBatch(batch);
    return { written, file: batch.path, error: failure, declined: rejected.length };
  }

  /* --------------------------------------------------------- public routes */

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/dsh-memory-plugin',
      handler: async (req, res) => {
        if (!sameOrigin(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden' });
          return;
        }
        let requestUrl;
        try {
          requestUrl = new URL(req.url ?? '/', 'http://dsh.internal');
        } catch {
          requestUrl = new URL('/', 'http://dsh.internal');
        }
        const method = requestUrl.pathname.slice('/dsh-memory-plugin'.length).replace(/\/+$/, '') || '/';

        if (method === '/scan' && req.method === 'POST') {
          // Manual trigger: re-analyses the last closed turn of a session. Useful
          // when a batch expired unconfirmed (no page open) and for verifying the
          // pipeline without waiting for another turn.
          let body;
          try {
            body = await readJsonBody(req);
          } catch (error) {
            writeJson(res, 400, { ok: false, error: `bad body: ${error?.message ?? error}` });
            return;
          }
          const sessionId = String(body?.session ?? '');
          const live = sessionId ? ctx.sessions.get(sessionId) : undefined;
          if (!live) {
            writeJson(res, 404, { ok: false, error: 'no live session with that id' });
            return;
          }
          // `turn` is optional and exists for tuning the extraction prompt:
          // re-running an older turn is the only way to A/B a prompt change
          // without waiting for a conversation to produce a matching turn.
          const wantedTurn = Number.isInteger(body?.turn) && body.turn > 0 ? body.turn : null;
          const location = wantedTurn === null ? lastClosedTurn(live) : closedTurnAt(live, wantedTurn);
          if (location === null) {
            writeJson(res, 409, {
              ok: false,
              error: wantedTurn === null
                ? 'that session has no completed turn yet'
                : `turn ${wantedTurn} is not closed in that session`,
            });
            return;
          }
          schedule(live, location.turn, location.seq);
          writeJson(res, 202, { ok: true, session: sessionId, turn: location.turn, seq: location.seq });
          return;
        }

        if (method === '/memories' && req.method === 'GET') {
          const sessionId = requestUrl.searchParams.get('session') ?? '';
          const path = memoryPathForSessionId(sessionId);
          if (path === null) {
            writeJson(res, 200, { ok: false, path: null, entries: [], declined: 0, analysing: false, error: 'no memory file known yet' });
            return;
          }
          const entries = readEntries(path);
          const stored = readSettings(path);
          const liveSession = (() => {
            try {
              return sessionId ? ctx.sessions.get(sessionId) : undefined;
            } catch {
              return undefined;
            }
          })();
          writeJson(res, 200, {
            ok: true,
            path,
            entries,
            declined: readDeclined(declinedPathFor(path)).length,
            // An open turn hides the pill. The extraction being announced
            // belongs to the turn that already closed, and an LLM call easily
            // outlives the gap between turns — so without this the pill shows up
            // while the user is watching the *next* turn work, which reads as a
            // trigger that fired before the answer had even finished.
            analysing: (analysing.get(sessionId) ?? 0) > 0 && !turnIsOpen(liveSession),
            settings: {
              minConfidence: effectiveMinConfidence(path),
              minConfidenceDefault: config.minConfidence,
              minConfidenceOverridden: typeof stored.minConfidence === 'number',
            },
            route: (() => {
              try {
                return liveSession ? resolveRoute(liveSession) ?? null : null;
              } catch {
                return null;
              }
            })(),
            lastRun: lastRun && lastRun.session === sessionId ? lastRun : null,
          });
          return;
        }

        if (method === '/settings' && req.method === 'POST') {
          let body;
          try {
            body = await readJsonBody(req);
          } catch (error) {
            writeJson(res, 400, { ok: false, error: `bad body: ${error?.message ?? error}` });
            return;
          }
          const sessionId = String(body?.session ?? '');
          const path = memoryPathForSessionId(sessionId);
          if (path === null) {
            writeJson(res, 409, { ok: false, error: 'no memory file known yet' });
            return;
          }
          const raw = body?.minConfidence;
          if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
            writeJson(res, 400, { ok: false, error: 'minConfidence must be a number between 0 and 1' });
            return;
          }
          const rounded = Math.round(raw * 100) / 100;
          // Setting the value back to the bundle default removes the override
          // instead of pinning it: "reset" has to mean "follow the bundle again",
          // or a later default change would never reach this workspace.
          const isDefault = Math.abs(rounded - config.minConfidence) < 1e-9;
          try {
            if (isDefault) {
              rmSync(settingsPathFor(path), { force: true });
            } else {
              writeSettings(path, { minConfidence: rounded });
            }
            log('info', `minConfidence for ${path} set to ${rounded}${isDefault ? ' (default, override removed)' : ''}`);
            writeJson(res, 200, {
              ok: true,
              path,
              settings: {
                minConfidence: rounded,
                minConfidenceDefault: config.minConfidence,
                minConfidenceOverridden: !isDefault,
              },
            });
          } catch (error) {
            writeJson(res, 500, { ok: false, error: error?.message ?? String(error) });
          }
          return;
        }

        if (method === '/memories' && req.method === 'POST') {
          let body;
          try {
            body = await readJsonBody(req);
          } catch (error) {
            writeJson(res, 400, { ok: false, error: `bad body: ${error?.message ?? error}` });
            return;
          }
          const sessionId = String(body?.session ?? '');
          const path = memoryPathForSessionId(sessionId);
          if (path === null) {
            writeJson(res, 409, { ok: false, error: 'no memory file known yet' });
            return;
          }
          try {
            const result = mutateEntries(path, String(body?.action ?? ''), body);
            lastMemoryPath = path;
            writeJson(res, 200, { ok: true, changed: result.changed, reason: result.reason, path, entries: result.entries });
          } catch (error) {
            writeJson(res, 400, { ok: false, error: error?.message ?? String(error) });
          }
          return;
        }

        if (method === '/pending' && req.method === 'GET') {
          // `?session=` scopes the answer to one conversation: the card belongs
          // to the turn that produced it, and must never appear in a window
          // showing a different session. Without it, the oldest batch overall
          // is returned, which keeps hand-written probes simple.
          const wantedSession = requestUrl.searchParams.get('session');
          const batch = wantedSession ? pendingBatches.get(wantedSession) ?? null : nextPendingBatch();
          writeJson(res, 200, {
            pending: batch
              ? {
                  id: batch.id,
                  sessionId: batch.sessionId,
                  file: batch.path,
                  turn: batch.turn,
                  seq: batch.seq,
                  createdAt: batch.createdAt,
                  changedAt: batch.changedAt,
                  items: batch.items.map((item) => ({ id: item.id, text: item.text })),
                }
              : null,
            queued: pendingBatches.size,
          });
          return;
        }

        if (method === '/decide' && req.method === 'POST') {
          let body;
          try {
            body = await readJsonBody(req);
          } catch (error) {
            writeJson(res, 400, { ok: false, error: `bad body: ${error?.message ?? error}` });
            return;
          }
          // Look the batch up by id across every session's queue: the dialog is
          // frame-wide, so the id — not whatever happens to be head of the queue
          // by the time the answer lands — must decide which file is written.
          const wanted = String(body?.id ?? '');
          let batch = null;
          for (const candidate of pendingBatches.values()) {
            if (candidate.id === wanted) {
              batch = candidate;
              break;
            }
          }
          if (!batch) {
            writeJson(res, 409, { ok: false, error: 'no matching pending memory batch' });
            return;
          }
          const acceptedIds = Array.isArray(body?.accepted) ? body.accepted : [];
          const result = settleBatch(batch, acceptedIds);
          writeJson(res, 200, { ok: true, written: result.written, declined: result.declined, file: result.file });
          return;
        }

        if (method === '/declined' && req.method === 'GET') {
          // Read-only view of the sidecar, so "why does this never come back?" has
          // an answer that does not require opening a dotfile. `path` is echoed
          // because the file lives beside the memory file, and a wrong working
          // directory would otherwise be invisible from the UI.
          const requested = new URL(req.url ?? '/', 'http://dsh.internal').searchParams.get('cwd');
          const known = knownMemoryPath();
          const path = requested ? declinedPathFor(join(requested, config.file)) : known === null ? null : declinedPathFor(known);
          if (path === null) {
            writeJson(res, 200, {
              ok: true,
              path: null,
              count: 0,
              items: [],
              hint: 'no analysis has run since the plugin loaded; pass ?cwd=<workspace directory> to read a specific workspace',
            });
            return;
          }
          const items = readDeclined(path);
          writeJson(res, 200, { ok: true, path, count: items.length, items });
          return;
        }

        if (method === '/status' && req.method === 'GET') {
          const known = knownMemoryPath();
          const declinedPath = known === null ? null : declinedPathFor(known);
          let declinedCount = 0;
          try {
            declinedCount = declinedPath === null ? 0 : readDeclined(declinedPath).length;
          } catch {
            declinedCount = 0;
          }
          writeJson(res, 200, {
            ok: true,
            build: PLUGIN_BUILD,
            file: config.file,
            memoryPath: known,
            declinedPath,
            declinedFile: config.declinedFile,
            declinedItems: declinedCount,
            injectPrompt: config.injectPrompt,
            analysisRoute: {
              provider: config.provider || '(follow conversation)',
              model: config.model || '(follow conversation)',
              reasoningEffort: config.reasoningEffort,
            },
            agentsWithPromptContext: agentEffects.size,
            liveSessions: (() => {
              try {
                return ctx.sessions.list().map((session) => String(session.id));
              } catch {
                return [];
              }
            })(),
            pendingBatches: pendingBatches.size,
            // Which sessions are mid-turn right now, so "the pill is hidden"
            // has an explanation instead of looking broken.
            turnsOpen: (() => {
              try {
                return ctx.sessions.list()
                  .filter((session) => turnIsOpen(session))
                  .map((session) => String(session.id));
              } catch {
                return [];
              }
            })(),
            lastRun,
            lastTranscript,
            triggers: 'turn/end with reason completed|max-tokens, top-level sessions only',
          });
          return;
        }

        writeJson(res, 404, { ok: false, error: 'not found' });
      },
    }),
  );
}
