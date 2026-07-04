const fs = require('fs');
const f = 'src/modules/agent/agents/chat99.agent.js';
let s = fs.readFileSync(f, 'utf8');
const anchor = "const buf = Buffer.from(b64, 'base64');";
if (s.includes('CHAT99_DEBUG_SEED')) {
  console.log('ja tem debug');
} else if (s.includes(anchor)) {
  const add = anchor + "\n    if (process.env.CHAT99_DEBUG_SEED) { log('[dbg] b64Len=' + b64.length + ' head=' + b64.slice(0,12) + ' bufHead=' + buf.slice(0,4).toString('hex') + ' temParte2=' + (!!process.env.CHAT99_STORAGE_STATE_B64_2)); }";
  s = s.replace(anchor, add);
  fs.writeFileSync(f, s, 'utf8');
  console.log('debug add OK');
} else {
  console.log('anchor nao encontrado');
}
