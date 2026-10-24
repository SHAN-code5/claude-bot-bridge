#!/usr/bin/env node
'use strict';

const { main } = require('../src/index.js');

main().catch((err) => {
  const message = err && err.message ? err.message : String(err);
  console.error(`claude-bot-bridge: ${message}`);
  process.exitCode = 1;
});
