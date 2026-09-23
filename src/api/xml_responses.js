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

import { xmlDoc, el, rawEl, boolEl, timeEl, esc } from '../util/xml.js';

// ---- Service ----

export function listBucketsXml(buckets, ownerId = 'vs3-neo', ownerName = 'vs3-neo') {
  const inner =
    rawEl('Owner', el('ID', ownerId) + el('DisplayName', ownerName)) +
    rawEl(
      'Buckets',
      buckets
        .map((b) => rawEl('Bucket', timeEl('CreationDate', b.creationDate) + el('Name', b.name)))
        .join(''),
    );
  return xmlDoc('ListAllMyBucketsResult', inner);
}

// ---- Bucket ----

export function locationXml(region) {
  return xmlDoc('LocationConstraint', esc(region === 'us-east-1' ? '' : region));
}

export function versioningXml(status) {
  return xmlDoc('VersioningConfiguration', status ? el('Status', status) : '');
}

export function listObjectsV1Xml(res) {
  const inner =
    el('Name', res.bucket) +
    el('Prefix', res.prefix || '') +
    el('Marker', res.marker || '') +
    (res.nextMarker ? el('NextMarker', res.nextMarker) : '') +
    el('MaxKeys', String(res.maxKeys)) +
    el('Delimiter', res.delimiter || '') +
    (res.encodingType ? el('EncodingType', res.encodingType) : '') +
    boolEl('IsTruncated', res.truncated) +
    res.objects.map((o) => objectXml(o)).join('') +
    res.commonPrefixes.map((p) => rawEl('CommonPrefixes', el('Prefix', p))).join('');
  return xmlDoc('ListBucketResult', inner);
}

export function listObjectsV2Xml(res) {
  const inner =
    el('Name', res.bucket) +
    el('Prefix', res.prefix || '') +
    el('KeyCount', String(res.keyCount)) +
    el('MaxKeys', String(res.maxKeys)) +
    el('Delimiter', res.delimiter || '') +
    (res.encodingType ? el('EncodingType', res.encodingType) : '') +
    boolEl('IsTruncated', res.truncated) +
    (res.continuationToken ? el('ContinuationToken', res.continuationToken) : '') +
    (res.nextContinuationToken ? el('NextContinuationToken', res.nextContinuationToken) : '') +
    (res.startAfter ? el('StartAfter', res.startAfter) : '') +
    res.objects.map((o) => objectXml(o)).join('') +
    res.commonPrefixes.map((p) => rawEl('CommonPrefixes', el('Prefix', p))).join('');
  return xmlDoc('ListBucketResult', inner);
}

export function listObjectVersionsXml(res) {
  const inner =
    el('Name', res.bucket) +
    el('Prefix', res.prefix || '') +
    el('KeyMarker', res.keyMarker || '') +
    el('VersionIdMarker', res.versionIdMarker || '') +
    (res.nextKeyMarker ? el('NextKeyMarker', res.nextKeyMarker) : '') +
    (res.nextVersionIdMarker ? el('NextVersionIdMarker', res.nextVersionIdMarker) : '') +
    el('MaxKeys', String(res.maxKeys)) +
    el('Delimiter', res.delimiter || '') +
    boolEl('IsTruncated', res.truncated) +
    res.versions.map((o) => objectXml(o, 'Version', true)).join('') +
    res.deleteMarkers.map((o) => deleteMarkerXml(o)).join('') +
    res.commonPrefixes.map((p) => rawEl('CommonPrefixes', el('Prefix', p))).join('');
  return xmlDoc('ListVersionsResult', inner);
}

function objectXml(o, tag = 'Contents', withVersion = false) {
  return rawEl(
    tag,
    el('Key', o.key) +
      timeEl('LastModified', o.lastModified) +
      el('ETag', quoteEtag(o.etag)) +
      el('Size', String(o.size)) +
      el('StorageClass', o.storageClass || 'STANDARD') +
      (withVersion ? el('VersionId', o.versionId || 'null') : ''),
  );
}

function deleteMarkerXml(o) {
  return rawEl(
    'DeleteMarker',
    el('Key', o.key) +
      timeEl('LastModified', o.lastModified) +
      el('VersionId', o.versionId || 'null') +
      boolEl('IsLatest', o.isLatest === undefined ? true : o.isLatest),
  );
}

export function deleteObjectsXml(results) {
  const inner = results
    .map((r) => {
      if (r.error) {
        return rawEl(
          'Error',
          el('Key', r.key) +
            (r.versionId ? el('VersionId', r.versionId) : '') +
            el('Code', r.error.code) +
            el('Message', r.error.message || r.error.code),
        );
      }
      return rawEl(
        'Deleted',
        el('Key', r.key) + (r.versionId ? el('VersionId', r.versionId) : '') + boolEl('DeleteMarker', !!r.deleteMarker) + (r.deleteMarkerVersionId ? el('DeleteMarkerVersionId', r.deleteMarkerVersionId) : ''),
      );
    })
    .join('');
  return xmlDoc('DeleteResult', inner);
}

// ---- Multipart ----

export function initMultipartXml(bucket, key, uploadId) {
  const inner = el('Bucket', bucket) + el('Key', key) + el('UploadId', uploadId);
  return xmlDoc('InitiateMultipartUploadResult', inner);
}

export function uploadPartXml(etag) {
  return xmlDoc('CopyPartResult', el('ETag', quoteEtag(etag)));
}

export function completeMultipartXml(bucket, key, uploadId, etag) {
  const inner =
    el('Location', `/${bucket}/${key}`) +
    el('Bucket', bucket) +
    el('Key', key) +
    el('ETag', quoteEtag(etag));
  return xmlDoc('CompleteMultipartUploadResult', inner);
}

export function listPartsXml(bucket, key, uploadId, parts, initiated) {
  const inner =
    el('Bucket', bucket) +
    el('Key', key) +
    el('UploadId', uploadId) +
    el('StorageClass', 'STANDARD') +
    el('PartNumberMarker', '0') +
    el('NextPartNumberMarker', parts.length ? String(parts[parts.length - 1].partNumber) : '0') +
    el('MaxParts', '1000') +
    boolEl('IsTruncated', false) +
    rawEl('Initiator', el('ID', 'vs3-neo') + el('DisplayName', 'vs3-neo')) +
    rawEl('Owner', el('ID', 'vs3-neo') + el('DisplayName', 'vs3-neo')) +
    parts
      .map(
        (p) =>
          rawEl(
            'Part',
            el('PartNumber', String(p.partNumber)) +
              timeEl('LastModified', p.lastModified) +
              el('ETag', quoteEtag(p.etag)) +
              el('Size', String(p.size)),
          ),
      )
      .join('');
  return xmlDoc('ListPartsResult', inner);
}

export function listMultipartUploadsXml(bucket, uploads) {
  const inner =
    el('Bucket', bucket) +
    el('KeyMarker', '') +
    el('UploadIdMarker', '') +
    el('NextKeyMarker', '') +
    el('NextUploadIdMarker', '') +
    el('Delimiter', '') +
    el('Prefix', '') +
    el('MaxUploads', '1000') +
    boolEl('IsTruncated', false) +
    uploads
      .map(
        (u) =>
          rawEl(
            'Upload',
            el('Key', u.key) +
              el('UploadId', u.uploadId) +
              rawEl('Initiator', el('ID', 'vs3-neo') + el('DisplayName', 'vs3-neo')) +
              rawEl('Owner', el('ID', 'vs3-neo') + el('DisplayName', 'vs3-neo')) +
              el('StorageClass', 'STANDARD') +
              timeEl('Initiated', u.initiated),
          ),
      )
      .join('');
  return xmlDoc('ListMultipartUploadsResult', inner);
}

export function copyObjectXml(etag, lastModified) {
  const inner = timeEl('LastModified', lastModified) + el('ETag', quoteEtag(etag));
  return xmlDoc('CopyObjectResult', inner);
}

// ---- Tagging ----

export function taggingXml(tags) {
  const inner = rawEl(
    'TagSet',
    (tags || [])
      .map((t) => rawEl('Tag', el('Key', t.Key) + el('Value', t.Value)))
      .join(''),
  );
  return xmlDoc('Tagging', inner);
}

// ---- Lifecycle ----

export function lifecycleXml(rules) {
  const inner = (rules || [])
    .map((r) =>
      rawEl(
        'Rule',
        (r.id ? el('ID', r.id) : '') +
          (r.prefix ? rawEl('Filter', el('Prefix', r.prefix)) : '') +
          el('Status', r.status || 'Enabled') +
          (r.expiration && r.expiration.days !== undefined
            ? rawEl('Expiration', el('Days', String(r.expiration.days)))
            : '') +
          (r.abort && r.abort.days !== undefined
            ? rawEl('AbortIncompleteMultipartUpload', el('DaysAfterInitiation', String(r.abort.days)))
            : ''),
      ),
    )
    .join('');
  return xmlDoc('LifecycleConfiguration', inner);
}

// ---- CORS ----

export function corsXml(rules) {
  const inner = (rules || [])
    .map((r) =>
      rawEl(
        'CORSRule',
        (r.id ? el('ID', r.id) : '') +
          (r.allowedOrigins || []).map((o) => el('AllowedOrigin', o)).join('') +
          (r.allowedMethods || []).map((m) => el('AllowedMethod', m)).join('') +
          (r.allowedHeaders || []).map((h) => el('AllowedHeader', h)).join('') +
          (r.exposeHeaders || []).map((h) => el('ExposeHeader', h)).join('') +
          (r.maxAgeSeconds !== undefined && r.maxAgeSeconds !== null
            ? el('MaxAgeSeconds', String(r.maxAgeSeconds))
            : ''),
      ),
    )
    .join('');
  return xmlDoc('CORSConfiguration', inner);
}

function quoteEtag(etag) {
  if (typeof etag === 'string' && etag.startsWith('"')) return etag;
  return `"${etag}"`;
}
