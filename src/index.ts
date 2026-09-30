#!/usr/bin/env node
/**
 * DevMedic executable entry point. All logic lives in cli.ts so it can be imported and tested
 * without side effects.
 */
import { main } from './cli.js';

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 2;
  },
);
