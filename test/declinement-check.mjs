// Offline checks for the declined-memory suppression logic.
// Run from the repo root:  node test/declinement-check.mjs
import { __internals } from '../index.js';

const { restates, similarity } = __internals;

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

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
