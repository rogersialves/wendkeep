#!/usr/bin/env node
// Commands, including optional `bridge` adapters, are dispatched by the canonical CLI package.
import { runCli } from '../packages/cli/src/index.mjs';

await runCli();
