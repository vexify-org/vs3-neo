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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Default configuration.
export const DEFAULT_CONFIG = {
  server: {
    host: '0.0.0.0',
    port: 9000,
    // region used for SigV4 scope
    region: 'us-east-1',
  },
  storage: {
    // one of: disk | memory | custom-mirror (or any registered backend)
    backend: 'disk',
    disk: {
      dataDir: path.join(__dirname, '..', 'data'),
    },
  },
  auth: {
    // when true, unsigned requests are allowed
    anonymous: false,
    users: [{ accessKey: 'minioadmin', secretKey: 'minioadmin' }],
  },
  encryption: {
    // optional SSE-S3 master key; when empty a key is generated
    // (memory: ephemeral, disk: persisted at <dataDir>/sse-master.key)
    key: '',
  },
  versioning: {
    // default versioning state applied to newly created buckets
    default: false,
  },
  functions: {
    enabled: true,
    // hooks map S3 operation names to comma-separated function names
    hooks: {
      onPut: 'log',
      onGet: 'log',
      onDelete: 'log',
    },
  },
  metrics: {
    enabled: true,
  },
};

function deepMerge(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Apply VS3_* environment overrides (e.g. VS3_SERVER_PORT, VS3_AUTH_ANONYMOUS).
function applyEnv(cfg) {
  const env = process.env;
  const num = (v) => {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? undefined : n;
  };
  const bool = (v) => v === 'true' || v === '1';
  if (env.VS3_SERVER_HOST) cfg.server.host = env.VS3_SERVER_HOST;
  if (env.VS3_SERVER_PORT) {
    const n = num(env.VS3_SERVER_PORT);
    if (n !== undefined) cfg.server.port = n;
  }
  if (env.VS3_SERVER_REGION) cfg.server.region = env.VS3_SERVER_REGION;
  if (env.VS3_STORAGE_BACKEND) cfg.storage.backend = env.VS3_STORAGE_BACKEND;
  if (env.VS3_STORAGE_DISK_DATA_DIR) cfg.storage.disk.dataDir = env.VS3_STORAGE_DISK_DATA_DIR;
  if (env.VS3_AUTH_ANONYMOUS !== undefined) cfg.auth.anonymous = bool(env.VS3_AUTH_ANONYMOUS);
  if (env.VS3_AUTH_ACCESS_KEY) {
    cfg.auth.users = [
      {
        accessKey: env.VS3_AUTH_ACCESS_KEY,
        secretKey: env.VS3_AUTH_SECRET_KEY || 'change-me',
      },
    ];
  }
  if (env.VS3_ENCRYPTION_KEY) cfg.encryption.key = env.VS3_ENCRYPTION_KEY;
  return cfg;
}

// loadConfig reads config from --config <path>, VS3_CONFIG, or default.
export function loadConfig(argv = process.argv) {
  let cfgPath;
  const idx = argv.indexOf('--config');
  if (idx >= 0 && argv[idx + 1]) cfgPath = argv[idx + 1];
  if (!cfgPath && process.env.VS3_CONFIG) cfgPath = process.env.VS3_CONFIG;
  if (!cfgPath) {
    const local = path.join(process.cwd(), 'vs3-neo.json');
    if (fs.existsSync(local)) cfgPath = local;
  }

  let fileCfg = {};
  if (cfgPath) {
    if (!fs.existsSync(cfgPath)) {
      throw new Error(`config file not found: ${cfgPath}`);
    }
    fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  }
  const cfg = applyEnv(deepMerge(DEFAULT_CONFIG, fileCfg));
  cfg.configPath = cfgPath;
  return cfg;
}
