#!/usr/bin/env node
// Copyright 2026 vs3-neo Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { S3Server } from '../src/server.js';
import { loadConfig } from '../src/config.js';

function main() {
  const config = loadConfig(process.argv);
  const server = new S3Server(config);
  server
    .init()
    .then(() => {
      const { host, port } = config.server;
      server.listen(port, host);
      console.log(`vs3-neo v1.0.0 listening on http://${host}:${port}`);
      console.log(`  storage backend : ${server.storage.name}`);
      console.log(`  data dir        : ${config.storage.disk ? config.storage.disk.dataDir : '(memory)'}`);
      console.log(`  anonymous       : ${config.auth.anonymous}`);
      console.log(`  functions       : ${config.functions.enabled ? 'enabled' : 'disabled'}`);
      if (config.configPath) console.log(`  config file     : ${config.configPath}`);
      console.log('');
      console.log('  internal endpoints:');
      console.log('    GET  /__health    health check');
      console.log('    GET  /__info      service info');
      console.log('    GET  /__metrics   prometheus-style metrics');
      console.log('    POST /__presign   mint a presigned URL (requires auth)');
      console.log('    POST /__lifecycle run lifecycle rules now');
      console.log('    POST /__function/:name   invoke a user-defined function');
      console.log('    GET  /__functions        list registered functions');
      console.log('');
    })
    .catch((err) => {
      console.error('failed to start vs3-neo:', err.message);
      process.exit(1);
    });
}

main();
