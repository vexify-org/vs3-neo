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

import { S3Error } from '../api/errors.js';

// ---- S3-style error helpers shared by backends ----
export const errNoSuchBucket = () => new S3Error('NoSuchBucket', 'The specified bucket does not exist', 404);
export const errNoSuchKey = () => new S3Error('NoSuchKey', 'The specified key does not exist', 404);
export const errBucketAlreadyExists = () =>
  new S3Error('BucketAlreadyOwnedByYou', 'Your previous request to create the named bucket succeeded and you already own it.', 409);
export const errBucketNotEmpty = () =>
  new S3Error('BucketNotEmpty', 'The bucket you tried to delete is not empty', 409);
export const errNoSuchUpload = () => new S3Error('NoSuchUpload', 'The specified multipart upload does not exist', 404);
export const errInvalidPart = () => new S3Error('InvalidPart', 'One or more of the specified parts could not be found', 400);
export const errInvalidPartOrder = () =>
  new S3Error('InvalidPartOrder', 'The list of parts was not in ascending order', 400);
export const errInvalidBucketName = (name) =>
  new S3Error('InvalidBucketName', `The specified bucket is not valid: ${name}`, 400);
export const errInvalidArgument = (msg) => new S3Error('InvalidArgument', msg, 400);

// Bucket naming: 3-63 chars, lowercase letters/digits/dots/hyphens,
// must begin and end with a letter or digit, no adjacent dots.
export function validateBucketName(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]$/.test(name)) {
    throw errInvalidBucketName(name);
  }
  if (name.includes('..') || name.includes('.-') || name.includes('-.')) {
    throw errInvalidBucketName(name);
  }
}

export function randomId() {
  return randomHex(16);
}

import crypto from 'node:crypto';
export function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

// ---- Storage interface ----
// A backend implements all methods of Storage. Unimplemented methods throw
// NotImplemented so custom backends can opt in incrementally.
export class Storage {
  get name() {
    return 'base';
  }

  async init() {}

  async createBucket(bucket) {
    throw notImplemented('createBucket');
  }
  async deleteBucket(bucket) {
    throw notImplemented('deleteBucket');
  }
  async listBuckets() {
    throw notImplemented('listBuckets');
  }
  async bucketExists(bucket) {
    throw notImplemented('bucketExists');
  }
  async getVersioning(bucket) {
    throw notImplemented('getVersioning');
  }
  async setVersioning(bucket, status) {
    throw notImplemented('setVersioning');
  }
  async putObject(bucket, key, stream, size, opts) {
    throw notImplemented('putObject');
  }
  async getObject(bucket, key, versionId, range) {
    throw notImplemented('getObject');
  }
  async headObject(bucket, key, versionId) {
    throw notImplemented('headObject');
  }
  async deleteObject(bucket, key, versionId) {
    throw notImplemented('deleteObject');
  }
  async copyObject(srcBucket, srcKey, dstBucket, dstKey, opts) {
    throw notImplemented('copyObject');
  }
  async listObjects(bucket, params) {
    throw notImplemented('listObjects');
  }
  async listObjectVersions(bucket, params) {
    throw notImplemented('listObjectVersions');
  }
  async createMultipartUpload(bucket, key, opts) {
    throw notImplemented('createMultipartUpload');
  }
  async uploadPart(bucket, key, uploadId, partNumber, stream, size) {
    throw notImplemented('uploadPart');
  }
  async completeMultipartUpload(bucket, key, uploadId, parts) {
    throw notImplemented('completeMultipartUpload');
  }
  async abortMultipartUpload(bucket, key, uploadId) {
    throw notImplemented('abortMultipartUpload');
  }
  async listParts(bucket, key, uploadId) {
    throw notImplemented('listParts');
  }
  async listMultipartUploads(bucket) {
    throw notImplemented('listMultipartUploads');
  }
  // ---- tagging ----
  async getObjectTagging(bucket, key, versionId) {
    throw notImplemented('getObjectTagging');
  }
  async setObjectTagging(bucket, key, tags, versionId) {
    throw notImplemented('setObjectTagging');
  }
  async deleteObjectTagging(bucket, key, versionId) {
    throw notImplemented('deleteObjectTagging');
  }
  async getBucketTagging(bucket) {
    throw notImplemented('getBucketTagging');
  }
  async setBucketTagging(bucket, tags) {
    throw notImplemented('setBucketTagging');
  }
  async deleteBucketTagging(bucket) {
    throw notImplemented('deleteBucketTagging');
  }
  // ---- policy ----
  async getBucketPolicy(bucket) {
    throw notImplemented('getBucketPolicy');
  }
  async setBucketPolicy(bucket, policy) {
    throw notImplemented('setBucketPolicy');
  }
  async deleteBucketPolicy(bucket) {
    throw notImplemented('deleteBucketPolicy');
  }
  // ---- lifecycle ----
  async getLifecycle(bucket) {
    throw notImplemented('getLifecycle');
  }
  async setLifecycle(bucket, rules) {
    throw notImplemented('setLifecycle');
  }
  async deleteLifecycle(bucket) {
    throw notImplemented('deleteLifecycle');
  }
  async runLifecycle(bucket) {
    return 0;
  }
  // ---- CORS ----
  async getBucketCors(bucket) {
    throw notImplemented('getBucketCors');
  }
  async setBucketCors(bucket, rules) {
    throw notImplemented('setBucketCors');
  }
  async deleteBucketCors(bucket) {
    throw notImplemented('deleteBucketCors');
  }
}

function notImplemented(method) {
  return new S3Error('NotImplemented', `Storage backend does not implement ${method}`, 501);
}

// ---- backend registry ----
const registry = new Map();

export function registerBackend(name, factory) {
  if (!name || typeof factory !== 'function') {
    throw new Error('storage: registerBackend requires (name, factory)');
  }
  if (registry.has(name)) {
    throw new Error(`storage: backend "${name}" already registered`);
  }
  registry.set(name, factory);
}

export function createBackend(name, cfg) {
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(`storage: unknown backend "${name}" (available: ${[...registry.keys()].join(', ')})`);
  }
  return factory(cfg);
}

export function availableBackends() {
  return [...registry.keys()];
}

// ---- async keyed mutex (serialize mutations of one logical key) ----
const keyLocks = new Map();

export async function withKeyLock(key, fn) {
  const prev = keyLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tail = prev.catch(() => {}).then(() => gate);
  keyLocks.set(key, tail);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (keyLocks.get(key) === tail) {
      keyLocks.delete(key);
    }
  }
}
