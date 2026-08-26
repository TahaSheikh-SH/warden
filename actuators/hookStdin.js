'use strict';

// Shared by the spawned-hook adapters (native.js, codex/actuator.js) that
// receive the hook payload as JSON on stdin. In-process harnesses
// (opencode/pi) get their input as a function argument and don't need this.

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

module.exports = { readStdin };
