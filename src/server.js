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

import http from 'node:http';
import crypto from 'node:crypto';

import { loadConfig } from './config.js';
import { verifyRequest, Presigner } from './auth/sigv4.js';
import { evaluatePolicy } from './auth/policy.js';
import { createBackend } from './storage/storage.js';
import './storage/disk.js';
import './storage/memory.js';
import './storage/custom.js';
import { FunctionContext, runHooks, getFunction, listFunctions } from './plugin/index.js';
import './plugin/builtin.js';

import { S3Error, toS3Error, errorXml } from './api/errors.js';
import * as xml from './api/xml_responses.js';
import { httpDate } from './util/xml.js';
import { SSE_HEADER, SSE_ALGORITHM } from './util/sse.js';

const VERSION = '1.0.0';

// Map an S3 operation name to the IAM action used for bucket-policy checks.
const OP_ACTIONS = {
  CreateBucket: 's3:CreateBucket',
  DeleteBucket: 's3:DeleteBucket',
  HeadBucket: 's3:ListBucket',
  GetBucketLocation: 's3:GetBucketLocation',
  GetBucketVersioning: 's3:GetBucketVersioning',
  SetBucketVersioning: 's3:PutBucketVersioning',
  GetBucketTagging: 's3:GetBucketTagging',
  PutBucketTagging: 's3:PutBucketTagging',
  DeleteBucketTagging: 's3:DeleteBucketTagging',
  GetBucketPolicy: 's3:GetBucketPolicy',
  PutBucketPolicy: 's3:PutBucketPolicy',
  DeleteBucketPolicy: 's3:DeleteBucketPolicy',
  GetBucketLifecycle: 's3:GetLifecycleConfiguration',
  PutBucketLifecycle: 's3:PutLifecycleConfiguration',
  DeleteBucketLifecycle: 's3:PutLifecycleConfiguration',
  ListObjects: 's3:ListBucket',
  ListObjectsV2: 's3:ListBucket',
  ListObjectVersions: 's3:ListBucketVersions',
  PutObject: 's3:PutObject',
  GetObject: 's3:GetObject',
  HeadObject: 's3:GetObject',
  DeleteObject: 's3:DeleteObject',
  DeleteObjects: 's3:DeleteObject',
  CopyObject: 's3:PutObject',
  CreateMultipartUpload: 's3:PutObject',
  UploadPart: 's3:PutObject',
  CompleteMultipartUpload: 's3:PutObject',
  AbortMultipartUpload: 's3:AbortMultipartUpload',
  ListParts: 's3:ListMultipartUploadParts',
  ListMultipartUploads: 's3:ListBucketMultipartUploads',
};

// Map an S3 operation name to its hook point.
const HOOK_BY_OP = {
  PutObject: 'onPut',
  GetObject: 'onGet',
  HeadObject: 'onHead',
  DeleteObject: 'onDelete',
  CopyObject: 'onCopy',
  ListObjects: 'onList',
  ListObjectsV2: 'onList',
  CreateMultipartUpload: 'onMultipart',
  UploadPart: 'onMultipart',
  CompleteMultipartUpload: 'onMultipart',
  AbortMultipartUpload: 'onMultipart',
  DeleteObjects: 'onDelete',
};

export class S3Server {
  constructor(config = loadConfig()) {
    this.config = config;
    this.storage = createBackend(config.storage.backend, {
      ...(config.storage[config.storage.backend] || {}),
      dataDir: config.storage.disk && config.storage.disk.dataDir,
      sseKey: config.encryption && config.encryption.key,
    });
    this.region = config.server.region || 'us-east-1';
    this.startTime = Date.now();
    this.metrics = {
      requests: 0,
      errors: 0,
      bytesIn: 0,
      bytesOut: 0,
      byOperation: new Map(),
      byStatus: new Map(),
    };
    this.presigner = null;
    const firstUser = (config.auth.users || [])[0];
    if (firstUser) {
      this.presigner = new Presigner({
        accessKey: firstUser.accessKey,
        secretKey: firstUser.secretKey,
        region: this.region,
      });
    }
  }

  _provider() {
    const users = new Map((this.config.auth.users || []).map((u) => [u.accessKey, u.secretKey]));
    return { secretKey: (ak) => users.get(ak) };
  }

  async init() {
    await this.storage.init();
  }

  listen(port, host) {
    const server = http.createServer((req, res) =>
      this._handle(req, res).catch((e) => this._handleError(req, res, e)),
    );
    server.listen(port, host);
    return server;
  }

  // ---- request normalization ----
  _normalize(req) {
    const rawUrl = req.url || '/';
    const qIdx = rawUrl.indexOf('?');
    const rawPath = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
    const rawQuery = qIdx >= 0 ? rawUrl.slice(qIdx + 1) : '';
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      decodedPath = rawPath;
    }
    const segments = decodedPath.split('/').filter((s) => s !== '');
    const queryParts = parseQueryPairs(rawQuery);
    const queryParams = {};
    for (const p of queryParts) {
      try {
        queryParams[p.name] = decodeURIComponent(p.value);
      } catch {
        queryParams[p.name] = p.value;
      }
    }
    const isQueryAuth = queryParams['X-Amz-Algorithm'] === 'AWS4-HMAC-SHA256';
    return {
      method: req.method,
      path: rawPath,
      decodedPath,
      segments,
      rawQuery,
      queryParts,
      queryParams,
      isQueryAuth,
      headers: req.headers,
      req,
    };
  }

  async _handle(req, res) {
    this.metrics.requests++;
    const n = this._normalize(req);
    try {
      if (n.segments[0] && n.segments[0].startsWith('__')) {
        await this._handleInternal(req, res, n);
        this._recordStatus(res.statusCode);
        return;
      }
      const op = this._dispatch(n);
      const identity = this._authorize(n);
      n._identity = identity;
      await this._enforcePolicy(n, op);
      this._recordOp(op);

      const ctx = new FunctionContext({
        operation: op,
        method: n.method,
        bucket: n.segments[0] || '',
        key: n.segments.slice(1).join('/'),
        versionId: n.queryParams['versionId'] || '',
        headers: n.headers,
        query: n.queryParams,
        req: n.req,
        res,
        storage: this.storage,
      });
      ctx._logger = (msg) => console.log(`[${op}] ${msg}`);
      const hook = HOOK_BY_OP[op];
      if (hook && this.config.functions && this.config.functions.enabled) {
        await runHooks(this.config.functions.hooks, hook, ctx);
        if (ctx.response) {
          this._sendResponse(res, ctx.response.status, ctx.response.headers || {}, ctx.response.body || '');
          this._recordStatus(res.statusCode);
          return;
        }
      }
      await this._execute(n, op, res);
      this._recordStatus(res.statusCode);
    } catch (e) {
      await this._handleError(req, res, e);
    }
  }

  _authorize(n) {
    return verifyRequest(n, this._provider(), { anonymous: !!this.config.auth.anonymous });
  }

  // Evaluate the bucket policy (if any) against this request. An explicit
  // Deny, or an anonymous principal not granted by the policy, is rejected.
  async _enforcePolicy(n, op) {
    const bucket = n.segments[0] || '';
    const action = OP_ACTIONS[op];
    if (!bucket || !action) return;
    const policy = await this.storage.getBucketPolicy(bucket).catch(() => null);
    if (!policy) return;
    const key = n.segments.slice(1).join('/');
    const resource = key ? `arn:aws:s3:::${bucket}/${key}` : `arn:aws:s3:::${bucket}`;
    const decision = evaluatePolicy(policy, {
      principal: (n._identity && n._identity.accessKey) || null,
      action,
      resource,
    });
    if (decision === 'deny') {
      throw new S3Error('AccessDenied', 'Access Denied by bucket policy', 403);
    }
  }

  _recordOp(op) {
    this.metrics.byOperation.set(op, (this.metrics.byOperation.get(op) || 0) + 1);
  }
  _recordStatus(status) {
    this.metrics.byStatus.set(status, (this.metrics.byStatus.get(status) || 0) + 1);
  }

  _dispatch(n) {
    const { method, segments, queryParams: q } = n;
    const bucket = segments[0] || '';
    const key = segments.slice(1).join('/');
    if (!bucket) {
      if (method === 'GET') return 'ListBuckets';
      throw new S3Error('MethodNotAllowed', 'The specified method is not allowed against this resource.', 405);
    }
    if (!key) {
      switch (method) {
        case 'GET':
          if ('location' in q) return 'GetBucketLocation';
          if ('versioning' in q) return 'GetBucketVersioning';
          if ('tagging' in q) return 'GetBucketTagging';
          if ('policy' in q) return 'GetBucketPolicy';
          if ('lifecycle' in q) return 'GetBucketLifecycle';
          if ('uploads' in q) return 'ListMultipartUploads';
          if ('versions' in q) return 'ListObjectVersions';
          if (q['list-type'] === '2') return 'ListObjectsV2';
          return 'ListObjects';
        case 'PUT':
          if ('versioning' in q) return 'SetBucketVersioning';
          if ('tagging' in q) return 'PutBucketTagging';
          if ('policy' in q) return 'PutBucketPolicy';
          if ('lifecycle' in q) return 'PutBucketLifecycle';
          return 'CreateBucket';
        case 'HEAD':
          return 'HeadBucket';
        case 'DELETE':
          if ('tagging' in q) return 'DeleteBucketTagging';
          if ('policy' in q) return 'DeleteBucketPolicy';
          if ('lifecycle' in q) return 'DeleteBucketLifecycle';
          return 'DeleteBucket';
        case 'POST':
          if ('delete' in q) return 'DeleteObjects';
          if ('uploads' in q) return 'CreateMultipartUpload';
          if ('versioning' in q) return 'SetBucketVersioning';
          throw new S3Error('MethodNotAllowed', 'The specified method is not allowed against this resource.', 405);
        default:
          throw new S3Error('MethodNotAllowed', 'The specified method is not allowed against this resource.', 405);
      }
    }
    switch (method) {
      case 'GET':
        if ('uploadId' in q) return 'ListParts';
        if ('tagging' in q) return 'GetObjectTagging';
        return 'GetObject';
      case 'PUT':
        if ('uploadId' in q && 'partNumber' in q) return 'UploadPart';
        if ('tagging' in q) return 'PutObjectTagging';
        if (n.headers['x-amz-copy-source']) return 'CopyObject';
        return 'PutObject';
      case 'HEAD':
        return 'HeadObject';
      case 'DELETE':
        if ('uploadId' in q) return 'AbortMultipartUpload';
        if ('tagging' in q) return 'DeleteObjectTagging';
        return 'DeleteObject';
      case 'POST':
        if ('uploads' in q) return 'CreateMultipartUpload';
        if ('uploadId' in q) return 'CompleteMultipartUpload';
        throw new S3Error('MethodNotAllowed', 'The specified method is not allowed against this resource.', 405);
      default:
        throw new S3Error('MethodNotAllowed', 'The specified method is not allowed against this resource.', 405);
    }
  }

  async _execute(n, op, res) {
    const { segments, queryParams: q, req } = n;
    const bucket = segments[0];
    const key = segments.slice(1).join('/');
    res.setHeader('x-amz-request-id', crypto.randomBytes(8).toString('hex'));
    res.setHeader('x-amz-id-2', crypto.randomBytes(16).toString('hex'));
    res.setHeader('Server', 'vs3-neo/' + VERSION);

    switch (op) {
      case 'ListBuckets':
        return this._listBuckets(res);
      case 'CreateBucket':
        return this._createBucket(res, bucket);
      case 'HeadBucket':
        return this._headBucket(res, bucket);
      case 'DeleteBucket':
        return this._deleteBucket(res, bucket);
      case 'GetBucketLocation':
        return this._getBucketLocation(res, bucket);
      case 'GetBucketVersioning':
        return this._getBucketVersioning(res, bucket);
      case 'SetBucketVersioning':
        return this._setBucketVersioning(res, req, bucket);
      case 'ListObjects':
        return this._listObjects(res, bucket, q, false);
      case 'ListObjectsV2':
        return this._listObjects(res, bucket, q, true);
      case 'ListObjectVersions':
        return this._listObjectVersions(res, bucket, q);
      case 'PutObject':
        return this._putObject(res, req, bucket, key, q);
      case 'GetObject':
        return this._getObject(res, req, bucket, key, q);
      case 'HeadObject':
        return this._headObject(res, bucket, key, q);
      case 'DeleteObject':
        return this._deleteObject(res, bucket, key, q);
      case 'DeleteObjects':
        return this._deleteObjects(res, req, bucket);
      case 'CopyObject':
        return this._copyObject(res, req, bucket, key);
      case 'CreateMultipartUpload':
        return this._createMultipartUpload(res, req, bucket, key);
      case 'UploadPart':
        return this._uploadPart(res, req, bucket, key, q);
      case 'CompleteMultipartUpload':
        return this._completeMultipartUpload(res, req, bucket, key, q);
      case 'AbortMultipartUpload':
        return this._abortMultipartUpload(res, bucket, key, q);
      case 'ListParts':
        return this._listParts(res, bucket, key, q);
      case 'ListMultipartUploads':
        return this._listMultipartUploads(res, bucket);
      case 'GetObjectTagging':
        return this._getObjectTagging(res, bucket, key, q);
      case 'PutObjectTagging':
        return this._putObjectTagging(res, req, bucket, key, q);
      case 'DeleteObjectTagging':
        return this._deleteObjectTagging(res, bucket, key, q);
      case 'GetBucketTagging':
        return this._getBucketTagging(res, bucket);
      case 'PutBucketTagging':
        return this._putBucketTagging(res, req, bucket);
      case 'DeleteBucketTagging':
        return this._deleteBucketTagging(res, bucket);
      case 'GetBucketPolicy':
        return this._getBucketPolicy(res, bucket);
      case 'PutBucketPolicy':
        return this._putBucketPolicy(res, req, bucket);
      case 'DeleteBucketPolicy':
        return this._deleteBucketPolicy(res, bucket);
      case 'GetBucketLifecycle':
        return this._getBucketLifecycle(res, bucket);
      case 'PutBucketLifecycle':
        return this._putBucketLifecycle(res, req, bucket);
      case 'DeleteBucketLifecycle':
        return this._deleteBucketLifecycle(res, bucket);
      case 'NotImplemented':
        throw new S3Error('NotImplemented', 'A header you provided implies functionality that is not implemented.', 501);
      default:
        throw new S3Error('InternalError', 'Unknown operation', 500);
    }
  }

  // ---- Service ----
  async _listBuckets(res) {
    const buckets = await this.storage.listBuckets();
    this._sendXml(res, 200, xml.listBucketsXml(buckets));
  }

  // ---- Bucket ----
  async _createBucket(res, bucket) {
    await this.storage.createBucket(bucket);
    if (this.config.versioning && this.config.versioning.default) {
      await this.storage.setVersioning(bucket, 'Enabled');
    }
    res.setHeader('Location', '/' + bucket);
    this._sendResponse(res, 200, {}, '');
  }

  async _headBucket(res, bucket) {
    const exists = await this.storage.bucketExists(bucket);
    if (!exists) throw new S3Error('NotFound', 'Not Found', 404, '/' + bucket);
    this._sendResponse(res, 200, {}, '');
  }

  async _deleteBucket(res, bucket) {
    await this.storage.deleteBucket(bucket);
    this._sendResponse(res, 204, {}, '');
  }

  async _getBucketLocation(res, bucket) {
    const exists = await this.storage.bucketExists(bucket);
    if (!exists) throw new S3Error('NoSuchBucket', 'The specified bucket does not exist', 404);
    this._sendXml(res, 200, xml.locationXml(this.region));
  }

  async _getBucketVersioning(res, bucket) {
    const status = await this.storage.getVersioning(bucket);
    this._sendXml(res, 200, xml.versioningXml(status));
  }

  async _setBucketVersioning(res, req, bucket) {
    const body = await readBody(req);
    const status = extractXmlTag(body, 'Status') || '';
    await this.storage.setVersioning(bucket, status);
    this._sendResponse(res, 200, {}, '');
  }

  async _listObjects(res, bucket, q, v2) {
    const prefix = q['prefix'] || '';
    const delimiter = q['delimiter'] || '';
    const maxKeys = Math.min(parseInt(q['max-keys'] || '1000', 10) || 1000, 1000);
    const marker = v2 ? q['continuation-token'] || '' : q['marker'] || '';
    const result = await this.storage.listObjects(bucket, { prefix, delimiter, marker, maxKeys });
    const common = { bucket, prefix, delimiter, maxKeys, objects: result.objects, commonPrefixes: result.commonPrefixes, truncated: result.truncated };
    if (v2) {
      this._sendXml(
        res,
        200,
        xml.listObjectsV2Xml({
          ...common,
          keyCount: result.keyCount,
          continuationToken: q['continuation-token'],
          startAfter: q['start-after'],
          nextContinuationToken: result.truncated ? result.nextMarker : '',
          encodingType: q['encoding-type'],
        }),
      );
    } else {
      this._sendXml(
        res,
        200,
        xml.listObjectsV1Xml({
          ...common,
          marker: q['marker'] || '',
          nextMarker: result.truncated ? result.nextMarker : '',
          encodingType: q['encoding-type'],
        }),
      );
    }
  }

  async _listObjectVersions(res, bucket, q) {
    const prefix = q['prefix'] || '';
    const delimiter = q['delimiter'] || '';
    const maxKeys = Math.min(parseInt(q['max-keys'] || '1000', 10) || 1000, 1000);
    const result = await this.storage.listObjectVersions(bucket, {
      prefix,
      delimiter,
      maxKeys,
      keyMarker: q['key-marker'] || '',
      versionIdMarker: q['version-id-marker'] || '',
    });
    this._sendXml(
      res,
      200,
      xml.listObjectVersionsXml({
        bucket,
        prefix,
        delimiter,
        maxKeys,
        truncated: result.truncated,
        keyMarker: q['key-marker'] || '',
        versionIdMarker: q['version-id-marker'] || '',
        nextKeyMarker: result.nextKeyMarker,
        nextVersionIdMarker: result.nextVersionIdMarker,
        versions: result.versions,
        deleteMarkers: result.deleteMarkers,
        commonPrefixes: result.commonPrefixes,
      }),
    );
  }

  // ---- Object ----
  async _putObject(res, req, bucket, key, q) {
    const contentType = req.headers['content-type'] || 'application/octet-stream';
    const userMeta = extractUserMeta(req.headers);
    const md5Header = req.headers['content-md5'];
    const size = parseInt(req.headers['content-length'] || '0', 10);
    const sse = parseSseHeader(req.headers[SSE_HEADER]);
    const info = await this.storage.putObject(bucket, key, req, size, { contentType, userMeta, sse });
    this.metrics.bytesIn += size;
    if (md5Header) {
      const expected = Buffer.from(md5Header, 'base64').toString('hex');
      if (info.etag !== expected) {
        throw new S3Error('BadDigest', 'The Content-MD5 you specified did not match what we received.', 400);
      }
    }
    res.setHeader('ETag', quoteEtag(info.etag));
    if (info.sse) res.setHeader(SSE_HEADER, info.sse);
    if (info.versionId && info.versionId !== 'null') {
      res.setHeader('x-amz-version-id', info.versionId);
    }
    this._sendResponse(res, 200, {}, '');
  }

  async _getObject(res, req, bucket, key, q) {
    const versionId = q['versionId'] || q['version-id'] || '';
    const head = await this.storage.headObject(bucket, key, versionId);
    const range = parseRange(req.headers['range']);
    let start = -1;
    let length = -1;
    let status = 200;
    if (range) {
      let s;
      let e;
      if (range.suffix !== undefined) {
        s = Math.max(0, head.size - range.suffix);
        e = head.size - 1;
      } else {
        s = range.start;
        e = range.end === undefined ? head.size - 1 : range.end;
      }
      if (s > e || s >= head.size) {
        const err = new S3Error('InvalidRange', 'The requested range is not satisfiable', 416);
        err.contentRange = `bytes */${head.size}`;
        throw err;
      }
      start = s;
      length = e - s + 1;
      status = 206;
    }
    const result = await this.storage.getObject(bucket, key, versionId, start >= 0 ? { start, end: start + length - 1 } : null);
    const outObj = status === 206 ? { ...head, size: length } : head;
    this._setObjectHeaders(res, outObj);
    if (status === 206) {
      res.setHeader('Content-Range', `bytes ${start}-${start + length - 1}/${head.size}`);
    }
    res.statusCode = status;
    this.metrics.bytesOut += outObj.size;
    result.stream.pipe(res);
  }

  async _headObject(res, bucket, key, q) {
    const versionId = q['versionId'] || q['version-id'] || '';
    const o = await this.storage.headObject(bucket, key, versionId);
    this._setObjectHeaders(res, o);
    this._sendResponse(res, 200, {}, '');
  }

  _setObjectHeaders(res, o) {
    res.setHeader('Content-Type', o.contentType || 'application/octet-stream');
    res.setHeader('Content-Length', String(o.size));
    res.setHeader('ETag', quoteEtag(o.etag));
    res.setHeader('Last-Modified', httpDate(o.lastModified));
    res.setHeader('Accept-Ranges', 'bytes');
    if (o.sse) res.setHeader(SSE_HEADER, o.sse);
    if (o.versionId && o.versionId !== 'null') {
      res.setHeader('x-amz-version-id', o.versionId);
    }
    for (const [k, v] of Object.entries(o.userMeta || {})) {
      res.setHeader(k, v);
    }
  }

  async _deleteObject(res, bucket, key, q) {
    const versionId = q['versionId'] || q['version-id'] || '';
    const info = await this.storage.deleteObject(bucket, key, versionId);
    if (info && info.versionId && info.versionId !== 'null') {
      res.setHeader('x-amz-version-id', info.versionId);
      if (info.isDeleteMarker) res.setHeader('x-amz-delete-marker', 'true');
    }
    this._sendResponse(res, 204, {}, '');
  }

  async _deleteObjects(res, req, bucket) {
    const body = await readBody(req);
    const entries = extractDeleteEntries(body);
    const results = [];
    for (const e of entries) {
      try {
        const info = await this.storage.deleteObject(bucket, e.key, e.versionId || '');
        results.push({
          key: e.key,
          versionId: e.versionId,
          deleteMarker: info ? !!info.isDeleteMarker : false,
          deleteMarkerVersionId: info && info.isDeleteMarker ? info.versionId : undefined,
        });
      } catch (err) {
        const se = toS3Error(err);
        results.push({ key: e.key, versionId: e.versionId, error: se });
      }
    }
    this._sendXml(res, 200, xml.deleteObjectsXml(results));
  }

  async _copyObject(res, req, bucket, key) {
    const srcHeader = req.headers['x-amz-copy-source'];
    if (!srcHeader) throw new S3Error('InvalidArgument', 'x-amz-copy-source header missing', 400);
    const src = srcHeader.startsWith('/') ? srcHeader.slice(1) : srcHeader;
    const qIdx = src.indexOf('?');
    const srcPath = qIdx >= 0 ? src.slice(0, qIdx) : src;
    const srcParams = qIdx >= 0 ? new URLSearchParams(src.slice(qIdx + 1)) : new URLSearchParams();
    const srcVersion = srcParams.get('versionId') || '';
    void srcVersion;
    const slash = srcPath.indexOf('/');
    if (slash < 0) throw new S3Error('InvalidArgument', 'Invalid copy source', 400);
    const srcBucket = srcPath.slice(0, slash);
    const srcKey = srcPath.slice(slash + 1);
    // Propagate encryption: honor an explicit destination header, otherwise
    // keep the source object's encryption.
    let sse = parseSseHeader(req.headers[SSE_HEADER]);
    if (!sse) {
      const srcHead = await this.storage.headObject(srcBucket, srcKey, srcVersion).catch(() => null);
      if (srcHead && srcHead.sse) sse = srcHead.sse;
    }
    const opts = {
      contentType: req.headers['content-type'] || '',
      userMeta: extractUserMeta(req.headers),
      sse,
    };
    const result = await this.storage.copyObject(srcBucket, srcKey, bucket, key, opts);
    this._sendXml(res, 200, xml.copyObjectXml(result.etag, result.lastModified));
  }

  // ---- Tagging ----
  async _getObjectTagging(res, bucket, key, q) {
    const versionId = q['versionId'] || q['version-id'] || '';
    const tags = await this.storage.getObjectTagging(bucket, key, versionId);
    this._sendXml(res, 200, xml.taggingXml(tags));
  }

  async _putObjectTagging(res, req, bucket, key, q) {
    const versionId = q['versionId'] || q['version-id'] || '';
    const body = await readBody(req);
    const tags = extractTags(body);
    await this.storage.setObjectTagging(bucket, key, tags, versionId);
    this._sendResponse(res, 200, {}, '');
  }

  async _deleteObjectTagging(res, bucket, key, q) {
    const versionId = q['versionId'] || q['version-id'] || '';
    await this.storage.deleteObjectTagging(bucket, key, versionId);
    this._sendResponse(res, 204, {}, '');
  }

  async _getBucketTagging(res, bucket) {
    const tags = await this.storage.getBucketTagging(bucket);
    if (!tags || tags.length === 0) {
      throw new S3Error('NoSuchTagSet', 'The TagSet does not exist', 404);
    }
    this._sendXml(res, 200, xml.taggingXml(tags));
  }

  async _putBucketTagging(res, req, bucket) {
    const body = await readBody(req);
    const tags = extractTags(body);
    await this.storage.setBucketTagging(bucket, tags);
    this._sendResponse(res, 200, {}, '');
  }

  async _deleteBucketTagging(res, bucket) {
    await this.storage.deleteBucketTagging(bucket);
    this._sendResponse(res, 204, {}, '');
  }

  // ---- Policy ----
  async _getBucketPolicy(res, bucket) {
    const policy = await this.storage.getBucketPolicy(bucket);
    if (!policy) {
      throw new S3Error('NoSuchBucketPolicy', 'The bucket policy does not exist', 404);
    }
    this._sendResponse(res, 200, { 'Content-Type': 'application/json' }, policy);
  }

  async _putBucketPolicy(res, req, bucket) {
    const body = await readBody(req);
    try {
      JSON.parse(body);
    } catch {
      throw new S3Error('MalformedPolicy', 'Policy has invalid JSON', 400);
    }
    await this.storage.setBucketPolicy(bucket, body);
    this._sendResponse(res, 204, {}, '');
  }

  async _deleteBucketPolicy(res, bucket) {
    await this.storage.deleteBucketPolicy(bucket);
    this._sendResponse(res, 204, {}, '');
  }

  // ---- Lifecycle ----
  async _getBucketLifecycle(res, bucket) {
    const rules = await this.storage.getLifecycle(bucket);
    if (!rules || rules.length === 0) {
      throw new S3Error('NoSuchLifecycleConfiguration', 'The lifecycle configuration does not exist', 404);
    }
    this._sendXml(res, 200, xml.lifecycleXml(rules));
  }

  async _putBucketLifecycle(res, req, bucket) {
    const body = await readBody(req);
    const rules = extractLifecycleRules(body);
    await this.storage.setLifecycle(bucket, rules);
    this._sendResponse(res, 200, {}, '');
  }

  async _deleteBucketLifecycle(res, bucket) {
    await this.storage.deleteLifecycle(bucket);
    this._sendResponse(res, 204, {}, '');
  }

  // ---- Multipart ----
  async _createMultipartUpload(res, req, bucket, key) {
    const contentType = req.headers['content-type'] || 'application/octet-stream';
    const userMeta = extractUserMeta(req.headers);
    const sse = parseSseHeader(req.headers[SSE_HEADER]);
    const uploadId = await this.storage.createMultipartUpload(bucket, key, { contentType, userMeta, sse });
    this._sendXml(res, 200, xml.initMultipartXml(bucket, key, uploadId));
  }

  async _uploadPart(res, req, bucket, key, q) {
    const uploadId = q['uploadId'];
    const partNumber = parseInt(q['partNumber'] || '0', 10);
    const size = parseInt(req.headers['content-length'] || '0', 10);
    const rec = await this.storage.uploadPart(bucket, key, uploadId, partNumber, req, size);
    this.metrics.bytesIn += size;
    res.setHeader('ETag', quoteEtag(rec.etag));
    this._sendResponse(res, 200, {}, '');
  }

  async _completeMultipartUpload(res, req, bucket, key, q) {
    const uploadId = q['uploadId'];
    const body = await readBody(req);
    const parts = extractCompleteParts(body);
    const info = await this.storage.completeMultipartUpload(bucket, key, uploadId, parts);
    this._sendXml(res, 200, xml.completeMultipartXml(bucket, key, uploadId, info.etag));
  }

  async _abortMultipartUpload(res, bucket, key, q) {
    const uploadId = q['uploadId'];
    await this.storage.abortMultipartUpload(bucket, key, uploadId);
    this._sendResponse(res, 204, {}, '');
  }

  async _listParts(res, bucket, key, q) {
    const uploadId = q['uploadId'];
    const parts = await this.storage.listParts(bucket, key, uploadId);
    const initiated = parts.length ? parts[0].lastModified : new Date();
    this._sendXml(res, 200, xml.listPartsXml(bucket, key, uploadId, parts, initiated));
  }

  async _listMultipartUploads(res, bucket) {
    const uploads = await this.storage.listMultipartUploads(bucket);
    this._sendXml(res, 200, xml.listMultipartUploadsXml(bucket, uploads));
  }

  // ---- response helpers ----
  _sendXml(res, status, body) {
    this._sendResponse(res, status, { 'Content-Type': 'application/xml' }, body);
  }

  _sendResponse(res, status, headers = {}, body = '') {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.statusCode = status;
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      res.setHeader('Content-Length', buf.length);
      res.end(buf);
    } else {
      res.end(body || '');
    }
  }

  async _handleError(req, res, err) {
    this.metrics.errors++;
    const se = toS3Error(err);
    this._recordStatus(se.status);
    if (err && err.contentRange) res.setHeader('Content-Range', err.contentRange);
    const { status, body } = errorXml(se, req.url, '');
    this._sendXml(res, status, body);
  }

  // ---- internal endpoints (__ namespace) ----
  // Paths look like /__health, /__info, /__metrics, /__presign,
  // /__functions and /__function/<name>. The first segment holds the
  // endpoint name with the "__" prefix stripped.
  async _handleInternal(req, res, n) {
    const sub = n.segments[0].slice(2);
    switch (sub) {
      case 'health':
        this._sendJson(res, 200, {
          status: 'ok',
          uptime: Math.floor((Date.now() - this.startTime) / 1000),
        });
        return;
      case 'info':
        this._sendJson(res, 200, {
          name: 'vs3-neo',
          version: VERSION,
          storage: this.storage.name,
          functions: listFunctions(),
          region: this.region,
          anonymous: !!this.config.auth.anonymous,
          backends: ['disk', 'memory', 'custom-mirror'],
        });
        return;
      case 'metrics':
        if (this.config.metrics && this.config.metrics.enabled === false) {
          throw new S3Error('AccessDenied', 'Metrics disabled', 403);
        }
        this._sendText(res, 200, this._renderMetrics());
        return;
      case 'presign': {
        const identity = verifyRequest(n, this._provider(), { anonymous: !!this.config.auth.anonymous });
        const users = this.config.auth.users || [];
        const user = users.find((u) => u.accessKey === identity.accessKey) || users[0];
        if (!user) throw new S3Error('AccessDenied', 'No user configured', 403);
        const body = JSON.parse(await readBody(req));
        const method = (body.method || 'GET').toUpperCase();
        const bucket = body.bucket;
        const key = body.key || '';
        const expires = body.expires || 3600;
        const query = body.query || {};
        const path = '/' + bucket + (key ? '/' + key : '');
        const presigner = new Presigner({
          accessKey: user.accessKey,
          secretKey: user.secretKey,
          region: this.region,
        });
        const url = presigner.presign(method, req.headers.host || 'localhost', path, query, expires);
        this._sendJson(res, 200, { url, method, path, expires });
        return;
      }
      case 'function': {
        const name = n.segments[1];
        if (!name) throw new S3Error('InvalidArgument', 'function name required', 400);
        const fn = getFunction(name);
        if (!fn) throw new S3Error('NoSuchKey', `Function ${name} not found`, 404);
        const ctx = new FunctionContext({
          operation: 'Invoke',
          method: req.method,
          bucket: '',
          key: name,
          headers: req.headers,
          query: n.queryParams,
          req,
          res,
          storage: this.storage,
        });
        await fn.handle(ctx);
        if (ctx.response) {
          this._sendResponse(res, ctx.response.status, ctx.response.headers || {}, ctx.response.body || '');
        } else {
          this._sendJson(res, 200, { ok: true, function: name });
        }
        return;
      }
      case 'functions':
        this._sendJson(res, 200, { functions: listFunctions() });
        return;
      case 'lifecycle': {
        // Trigger lifecycle processing. Authenticated; optional ?bucket= filter.
        verifyRequest(n, this._provider(), { anonymous: !!this.config.auth.anonymous });
        const target = n.queryParams['bucket'] || '';
        const buckets = target
          ? [target]
          : (await this.storage.listBuckets()).map((b) => b.name);
        let removed = 0;
        for (const b of buckets) {
          removed += await this.storage.runLifecycle(b).catch(() => 0);
        }
        this._sendJson(res, 200, { buckets: buckets.length, removed });
        return;
      }
      default:
        throw new S3Error('NoSuchKey', `Unknown internal endpoint /__${sub}`, 404);
    }
  }

  _renderMetrics() {
    const lines = [
      '# HELP vs3_requests_total Total HTTP requests.',
      '# TYPE vs3_requests_total counter',
      `vs3_requests_total ${this.metrics.requests}`,
      `vs3_errors_total ${this.metrics.errors}`,
      `vs3_bytes_in_total ${this.metrics.bytesIn}`,
      `vs3_bytes_out_total ${this.metrics.bytesOut}`,
      '# TYPE vs3_requests_by_operation counter',
    ];
    for (const [op, c] of this.metrics.byOperation) {
      lines.push(`vs3_requests_by_operation{operation="${op}"} ${c}`);
    }
    for (const [st, c] of this.metrics.byStatus) {
      lines.push(`vs3_requests_by_status{status="${st}"} ${c}`);
    }
    lines.push(`vs3_uptime_seconds ${Math.floor((Date.now() - this.startTime) / 1000)}`);
    return lines.join('\n') + '\n';
  }

  _sendJson(res, status, obj) {
    this._sendResponse(res, status, { 'Content-Type': 'application/json' }, JSON.stringify(obj, null, 2));
  }
  _sendText(res, status, text) {
    this._sendResponse(res, status, { 'Content-Type': 'text/plain; charset=utf-8' }, text);
  }
}

// ---- module-level helpers ----

function parseQueryPairs(rawQuery) {
  if (!rawQuery) return [];
  const pairs = [];
  for (const pair of rawQuery.split('&')) {
    if (pair === '') continue;
    const idx = pair.indexOf('=');
    if (idx < 0) pairs.push({ name: pair, value: '' });
    else pairs.push({ name: pair.slice(0, idx), value: pair.slice(idx + 1) });
  }
  return pairs;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function extractUserMeta(headers) {
  const meta = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith('x-amz-meta-')) meta[k] = v;
  }
  return meta;
}

// Parse "bytes=start-end" (also "bytes=start-", "bytes=-suffix").
function parseRange(rangeHeader) {
  if (!rangeHeader) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') return { suffix: parseInt(m[2], 10) };
  return { start: parseInt(m[1], 10), end: m[2] === '' ? undefined : parseInt(m[2], 10) };
}

function quoteEtag(etag) {
  if (typeof etag === 'string' && etag.startsWith('"')) return etag;
  return `"${etag}"`;
}

function extractXmlTag(xml, tag) {
  const m = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`).exec(xml || '');
  return m ? m[1] : '';
}

function extractDeleteEntries(xml) {
  const entries = [];
  const re = /<Object>([\s\S]*?)<\/Object>/g;
  let m;
  while ((m = re.exec(xml || '')) !== null) {
    entries.push({ key: extractXmlTag(m[1], 'Key'), versionId: extractXmlTag(m[1], 'VersionId') });
  }
  return entries;
}

function extractCompleteParts(xml) {
  const parts = [];
  const re = /<Part>([\s\S]*?)<\/Part>/g;
  let m;
  while ((m = re.exec(xml || '')) !== null) {
    const block = m[1];
    const partNumber = parseInt(extractXmlTag(block, 'PartNumber'), 10);
    const etag = (extractXmlTag(block, 'ETag') || '').replace(/^"|"$/g, '');
    if (Number.isFinite(partNumber)) parts.push({ partNumber, etag });
  }
  return parts;
}

// Validate/normalize the SSE request header: only "AES256" is supported.
function parseSseHeader(header) {
  if (!header) return '';
  return String(header).trim() === SSE_ALGORITHM ? SSE_ALGORITHM : '';
}

// Parse <Tagging><TagSet><Tag><Key>..</Key><Value>..</Value></Tag>...</TagSet></Tagging>.
function extractTags(xmlStr) {
  const tags = [];
  const re = /<Tag>([\s\S]*?)<\/Tag>/g;
  let m;
  while ((m = re.exec(xmlStr || '')) !== null) {
    const block = m[1];
    tags.push({ Key: extractXmlTag(block, 'Key'), Value: extractXmlTag(block, 'Value') });
  }
  return tags;
}

// Parse <LifecycleConfiguration><Rule>...</Rule>...</LifecycleConfiguration>.
function extractLifecycleRules(xmlStr) {
  const rules = [];
  const re = /<Rule>([\s\S]*?)<\/Rule>/g;
  let m;
  while ((m = re.exec(xmlStr || '')) !== null) {
    const block = m[1];
    const rule = {
      id: extractXmlTag(block, 'ID') || undefined,
      prefix: extractXmlTag(block, 'Prefix') || undefined,
      status: extractXmlTag(block, 'Status') || 'Enabled',
    };
    const expDays = extractNestedXmlTag(block, 'Expiration', 'Days');
    if (expDays) rule.expiration = { days: parseInt(expDays, 10) };
    const abortDays = extractNestedXmlTag(block, 'AbortIncompleteMultipartUpload', 'DaysAfterInitiation');
    if (abortDays) rule.abort = { days: parseInt(abortDays, 10) };
    rules.push(rule);
  }
  return rules;
}

function extractNestedXmlTag(xmlStr, outer, inner) {
  const re = new RegExp(`<${outer}>[\\s\\S]*?<${inner}>([^<]*)</${inner}>[\\s\\S]*?</${outer}>`);
  const m = re.exec(xmlStr || '');
  return m ? m[1] : '';
}
