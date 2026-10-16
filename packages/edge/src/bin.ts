#!/usr/bin/env node
/**
 * Entry point of the vexplor-edge command — the npm bin and the single executable both start here.
 * Kept apart from cli.ts so importing the commands (tests, a bundle) never starts the program.
 */
import { main } from './cli.js';

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: Error) => {
    process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level: 'error', message: error.message })}\n`);
    process.exit(1);
  },
);
