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

import { Readable } from 'node:stream';
import crypto from 'node:crypto';

import {
  Storage,
  registerBackend,
  validateBucketName,
  randomHex,
  errNoSuchBucket,
  errNoSuchKey,
  errBucketAlreadyExists,
  errBucketNotEmpty,
  errNoSuchUpload,
  errInvalidPart,
  errInvalidPartOrder,
} from './storage.js';
import { encryptBuffer, decryptBuffer, deriveKey, SSE_ALGORITHM } from '../util/sse.js';

// In-memory backend. Ephemeral; useful for tests, demos and as a compact
// reference implementation of the Storage interface.
export class MemoryStorage extends Storage {
  get name() {
    return 'memory';
  }

  constructor(cfg = {}) {
    super();
    this.buckets = new Map(); // name -> bucket
    this.masterKey = deriveKey(cfg.sseKey || '');
  }

  async createBucket(bucket) {
    validateBucketName(bucket);
    if (this.buckets.has(bucket)) throw errBucketAlreadyExists();
    this.buckets.set(bucket, {
      created: new Date(),
      versioning: '',
      objects: new Map(),
      uploads: new Map(),
    });
  }

  async deleteBucket(bucket) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    if (b.objects.size > 0 || b.uploads.size > 0) throw errBucketNotEmpty();
    this.buckets.delete(bucket);
  }

  async listBuckets() {
    return [...this.buckets.entries()]
      .map(([name, b]) => ({ name, creationDate: b.created }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async bucketExists(bucket) {
    return this.buckets.has(bucket);
  }

  async getVersioning(bucket) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    return b.versioning;
  }

  async setVersioning(bucket, status) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    b.versioning = status;
  }

  async putObject(bucket, key, stream, size, opts = {}) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    const plain = Buffer.from(await streamToBuffer(stream));
    const versionId = b.versioning === 'Enabled' ? randomHex(16) : 'null';
    let data = plain;
    let enc;
    if (opts.sse === SSE_ALGORITHM) {
      const r = encryptBuffer(plain, this.masterKey);
      data = r.data;
      enc = { algorithm: SSE_ALGORITHM, nonce: r.nonce, tag: r.tag };
    }
    const info = {
      bucket,
      key,
      versionId,
      size: plain.length,
      etag: md5hex(plain),
      contentType: opts.contentType || '',
      userMeta: opts.userMeta || {},
      lastModified: new Date(),
      isDeleteMarker: false,
      storageClass: 'STANDARD',
    };
    if (enc) {
      info.enc = enc;
      info.sse = SSE_ALGORITHM;
    }
    let obj = b.objects.get(key);
    if (!obj) {
      obj = { versions: [] };
      b.objects.set(key, obj);
    }
    if (b.versioning === 'Enabled') obj.versions.unshift({ info, data });
    else obj.versions = [{ info, data }];
    return info;
  }

  async getObject(bucket, key, versionId, range) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    const obj = b.objects.get(key);
    if (!obj) throw errNoSuchKey();
    const v = findVersion(obj, versionId);
    if (!v || v.info.isDeleteMarker) throw errNoSuchKey();
    let data = v.data;
    if (v.info.enc) {
      data = decryptBuffer(data, this.masterKey, v.info.enc.nonce, v.info.enc.tag);
    }
    if (range) {
      const start = range.start;
      const end = range.end === undefined ? data.length - 1 : Math.min(range.end, data.length - 1);
      if (start > end || start >= data.length) {
        const e = new Error('The requested range is not satisfiable');
        e.code = 'InvalidRange';
        e.status = 416;
        e.contentRange = `bytes */${data.length}`;
        throw e;
      }
      data = data.subarray(start, end + 1);
    }
    return { object: { ...v.info, size: data.length }, stream: Readable.from([data]) };
  }

  async headObject(bucket, key, versionId) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    const obj = b.objects.get(key);
    if (!obj) throw errNoSuchKey();
    const v = findVersion(obj, versionId);
    if (!v || v.info.isDeleteMarker) throw errNoSuchKey();
    return v.info;
  }

  async deleteObject(bucket, key, versionId) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    const obj = b.objects.get(key);
    if (!obj) {
      if (b.versioning === 'Enabled') {
        const marker = makeMarker(bucket, key);
        b.objects.set(key, { versions: [{ info: marker, data: Buffer.alloc(0) }] });
        return marker;
      }
      return null;
    }
    if (versionId) {
      const idx = obj.versions.findIndex((v) => v.info.versionId === versionId);
      if (idx < 0) throw errNoSuchKey();
      const removed = obj.versions.splice(idx, 1)[0];
      if (obj.versions.length === 0) b.objects.delete(key);
      return removed.info;
    }
    if (b.versioning === 'Enabled') {
      const marker = makeMarker(bucket, key);
      obj.versions.unshift({ info: marker, data: Buffer.alloc(0) });
      return marker;
    }
    const latest = obj.versions[0].info;
    b.objects.delete(key);
    return latest;
  }

  async copyObject(srcBucket, srcKey, dstBucket, dstKey, opts = {}) {
    const src = await this.getObject(srcBucket, srcKey, '', null);
    const info = await this.putObject(dstBucket, dstKey, src.stream, 0, opts);
    return { etag: info.etag, lastModified: info.lastModified, object: info };
  }

  async listObjects(bucket, params = {}) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    const { prefix = '', delimiter = '', marker = '', maxKeys = 1000 } = params;
    const keys = [...b.objects.keys()].sort();
    const objects = [];
    const commonPrefixes = [];
    const seen = new Set();
    let count = 0;
    let truncated = false;
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue;
      if (delimiter) {
        const rest = key.slice(prefix.length);
        const i = rest.indexOf(delimiter);
        if (i >= 0) {
          const common = prefix + rest.slice(0, i + delimiter.length);
          if (marker && common <= marker) continue;
          if (seen.has(common)) continue;
          if (maxKeys > 0 && count >= maxKeys) {
            truncated = true;
            break;
          }
          seen.add(common);
          commonPrefixes.push(common);
          count++;
          continue;
        }
      }
      if (marker && key <= marker) continue;
      if (maxKeys > 0 && count >= maxKeys) {
        truncated = true;
        break;
      }
      const v = findVersion(b.objects.get(key), '');
      if (!v || v.info.isDeleteMarker) continue;
      objects.push(v.info);
      count++;
    }
    const nextMarker = truncated
      ? commonPrefixes.length
        ? commonPrefixes[commonPrefixes.length - 1]
        : objects.length
          ? objects[objects.length - 1].key
          : ''
      : '';
    return { objects, commonPrefixes, truncated, nextMarker, keyCount: count };
  }

  async listObjectVersions(bucket, params = {}) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    const { prefix = '', delimiter = '', keyMarker = '', versionIdMarker = '', maxKeys = 1000 } = params;
    const keys = [...b.objects.keys()].sort();
    const versions = [];
    const deleteMarkers = [];
    const commonPrefixes = [];
    const seen = new Set();
    let count = 0;
    let truncated = false;
    let nextKeyMarker = '';
    let nextVersionIdMarker = '';
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue;
      if (delimiter) {
        const rest = key.slice(prefix.length);
        const i = rest.indexOf(delimiter);
        if (i >= 0) {
          const common = prefix + rest.slice(0, i + delimiter.length);
          if (keyMarker && common <= keyMarker) continue;
          if (seen.has(common)) continue;
          if (maxKeys > 0 && count >= maxKeys) {
            truncated = true;
            break;
          }
          seen.add(common);
          commonPrefixes.push(common);
          count++;
          continue;
        }
      }
      if (keyMarker && key < keyMarker) continue;
      const obj = b.objects.get(key);
      for (const v of obj.versions) {
        if (keyMarker && key === keyMarker && versionIdMarker && v.info.versionId > versionIdMarker) continue;
        if (maxKeys > 0 && count >= maxKeys) {
          truncated = true;
          break;
        }
        if (v.info.isDeleteMarker) deleteMarkers.push(v.info);
        else versions.push(v.info);
        nextKeyMarker = key;
        nextVersionIdMarker = v.info.versionId;
        count++;
      }
      if (truncated) break;
    }
    return { versions, deleteMarkers, commonPrefixes, truncated, nextKeyMarker, nextVersionIdMarker };
  }

  async createMultipartUpload(bucket, key, opts = {}) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    const uploadId = randomHex(16);
    b.uploads.set(uploadId, {
      key,
      contentType: opts.contentType || '',
      userMeta: opts.userMeta || {},
      initiated: new Date(),
      parts: new Map(),
    });
    if (opts.sse === SSE_ALGORITHM) b.uploads.get(uploadId).sse = SSE_ALGORITHM;
    return uploadId;
  }

  async uploadPart(bucket, key, uploadId, partNumber, stream, size) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    if (partNumber < 1 || partNumber > 10000) throw errInvalidPart();
    const up = b.uploads.get(uploadId);
    if (!up) throw errNoSuchUpload();
    const data = Buffer.from(await streamToBuffer(stream));
    up.parts.set(partNumber, {
      partNumber,
      etag: md5hex(data),
      size: data.length,
      lastModified: new Date(),
      data,
    });
    return up.parts.get(partNumber);
  }

  async completeMultipartUpload(bucket, key, uploadId, parts) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    const up = b.uploads.get(uploadId);
    if (!up) throw errNoSuchUpload();
    for (let i = 1; i < parts.length; i++) {
      if (parts[i].partNumber < parts[i - 1].partNumber) throw errInvalidPartOrder();
    }
    const chunks = [];
    const hash = crypto.createHash('md5');
    let total = 0;
    for (const p of parts) {
      const rec = up.parts.get(p.partNumber);
      if (!rec) throw errInvalidPart();
      if (p.etag && p.etag !== rec.etag) throw errInvalidPart();
      chunks.push(rec.data);
      hash.update(rec.data);
      total += rec.data.length;
    }
    const plain = Buffer.concat(chunks);
    const versionId = b.versioning === 'Enabled' ? randomHex(16) : 'null';
    const info = {
      bucket,
      key,
      versionId,
      size: total,
      etag: hash.digest('hex'),
      contentType: up.contentType,
      userMeta: up.userMeta,
      lastModified: new Date(),
      isDeleteMarker: false,
      storageClass: 'STANDARD',
    };
    let data = plain;
    if (up.sse === SSE_ALGORITHM) {
      const r = encryptBuffer(plain, this.masterKey);
      data = r.data;
      info.enc = { algorithm: SSE_ALGORITHM, nonce: r.nonce, tag: r.tag };
      info.sse = SSE_ALGORITHM;
    }
    let obj = b.objects.get(key);
    if (!obj) {
      obj = { versions: [] };
      b.objects.set(key, obj);
    }
    if (b.versioning === 'Enabled') obj.versions.unshift({ info, data });
    else obj.versions = [{ info, data }];
    b.uploads.delete(uploadId);
    return info;
  }

  async abortMultipartUpload(bucket, key, uploadId) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    if (!b.uploads.has(uploadId)) throw errNoSuchUpload();
    b.uploads.delete(uploadId);
  }

  async listParts(bucket, key, uploadId) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    const up = b.uploads.get(uploadId);
    if (!up) throw errNoSuchUpload();
    return [...up.parts.values()].sort((a, b) => a.partNumber - b.partNumber);
  }

  async listMultipartUploads(bucket) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    return [...b.uploads.entries()].map(([id, up]) => ({
      bucket,
      key: up.key,
      uploadId: id,
      initiated: up.initiated,
    }));
  }

  // ---- tagging ----
  async getObjectTagging(bucket, key, versionId) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    const obj = b.objects.get(key);
    if (!obj) throw errNoSuchKey();
    const v = findVersion(obj, versionId);
    if (!v || v.info.isDeleteMarker) throw errNoSuchKey();
    return v.info.tags || [];
  }

  async setObjectTagging(bucket, key, tags, versionId) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    const obj = b.objects.get(key);
    if (!obj) throw errNoSuchKey();
    const v = findVersion(obj, versionId);
    if (!v || v.info.isDeleteMarker) throw errNoSuchKey();
    v.info.tags = Array.isArray(tags) ? tags : [];
  }

  async deleteObjectTagging(bucket, key, versionId) {
    await this.setObjectTagging(bucket, key, [], versionId);
  }

  async getBucketTagging(bucket) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    return b.tags || [];
  }

  async setBucketTagging(bucket, tags) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    b.tags = Array.isArray(tags) ? tags : [];
  }

  async deleteBucketTagging(bucket) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    delete b.tags;
  }

  // ---- policy ----
  async getBucketPolicy(bucket) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    return b.policy || null;
  }

  async setBucketPolicy(bucket, policy) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    b.policy = String(policy);
  }

  async deleteBucketPolicy(bucket) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    delete b.policy;
  }

  // ---- lifecycle ----
  async getLifecycle(bucket) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    return b.lifecycle || [];
  }

  async setLifecycle(bucket, rules) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    b.lifecycle = Array.isArray(rules) ? rules : [];
  }

  async deleteLifecycle(bucket) {
    const b = this.buckets.get(bucket);
    if (!b) throw errNoSuchBucket();
    delete b.lifecycle;
  }

  async runLifecycle(bucket) {
    const b = this.buckets.get(bucket);
    if (!b) return 0;
    const rules = (b.lifecycle || []).filter((r) => r && (r.status || 'Enabled') === 'Enabled');
    if (rules.length === 0) return 0;
    const now = Date.now();
    let removed = 0;
    for (const [key, obj] of b.objects) {
      const v = findVersion(obj, '');
      if (!v || v.info.isDeleteMarker) continue;
      const ageDays = (now - v.info.lastModified.getTime()) / 86400000;
      for (const rule of rules) {
        if (!lifecycleMatches(rule, key)) continue;
        if (rule.expiration && rule.expiration.days !== undefined && ageDays >= rule.expiration.days) {
          await this.deleteObject(bucket, key, b.versioning === 'Enabled' ? v.info.versionId : '');
          removed++;
          break;
        }
      }
    }
    for (const rule of rules) {
      if (!rule.abort || rule.abort.days === undefined) continue;
      const cutoff = now - rule.abort.days * 86400000;
      for (const [id, up] of b.uploads) {
        if (!lifecycleMatches(rule, up.key)) continue;
        if (up.initiated.getTime() < cutoff) {
          await this.abortMultipartUpload(bucket, up.key, id);
          removed++;
        }
      }
    }
    return removed;
  }
}

function findVersion(obj, versionId) {
  if (!obj || obj.versions.length === 0) return null;
  if (!versionId) return obj.versions[0];
  return obj.versions.find((v) => v.info.versionId === versionId) || null;
}

// True if the lifecycle rule's prefix (when set) matches the key.
function lifecycleMatches(rule, key) {
  if (!rule.prefix) return true;
  return key.startsWith(rule.prefix);
}

function makeMarker(bucket, key) {
  return {
    bucket,
    key,
    versionId: randomHex(16),
    size: 0,
    etag: '',
    contentType: '',
    userMeta: {},
    lastModified: new Date(),
    isDeleteMarker: true,
    storageClass: 'STANDARD',
  };
}

function md5hex(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

registerBackend('memory', (cfg = {}) => new MemoryStorage(cfg));
