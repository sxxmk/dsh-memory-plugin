// Offline checks for the declined-memory suppression logic.
// Run from the repo root:  node test/declinement-check.mjs
import { __internals } from '../index.js';

const { restates, similarity, selectCandidates, transcriptForTurn } = __internals;

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${actual}, want ${expected})`);
}

const declined = ['用户使用中文与助手交流，助手回复也应使用中文。'];

// --- must be suppressed: the same line coming back, verbatim or shortened ---
check('identical line', restates('用户使用中文与助手交流，助手回复也应使用中文。', declined), true);
check(
  'same line, reworded but still word-for-word overlapping',
  restates('用户用中文交流，助手也应该用中文回答。', declined),
  true,
);
check('declined line reproduced as a prefix', restates('用户使用中文与助手交流', declined), true);

// --- must survive: different facts that merely share vocabulary ---
check(
  'unrelated fact in the same language',
  restates('该插件把确认后的条目写入 MEMORY.md 的 Remembered facts 小节。', declined),
  false,
);
const declinedEn = ['The user writes in Chinese and expects Chinese replies.'];
check(
  'unrelated fact in English',
  restates('The plugin writes confirmed items into MEMORY.md.', declinedEn),
  false,
);

// --- paraphrase is the model's job, not the lexical net's ---
// These two are semantically the same fact but share too little surface form;
// they are suppressed by the DECLINED block in the prompt, not by `restates`.
check(
  'heavy paraphrase is left to the prompt',
  restates('用户偏好中文对话，助手应当以中文回复。', declined),
  false,
);
check(
  'english paraphrase is left to the prompt',
  restates('The user communicates in Chinese, so answers should be in Chinese.', declinedEn),
  false,
);

// --- sanity ---
const a = '用户使用中文与助手交流';
const b = '助手应当以中文回复';
check('similarity symmetric', similarity(a, b) === similarity(b, a), true);
check('similarity identity', similarity(a, a) === 1, true);
check('empty candidate never matches', restates('', []), true);

// --- confidence gate: the extractor's own claim decides what reaches the user ---
function count(label, items, options, expected) {
  const got = selectCandidates(items, options).length;
  const ok = got === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${got}, want ${expected})`);
}

count('below threshold is dropped', [
  { kind: 'convention', confidence: 0.4, text: '测试命令是 pnpm test' },
], { minConfidence: 0.7 }, 0);
count('at threshold is kept', [
  { kind: 'convention', confidence: 0.7, text: '测试命令是 pnpm test' },
], { minConfidence: 0.7 }, 1);
count('off-taxonomy kind is dropped', [
  { kind: 'knowledge', confidence: 0.95, text: '该环境支持 color-mix()' },
], { minConfidence: 0.7 }, 0);
count('missing kind but confident is kept', [
  { confidence: 0.9, text: '用户偏好中文回复' },
], { minConfidence: 0.7 }, 1);
count('legacy shape without confidence is not gated', [
  { text: '用户偏好中文回复' },
], { minConfidence: 0.7 }, 1);
count('cap is enforced', [
  { kind: 'preference', confidence: 0.9, text: '用户偏好中文回复' },
  { kind: 'convention', confidence: 0.9, text: '测试命令是 pnpm test' },
  { kind: 'decision', confidence: 0.9, text: '因为部署顺序，迁移必须手工执行' },
  { kind: 'correction', confidence: 0.9, text: '不要在回复里用表情符号' },
], { minConfidence: 0.7, maxItems: 2 }, 2);
count('duplicates collapse', [
  { kind: 'preference', confidence: 0.9, text: '用户偏好中文回复。' },
  { kind: 'preference', confidence: 0.9, text: '用户偏好中文回复。' },
], { minConfidence: 0.7 }, 1);
count('whitespace collapses before comparing', [
  { kind: 'preference', confidence: 0.9, text: '用户偏好\n  中文回复' },
  { kind: 'preference', confidence: 0.9, text: '用户偏好 中文回复' },
], { minConfidence: 0.7 }, 1);

// --- transcript scope: one turn, never the whole conversation ---
const userMsg = (text) => ({ content: [{ type: 'text', text }] });
const assistantMsg = (text) => ({ message: { content: [{ type: 'text', text }] } });
const turnOne = [
  { type: 'turn/start', seq: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, data: userMsg('OLD-QUESTION') },
  { type: 'assistant/message', seq: 3, data: assistantMsg('OLD-ANSWER') },
  { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
];
const turnTwo = [
  { type: 'turn/start', seq: 5, data: { turn: 2 } },
  { type: 'user/message', seq: 6, data: userMsg('NEW-QUESTION') },
  { type: 'assistant/message', seq: 7, data: assistantMsg('NEW-ANSWER') },
  { type: 'turn/end', seq: 8, data: { turn: 2, reason: { kind: 'completed' } } },
];
const both = [...turnOne, ...turnTwo];
const sessionOf = (events) => ({ ownEvents: () => events });

const twoText = transcriptForTurn(sessionOf(both), 2);
check('turn 2 keeps its own exchange', twoText.includes('NEW-QUESTION') && twoText.includes('NEW-ANSWER'), true);
check('turn 2 drops turn 1', twoText.includes('OLD-QUESTION') || twoText.includes('OLD-ANSWER'), false);

const oneText = transcriptForTurn(sessionOf(both), 1);
check('turn 1 keeps its own exchange', oneText.includes('OLD-QUESTION'), true);
check('turn 1 does not reach forward', oneText.includes('NEW-QUESTION'), false);

// A compaction can replace the span holding this turn's start marker. The reply
// must still be bounded: falling back to the session top would analyse every
// earlier turn under the guise of reviewing this one.
const missingStart = [turnOne[0], ...turnOne.slice(1, 3), turnOne[3], ...turnTwo.slice(1)];
const noStartText = transcriptForTurn(sessionOf(missingStart), 2);
check('missing turn/start still excludes earlier turns', noStartText.includes('OLD-QUESTION'), false);
check('missing turn/start keeps the current turn', noStartText.includes('NEW-QUESTION'), true);

// A compaction checkpoint is derived text, not something the user said.
const withCheckpoint = [
  ...turnTwo.slice(0, 2),
  { type: 'user/message', seq: 65, data: userMsg('SUMMARY-OF-EVERYTHING'), surfaceOp: { op: 'replace' } },
  ...turnTwo.slice(2),
];
check('compaction checkpoint is skipped', transcriptForTurn(sessionOf(withCheckpoint), 2).includes('SUMMARY-OF-EVERYTHING'), false);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
