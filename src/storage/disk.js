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

import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

import {
  Storage,
  registerBackend,
  withKeyLock,
  validateBucketName,
  randomHex,
  errNoSuchBucket,
  errNoSuchKey,
  errBucketAlreadyExists,
  errBucketNotEmpty,
  errNoSuchUpload,
  errInvalidPart,
  errInvalidPartOrder,
  errInvalidArgument,
} from './storage.js';
import { encryptFile, decryptFileToBuffer, ensureMasterKey, deriveKey, SSE_ALGORITHM } from '../util/sse.js';

// The default on-disk backend. Layout under dataDir:
//   {bucket}/bucket.json              bucket metadata
//   {bucket}/objects/{sha256(key)}.json   logical object (versions list)
//   {bucket}/objects/data/{versionId}.bin object data
//   {bucket}/uploads/{uploadId}.json       multipart upload metadata
//   {bucket}/uploads/{uploadId}/parts/{n}.part
export class DiskStorage extends Storage {
  get name() {
    return 'disk';
  }

  constructor(dataDir, sseKey) {
    super();
    this.dataDir = dataDir;
    this.sseKey = sseKey;
    this.masterKey = null;
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    // An explicit key (VS3_ENCRYPTION_KEY / config.encryption.key) wins;
    // otherwise generate one and persist it alongside the data.
    this.masterKey = this.sseKey ? deriveKey(this.sseKey) : await ensureMasterKey(this.keyPath());
  }

  keyPath() {
    return path.join(this.dataDir, 'sse-master.key');
  }

  // ---- paths ----
  bucketDir(b) {
    return path.join(this.dataDir, b);
  }
  bucketMetaPath(b) {
    return path.join(this.bucketDir(b), 'bucket.json');
  }
  objectsDir(b) {
    return path.join(this.bucketDir(b), 'objects');
  }
  objectMetaPath(b, key) {
    return path.join(this.objectsDir(b), hashKey(key) + '.json');
  }
  dataDirPath(b) {
    return path.join(this.objectsDir(b), 'data');
  }
  dataFilePath(b, key, versionId) {
    return path.join(this.dataDirPath(b), `${hashKey(key)}-${versionId}.bin`);
  }
  uploadsDir(b) {
    return path.join(this.bucketDir(b), 'uploads');
  }
  uploadMetaPath(b, uploadId) {
    return path.join(this.uploadsDir(b), `${uploadId}.json`);
  }
  uploadPartsDir(b, uploadId) {
    return path.join(this.uploadsDir(b), uploadId, 'parts');
  }
  uploadPartPath(b, uploadId, partNumber) {
    return path.join(this.uploadPartsDir(b, uploadId), `${String(partNumber).padStart(5, '0')}.part`);
  }

  // ---- buckets ----
  async createBucket(bucket) {
    validateBucketName(bucket);
    const metaPath = this.bucketMetaPath(bucket);
    if (await fileExists(metaPath)) throw errBucketAlreadyExists();
    const meta = { name: bucket, created: new Date().toISOString(), versioning: '' };
    await writeJsonAtomic(metaPath, meta);
  }

  async deleteBucket(bucket) {
    const metaPath = this.bucketMetaPath(bucket);
    if (!(await fileExists(metaPath))) throw errNoSuchBucket();
    if (!(await this._bucketEmpty(bucket))) throw errBucketNotEmpty();
    await fs.rm(this.bucketDir(bucket), { recursive: true, force: true });
  }

  async _bucketEmpty(bucket) {
    try {
      const entries = await fs.readdir(this.uploadsDir(bucket));
      if (entries.length > 0) return false;
    } catch {
      /* no uploads dir */
    }
    try {
      const entries = await fs.readdir(this.objectsDir(bucket));
      for (const e of entries) {
        if (e !== 'data') return false;
      }
      const dataEntries = await fs.readdir(this.dataDirPath(bucket));
      if (dataEntries.length > 0) return false;
    } catch {
      /* no objects */
    }
    return true;
  }

  async listBuckets() {
    let entries;
    try {
      entries = await fs.readdir(this.dataDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const meta = await readJson(this.bucketMetaPath(e.name));
        out.push({ name: meta.name, creationDate: new Date(meta.created) });
      } catch {
        /* skip */
      }
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return out;
  }

  async bucketExists(bucket) {
    return fileExists(this.bucketMetaPath(bucket));
  }

  // ---- versioning ----
  async getVersioning(bucket) {
    const meta = await this._bucketMeta(bucket);
    return meta.versioning || '';
  }

  async setVersioning(bucket, status) {
    if (!['', 'Enabled', 'Suspended'].includes(status)) {
      throw errInvalidArgument(`Invalid versioning status ${status}`);
    }
    const meta = await this._bucketMeta(bucket);
    meta.versioning = status;
    await writeJsonAtomic(this.bucketMetaPath(bucket), meta);
  }

  async _bucketMeta(bucket) {
    const metaPath = this.bucketMetaPath(bucket);
    if (!(await fileExists(metaPath))) throw errNoSuchBucket();
    return readJson(metaPath);
  }

  // ---- objects ----
  async putObject(bucket, key, stream, size, opts = {}) {
    await this._bucketMeta(bucket);
    return withKeyLock(`${bucket}/${key}`, async () => {
      const meta = await this._bucketMeta(bucket);
      const versioning = meta.versioning;
      const versionId = versioning === 'Enabled' ? randomHex(16) : 'null';
      const dataPath = this.dataFilePath(bucket, key, versionId);
      const encrypt = opts.sse === SSE_ALGORITHM;

      // Stream to a temp file first (atomic swap later), computing md5.
      await fs.mkdir(path.dirname(dataPath), { recursive: true });
      const tmp = dataPath + '.tmp';
      await writeStreamToFile(stream, tmp);
      const { md5, bytes } = await md5OfFile(tmp);

      // Non-versioned overwrites: drop the old data file before the rename
      // (old and new share the "null" path).
      const om = await this._readObjectMeta(bucket, key);
      if (versioning !== 'Enabled') {
        for (const v of om.versions) await this._removeDataFile(bucket, key, v);
      }
      let enc;
      if (encrypt) {
        const info = await encryptFile(tmp, dataPath, this.masterKey);
        await fs.rm(tmp, { force: true });
        enc = { algorithm: SSE_ALGORITHM, nonce: info.nonce, tag: info.tag };
      } else {
        await fs.rename(tmp, dataPath);
      }

      const entry = {
        versionId,
        size: bytes,
        etag: md5,
        contentType: opts.contentType || '',
        userMeta: opts.userMeta || {},
        lastModified: new Date().toISOString(),
        isDeleteMarker: false,
      };
      if (enc) entry.enc = enc;
      if (versioning === 'Enabled') {
        om.versions = [entry, ...om.versions];
        if (om.versions.length > 100) {
          const dropped = om.versions.pop();
          await this._removeDataFile(bucket, key, dropped);
        }
      } else {
        om.versions = [entry];
      }
      om.key = key;
      await writeJsonAtomic(this.objectMetaPath(bucket, key), om);
      return toObjectInfo(bucket, key, entry);
    });
  }

  async getObject(bucket, key, versionId, range) {
    const obj = await this.headObject(bucket, key, versionId);
    const dataPath = this.dataFilePath(bucket, key, obj.versionId);

    // Encrypted objects are decrypted whole (AES-GCM) then sliced for ranges.
    if (obj.enc) {
      const plain = await decryptFileToBuffer(dataPath, this.masterKey, obj.enc.nonce, obj.enc.tag);
      let start = 0;
      let end = plain.length - 1;
      if (range) {
        start = range.start;
        end = range.end === undefined ? plain.length - 1 : Math.min(range.end, plain.length - 1);
        if (start > end || start >= plain.length) throw new S3ErrRange(plain.length);
      }
      const data = plain.subarray(start, end + 1);
      return { object: { ...obj, size: data.length }, stream: Readable.from([data]) };
    }

    const stat = await fs.stat(dataPath).catch(() => null);
    if (!stat) throw errNoSuchKey();
    let start = 0;
    let end = stat.size - 1;
    if (range) {
      start = range.start;
      end = range.end === undefined ? stat.size - 1 : Math.min(range.end, stat.size - 1);
      if (start > end || start >= stat.size) {
        throw new S3ErrRange(stat.size);
      }
    }
    const readStream = fss.createReadStream(dataPath, { start, end });
    return {
      object: { ...obj, size: end - start + 1 },
      stream: readStream,
    };
  }

  async headObject(bucket, key, versionId) {
    const meta = await this._bucketMeta(bucket);
    void meta;
    const om = await this._readObjectMeta(bucket, key);
    const v = this._findVersion(om, versionId);
    if (!v || v.isDeleteMarker) throw errNoSuchKey();
    return toObjectInfo(bucket, key, v);
  }

  async deleteObject(bucket, key, versionId) {
    const meta = await this._bucketMeta(bucket);
    const versioning = meta.versioning;
    return withKeyLock(`${bucket}/${key}`, async () => {
      const om = await this._readObjectMeta(bucket, key);
      if (om.versions.length === 0) {
        if (versioning === 'Enabled') {
          const marker = {
            versionId: randomHex(16),
            size: 0,
            etag: '',
            contentType: '',
            userMeta: {},
            lastModified: new Date().toISOString(),
            isDeleteMarker: true,
          };
          om.versions = [marker];
          om.key = key;
          await writeJsonAtomic(this.objectMetaPath(bucket, key), om);
          return toObjectInfo(bucket, key, marker);
        }
        return null;
      }
      if (versionId) {
        const idx = om.versions.findIndex((v) => v.versionId === versionId);
        if (idx < 0) throw errNoSuchKey();
        const removed = om.versions.splice(idx, 1)[0];
        await this._removeDataFile(bucket, key, removed);
        if (om.versions.length === 0) {
          await fs.rm(this.objectMetaPath(bucket, key), { force: true });
        } else {
          await writeJsonAtomic(this.objectMetaPath(bucket, key), om);
        }
        return toObjectInfo(bucket, key, removed);
      }
      if (versioning === 'Enabled') {
        const marker = {
          versionId: randomHex(16),
          size: 0,
          etag: '',
          contentType: '',
          userMeta: {},
          lastModified: new Date().toISOString(),
          isDeleteMarker: true,
        };
        om.versions = [marker, ...om.versions];
        await writeJsonAtomic(this.objectMetaPath(bucket, key), om);
        return toObjectInfo(bucket, key, marker);
      }
      const latest = om.versions[0];
      for (const v of om.versions) await this._removeDataFile(bucket, key, v);
      await fs.rm(this.objectMetaPath(bucket, key), { force: true });
      return toObjectInfo(bucket, key, latest);
    });
  }

  async copyObject(srcBucket, srcKey, dstBucket, dstKey, opts = {}) {
    const src = await this.getObject(srcBucket, srcKey, '', null);
    try {
      const info = await this.putObject(dstBucket, dstKey, src.stream, 0, opts);
      return { etag: info.etag, lastModified: info.lastModified, object: info };
    } finally {
      if (src.stream.destroy) src.stream.destroy();
    }
  }

  async listObjects(bucket, params = {}) {
    await this._bucketMeta(bucket);
    const { prefix = '', delimiter = '', marker = '', maxKeys = 1000 } = params;
    const keys = await this._collectKeys(bucket);
    keys.sort();
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
      try {
        const obj = await this.headObject(bucket, key, '');
        objects.push(obj);
        count++;
      } catch {
        // skip delete markers
      }
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
    await this._bucketMeta(bucket);
    const { prefix = '', delimiter = '', keyMarker = '', versionIdMarker = '', maxKeys = 1000 } = params;
    const keys = await this._collectKeys(bucket);
    keys.sort();
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
      const om = await this._readObjectMeta(bucket, key);
      for (const v of om.versions) {
        if (keyMarker && key === keyMarker && versionIdMarker && v.versionId > versionIdMarker) continue;
        if (maxKeys > 0 && count >= maxKeys) {
          truncated = true;
          break;
        }
        const info = toObjectInfo(bucket, key, v);
        if (v.isDeleteMarker) deleteMarkers.push(info);
        else versions.push(info);
        nextKeyMarker = key;
        nextVersionIdMarker = v.versionId;
        count++;
      }
      if (truncated) break;
    }
    return { versions, deleteMarkers, commonPrefixes, truncated, nextKeyMarker, nextVersionIdMarker };
  }

  // ---- multipart ----
  async createMultipartUpload(bucket, key, opts = {}) {
    await this._bucketMeta(bucket);
    const uploadId = randomHex(16);
    const um = {
      bucket,
      key,
      uploadId,
      contentType: opts.contentType || '',
      userMeta: opts.userMeta || {},
      initiated: new Date().toISOString(),
      parts: [],
    };
    if (opts.sse === SSE_ALGORITHM) um.sse = SSE_ALGORITHM;
    await writeJsonAtomic(this.uploadMetaPath(bucket, uploadId), um);
    return uploadId;
  }

  async uploadPart(bucket, key, uploadId, partNumber, stream, size) {
    if (partNumber < 1 || partNumber > 10000) throw errInvalidPart();
    return withKeyLock(`${bucket}/uploads/${uploadId}`, async () => {
      const um = await this._readUploadMeta(bucket, uploadId);
      const partPath = this.uploadPartPath(bucket, uploadId, partNumber);
      await fs.mkdir(path.dirname(partPath), { recursive: true });
      const tmp = partPath + '.tmp';
      await writeStreamToFile(stream, tmp);
      const { md5, bytes } = await md5OfFile(tmp);
      await fs.rename(tmp, partPath);
      const now = new Date().toISOString();
      const idx = um.parts.findIndex((p) => p.partNumber === partNumber);
      const rec = { partNumber, etag: md5, size: bytes, lastModified: now };
      if (idx >= 0) um.parts[idx] = rec;
      else um.parts.push(rec);
      await writeJsonAtomic(this.uploadMetaPath(bucket, uploadId), um);
      return rec;
    });
  }

  async completeMultipartUpload(bucket, key, uploadId, parts) {
    return withKeyLock(`${bucket}/uploads/${uploadId}`, async () => {
      const um = await this._readUploadMeta(bucket, uploadId);
      for (let i = 1; i < parts.length; i++) {
        if (parts[i].partNumber < parts[i - 1].partNumber) throw errInvalidPartOrder();
      }
      const meta = await this._bucketMeta(bucket);
      const versioning = meta.versioning;
      const versionId = versioning === 'Enabled' ? randomHex(16) : 'null';
      const dataPath = this.dataFilePath(bucket, key, versionId);
      await fs.mkdir(path.dirname(dataPath), { recursive: true });
      const tmp = dataPath + '.tmp';
      const hash = crypto.createHash('md5');
      const out = fss.createWriteStream(tmp);
      let total = 0;
      const partMap = new Map(um.parts.map((p) => [p.partNumber, p]));
      for (const p of parts) {
        const rec = partMap.get(p.partNumber);
        if (!rec) throw errInvalidPart();
        if (p.etag && p.etag !== rec.etag) throw errInvalidPart();
        const partStream = fss.createReadStream(this.uploadPartPath(bucket, uploadId, p.partNumber));
        for await (const chunk of partStream) {
          total += chunk.length;
          hash.update(chunk);
          if (!out.write(chunk)) await once(out, 'drain');
        }
      }
      out.end();
      await once(out, 'finish');

      const om = await this._readObjectMeta(bucket, key);
      if (versioning !== 'Enabled') {
        for (const v of om.versions) await this._removeDataFile(bucket, key, v);
      }
      let enc;
      if (um.sse === SSE_ALGORITHM) {
        const info = await encryptFile(tmp, dataPath, this.masterKey);
        await fs.rm(tmp, { force: true });
        enc = { algorithm: SSE_ALGORITHM, nonce: info.nonce, tag: info.tag };
      } else {
        await fs.rename(tmp, dataPath);
      }

      const entry = {
        versionId,
        size: total,
        etag: hash.digest('hex'),
        contentType: um.contentType,
        userMeta: um.userMeta,
        lastModified: new Date().toISOString(),
        isDeleteMarker: false,
      };
      if (enc) entry.enc = enc;
      if (versioning === 'Enabled') {
        om.versions = [entry, ...om.versions].slice(0, 100);
        if (om.versions.length > 100) {
          const dropped = om.versions.pop();
          await this._removeDataFile(bucket, key, dropped);
        }
      } else {
        om.versions = [entry];
      }
      om.key = key;
      await writeJsonAtomic(this.objectMetaPath(bucket, key), om);

      await fs.rm(this.uploadsDir(bucket) + '/' + uploadId, { recursive: true, force: true });
      await fs.rm(this.uploadMetaPath(bucket, uploadId), { force: true });
      return toObjectInfo(bucket, key, entry);
    });
  }

  async abortMultipartUpload(bucket, key, uploadId) {
    return withKeyLock(`${bucket}/uploads/${uploadId}`, async () => {
      await this._readUploadMeta(bucket, uploadId);
      await fs.rm(this.uploadsDir(bucket) + '/' + uploadId, { recursive: true, force: true });
      await fs.rm(this.uploadMetaPath(bucket, uploadId), { force: true });
    });
  }

  async listParts(bucket, key, uploadId) {
    const um = await this._readUploadMeta(bucket, uploadId);
    return um.parts.slice().sort((a, b) => a.partNumber - b.partNumber);
  }

  async listMultipartUploads(bucket) {
    await this._bucketMeta(bucket);
    let entries;
    try {
      entries = await fs.readdir(this.uploadsDir(bucket));
    } catch {
      return [];
    }
    const out = [];
    for (const e of entries) {
      if (!e.endsWith('.json')) continue;
      try {
        const um = await readJson(path.join(this.uploadsDir(bucket), e));
        out.push({ bucket, key: um.key, uploadId: um.uploadId, initiated: new Date(um.initiated) });
      } catch {
        /* skip */
      }
    }
    return out;
  }

  // ---- tagging ----
  async getObjectTagging(bucket, key, versionId) {
    const om = await this._readObjectMeta(bucket, key);
    const v = this._findVersion(om, versionId);
    if (!v || v.isDeleteMarker) throw errNoSuchKey();
    return v.tags || [];
  }

  async setObjectTagging(bucket, key, tags, versionId) {
    await withKeyLock(`${bucket}/${key}`, async () => {
      const om = await this._readObjectMeta(bucket, key);
      const v = versionId ? om.versions.find((x) => x.versionId === versionId) : om.versions[0];
      if (!v || v.isDeleteMarker) throw errNoSuchKey();
      v.tags = Array.isArray(tags) ? tags : [];
      await writeJsonAtomic(this.objectMetaPath(bucket, key), om);
    });
  }

  async deleteObjectTagging(bucket, key, versionId) {
    await this.setObjectTagging(bucket, key, [], versionId);
  }

  async getBucketTagging(bucket) {
    const meta = await this._bucketMeta(bucket);
    return meta.tags || [];
  }

  async setBucketTagging(bucket, tags) {
    const meta = await this._bucketMeta(bucket);
    meta.tags = Array.isArray(tags) ? tags : [];
    await writeJsonAtomic(this.bucketMetaPath(bucket), meta);
  }

  async deleteBucketTagging(bucket) {
    const meta = await this._bucketMeta(bucket);
    delete meta.tags;
    await writeJsonAtomic(this.bucketMetaPath(bucket), meta);
  }

  // ---- policy ----
  async getBucketPolicy(bucket) {
    const meta = await this._bucketMeta(bucket);
    return meta.policy || null;
  }

  async setBucketPolicy(bucket, policy) {
    const meta = await this._bucketMeta(bucket);
    meta.policy = String(policy);
    await writeJsonAtomic(this.bucketMetaPath(bucket), meta);
  }

  async deleteBucketPolicy(bucket) {
    const meta = await this._bucketMeta(bucket);
    delete meta.policy;
    await writeJsonAtomic(this.bucketMetaPath(bucket), meta);
  }

  // ---- lifecycle ----
  async getLifecycle(bucket) {
    const meta = await this._bucketMeta(bucket);
    return meta.lifecycle || [];
  }

  async setLifecycle(bucket, rules) {
    const meta = await this._bucketMeta(bucket);
    meta.lifecycle = Array.isArray(rules) ? rules : [];
    await writeJsonAtomic(this.bucketMetaPath(bucket), meta);
  }

  async deleteLifecycle(bucket) {
    const meta = await this._bucketMeta(bucket);
    delete meta.lifecycle;
    await writeJsonAtomic(this.bucketMetaPath(bucket), meta);
  }

  // ---- cors ----
  async getBucketCors(bucket) {
    const meta = await this._bucketMeta(bucket);
    return meta.cors || [];
  }

  async setBucketCors(bucket, rules) {
    const meta = await this._bucketMeta(bucket);
    meta.cors = Array.isArray(rules) ? rules : [];
    await writeJsonAtomic(this.bucketMetaPath(bucket), meta);
  }

  async deleteBucketCors(bucket) {
    const meta = await this._bucketMeta(bucket);
    delete meta.cors;
    await writeJsonAtomic(this.bucketMetaPath(bucket), meta);
  }

  // Apply the bucket lifecycle: expire objects older than Expiration.Days and
  // abort incomplete multipart uploads older than AbortIncompleteMultipartUpload.
  // Returns the number of entities removed.
  async runLifecycle(bucket) {
    let meta;
    try {
      meta = await this._bucketMeta(bucket);
    } catch {
      return 0;
    }
    const rules = (meta.lifecycle || []).filter((r) => r && (r.status || 'Enabled') === 'Enabled');
    if (rules.length === 0) return 0;
    const now = Date.now();
    const versioning = meta.versioning;
    let removed = 0;

    const keys = await this._collectKeys(bucket);
    for (const key of keys) {
      const om = await this._readObjectMeta(bucket, key);
      const v = om.versions[0];
      if (!v || v.isDeleteMarker) continue;
      const ageDays = (now - new Date(v.lastModified).getTime()) / 86400000;
      for (const rule of rules) {
        if (!lifecycleMatches(rule, key)) continue;
        if (rule.expiration && rule.expiration.days !== undefined && ageDays >= rule.expiration.days) {
          if (versioning === 'Enabled') await this.deleteObject(bucket, key, v.versionId);
          else await this.deleteObject(bucket, key, '');
          removed++;
          break;
        }
      }
    }

    for (const rule of rules) {
      if (!rule.abort || rule.abort.days === undefined) continue;
      const cutoff = now - rule.abort.days * 86400000;
      const uploads = await this.listMultipartUploads(bucket);
      for (const u of uploads) {
        if (!lifecycleMatches(rule, u.key)) continue;
        if (new Date(u.initiated).getTime() < cutoff) {
          await this.abortMultipartUpload(bucket, u.key, u.uploadId);
          removed++;
        }
      }
    }
    return removed;
  }

  // ---- internal helpers ----
  async _readObjectMeta(bucket, key) {
    try {
      return await readJson(this.objectMetaPath(bucket, key));
    } catch {
      return { key, versions: [] };
    }
  }

  async _readUploadMeta(bucket, uploadId) {
    const p = this.uploadMetaPath(bucket, uploadId);
    if (!(await fileExists(p))) throw errNoSuchUpload();
    return readJson(p);
  }

  async _collectKeys(bucket) {
    let entries;
    try {
      entries = await fs.readdir(this.objectsDir(bucket));
    } catch {
      return [];
    }
    const keys = [];
    for (const e of entries) {
      if (e === 'data' || !e.endsWith('.json')) continue;
      try {
        const om = await readJson(path.join(this.objectsDir(bucket), e));
        if (om.versions && om.versions.length > 0 && om.key) keys.push(om.key);
      } catch {
        /* skip */
      }
    }
    return keys;
  }

  _findVersion(om, versionId) {
    if (!om.versions || om.versions.length === 0) return null;
    if (!versionId) return om.versions[0];
    return om.versions.find((v) => v.versionId === versionId) || null;
  }

  async _removeDataFile(bucket, key, v) {
    if (!v || !v.versionId) return;
    await fs.rm(this.dataFilePath(bucket, key, v.versionId), { force: true });
  }
}

function toObjectInfo(bucket, key, v) {
  return {
    bucket,
    key,
    versionId: v.versionId,
    size: v.size,
    etag: v.etag,
    contentType: v.contentType,
    userMeta: v.userMeta || {},
    lastModified: new Date(v.lastModified),
    isDeleteMarker: !!v.isDeleteMarker,
    storageClass: 'STANDARD',
    sse: v.enc && v.enc.algorithm === SSE_ALGORITHM ? SSE_ALGORITHM : undefined,
    enc: v.enc || undefined,
  };
}

function hashKey(key) {
  return crypto.createHash('md5').update(key).digest('hex');
}

// True if the lifecycle rule's prefix (when set) matches the key.
function lifecycleMatches(rule, key) {
  if (!rule.prefix) return true;
  return key.startsWith(rule.prefix);
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p) {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

async function writeJsonAtomic(p, value) {
  const dir = path.dirname(p);
  await fs.mkdir(dir, { recursive: true });
  const tmp = p + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, p);
}

// Write a readable stream to a file (temp), returning bytes written.
function writeStreamToFile(stream, destPath) {
  return new Promise((resolve, reject) => {
    const out = fss.createWriteStream(destPath);
    let bytes = 0;
    stream.on('data', (c) => {
      bytes += c.length;
    });
    stream.pipe(out);
    out.on('finish', () => resolve({ bytes }));
    out.on('error', reject);
    stream.on('error', reject);
  });
}

async function md5OfFile(p) {
  const h = crypto.createHash('md5');
  const s = fss.createReadStream(p);
  s.on('data', (c) => h.update(c));
  await new Promise((resolve, reject) => {
    s.on('end', resolve);
    s.on('error', reject);
  });
  const md5 = h.digest('hex');
  const stat = await fs.stat(p);
  return { md5, bytes: stat.size };
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, resolve);
    emitter.once('error', reject);
  });
}

// range error with content-range info
class S3ErrRange extends Error {
  constructor(size) {
    super('The requested range is not satisfiable');
    this.code = 'InvalidRange';
    this.status = 416;
    this.contentRange = `bytes */${size}`;
  }
}

registerBackend('disk', (cfg = {}) => {
  const dataDir = cfg.dataDir || './data';
  const inst = new DiskStorage(dataDir, cfg.sseKey);
  return inst;
});
