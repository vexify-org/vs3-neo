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

// A tiny S3-compatible client used by tests, examples and CLI tooling.
// Signing is done with SigV4 (header-based). Works against vs3-neo and any
// other S3-compatible endpoint.

import { signRequest } from './auth/sigv4.js';

export class S3Client {
  constructor({ endpoint = 'http://127.0.0.1:9000', accessKey, secretKey, region = 'us-east-1' } = {}) {
    this.endpoint = endpoint.replace(/\/$/, '');
    this.accessKey = accessKey;
    this.secretKey = secretKey;
    this.region = region;
  }

  // Low-level signed request.
  async request(method, path, { query = {}, headers = {}, body } = {}) {
    const url = new URL(this.endpoint + path);
    for (const [k, v] of Object.entries(query)) {
      // S3 subresources use empty values (e.g. ?location, ?versioning, ?uploads);
      // only skip genuinely absent parameters.
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
    // Build a request with a consistent host header.
    const u = url.toString();
    const parsed = new URL(u);
    const host = parsed.host;

    const finalHeaders = { ...headers, host };
    const bodyBuffer = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const signed = signRequest({
      method,
      host,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams.entries()),
      headers: Object.fromEntries(
        Object.entries(finalHeaders).filter(([k]) => k.toLowerCase() !== 'host'),
      ),
      bodyHash: bodyBuffer ? cryptoHash(bodyBuffer) : undefined,
      accessKey: this.accessKey,
      secretKey: this.secretKey,
      region: this.region,
    });

    const reqHeaders = { ...finalHeaders, ...signed };
    delete reqHeaders.host;
    // Note: do NOT set Content-Length manually — undici computes it from the
    // Buffer body, and a manually-set header collides with the auto one when
    // running under a custom global dispatcher (e.g. a proxy preload).

    const res = await fetch(u, {
      method,
      headers: reqHeaders,
      body: bodyBuffer,
      redirect: 'manual',
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, ok: res.ok };
  }

  // ---- convenience operations ----
  async createBucket(name) {
    return this.request('PUT', `/${name}`);
  }
  async listBuckets() {
    return this.request('GET', '/');
  }
  async headBucket(name) {
    return this.request('HEAD', `/${name}`);
  }
  async deleteBucket(name) {
    return this.request('DELETE', `/${name}`);
  }
  async putObject(bucket, key, body, headers = {}) {
    return this.request('PUT', `/${bucket}/${key}`, { headers, body });
  }
  async getObject(bucket, key, query = {}) {
    return this.request('GET', `/${bucket}/${key}`, { query });
  }
  async headObject(bucket, key, query = {}) {
    return this.request('HEAD', `/${bucket}/${key}`, { query });
  }
  async deleteObject(bucket, key, query = {}) {
    return this.request('DELETE', `/${bucket}/${key}`, { query });
  }
  async listObjects(bucket, query = {}) {
    return this.request('GET', `/${bucket}`, { query });
  }
  async listObjectsV2(bucket, query = {}) {
    return this.request('GET', `/${bucket}`, { query: { 'list-type': '2', ...query } });
  }
  async setVersioning(bucket, status) {
    const body = `<?xml version="1.0" encoding="UTF-8"?><VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${status}</Status></VersioningConfiguration>`;
    return this.request('PUT', `/${bucket}`, { query: { versioning: '' }, headers: { 'Content-Type': 'application/xml' }, body });
  }
  async getVersioning(bucket) {
    return this.request('GET', `/${bucket}`, { query: { versioning: '' } });
  }

  // ---- tagging ----
  async getObjectTagging(bucket, key, query = {}) {
    return this.request('GET', `/${bucket}/${key}`, { query: { tagging: '', ...query } });
  }
  async putObjectTagging(bucket, key, tags, query = {}) {
    return this.request('PUT', `/${bucket}/${key}`, {
      query: { tagging: '', ...query },
      headers: { 'Content-Type': 'application/xml' },
      body: tagsToXml(tags),
    });
  }
  async deleteObjectTagging(bucket, key, query = {}) {
    return this.request('DELETE', `/${bucket}/${key}`, { query: { tagging: '', ...query } });
  }
  async getBucketTagging(bucket) {
    return this.request('GET', `/${bucket}`, { query: { tagging: '' } });
  }
  async putBucketTagging(bucket, tags) {
    return this.request('PUT', `/${bucket}`, {
      query: { tagging: '' },
      headers: { 'Content-Type': 'application/xml' },
      body: tagsToXml(tags),
    });
  }
  async deleteBucketTagging(bucket) {
    return this.request('DELETE', `/${bucket}`, { query: { tagging: '' } });
  }

  // ---- policy ----
  async getBucketPolicy(bucket) {
    return this.request('GET', `/${bucket}`, { query: { policy: '' } });
  }
  async putBucketPolicy(bucket, policy) {
    return this.request('PUT', `/${bucket}`, {
      query: { policy: '' },
      headers: { 'Content-Type': 'application/json' },
      body: typeof policy === 'string' ? policy : JSON.stringify(policy),
    });
  }
  async deleteBucketPolicy(bucket) {
    return this.request('DELETE', `/${bucket}`, { query: { policy: '' } });
  }

  // ---- lifecycle ----
  async getBucketLifecycle(bucket) {
    return this.request('GET', `/${bucket}`, { query: { lifecycle: '' } });
  }
  async putBucketLifecycle(bucket, rules) {
    return this.request('PUT', `/${bucket}`, {
      query: { lifecycle: '' },
      headers: { 'Content-Type': 'application/xml' },
      body: rulesToXml(rules),
    });
  }
  async deleteBucketLifecycle(bucket) {
    return this.request('DELETE', `/${bucket}`, { query: { lifecycle: '' } });
  }

  // ---- cors ----
  async getBucketCors(bucket) {
    return this.request('GET', `/${bucket}`, { query: { cors: '' } });
  }
  async putBucketCors(bucket, rules) {
    return this.request('PUT', `/${bucket}`, {
      query: { cors: '' },
      headers: { 'Content-Type': 'application/xml' },
      body: corsToXml(rules),
    });
  }
  async deleteBucketCors(bucket) {
    return this.request('DELETE', `/${bucket}`, { query: { cors: '' } });
  }
  // Preflight is unauthenticated; use a plain fetch rather than request().
  async preflightCors(bucket, { origin, method, headers = [] } = {}) {
    const h = {
      Origin: origin,
      'Access-Control-Request-Method': method,
    };
    if (headers.length) h['Access-Control-Request-Headers'] = headers.join(', ');
    const res = await fetch(`${this.endpoint}/${bucket}`, { method: 'OPTIONS', headers: h });
    const text = await res.text();
    return { status: res.status, ok: res.ok, headers: res.headers, text };
  }
}

function tagsToXml(tags) {
  const inner = (tags || [])
    .map((t) => `<Tag><Key>${t.Key}</Key><Value>${t.Value}</Value></Tag>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet>${inner}</TagSet></Tagging>`;
}

function rulesToXml(rules) {
  const inner = (rules || [])
    .map((r) => {
      const id = r.id ? `<ID>${r.id}</ID>` : '';
      const filter = r.prefix ? `<Filter><Prefix>${r.prefix}</Prefix></Filter>` : '';
      const status = `<Status>${r.status || 'Enabled'}</Status>`;
      const exp =
        r.expiration && r.expiration.days !== undefined
          ? `<Expiration><Days>${r.expiration.days}</Days></Expiration>`
          : '';
      const abort =
        r.abort && r.abort.days !== undefined
          ? `<AbortIncompleteMultipartUpload><DaysAfterInitiation>${r.abort.days}</DaysAfterInitiation></AbortIncompleteMultipartUpload>`
          : '';
      return `<Rule>${id}${filter}${status}${exp}${abort}</Rule>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${inner}</LifecycleConfiguration>`;
}

function corsToXml(rules) {
  const inner = (rules || [])
    .map((r) => {
      const id = r.id ? `<ID>${r.id}</ID>` : '';
      const origins = (r.allowedOrigins || []).map((o) => `<AllowedOrigin>${o}</AllowedOrigin>`).join('');
      const methods = (r.allowedMethods || []).map((m) => `<AllowedMethod>${m}</AllowedMethod>`).join('');
      const headers = (r.allowedHeaders || []).map((h) => `<AllowedHeader>${h}</AllowedHeader>`).join('');
      const expose = (r.exposeHeaders || []).map((h) => `<ExposeHeader>${h}</ExposeHeader>`).join('');
      const maxAge =
        r.maxAgeSeconds !== undefined && r.maxAgeSeconds !== null
          ? `<MaxAgeSeconds>${r.maxAgeSeconds}</MaxAgeSeconds>`
          : '';
      return `<CORSRule>${id}${origins}${methods}${headers}${expose}${maxAge}</CORSRule>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${inner}</CORSConfiguration>`;
}

function cryptoHash(buf) {
  // hex sha256 of body for the x-amz-content-sha256 header
  return requireSha256(buf);
}

import crypto from 'node:crypto';
function requireSha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
