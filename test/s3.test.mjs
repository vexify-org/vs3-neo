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

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { S3Server } from '../src/server.js';
import { S3Client } from '../src/client.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig([]);
config.server.port = 0; // random port
config.storage.backend = 'memory';
config.auth.anonymous = false;
config.auth.users = [{ accessKey: 'testkey', secretKey: 'testsecret' }];
config.functions.enabled = true;
config.functions.hooks = { onPut: 'log', onGet: '', onDelete: '' };

let server;
let s3server;
let addr;
let client;

before(async () => {
  s3server = new S3Server(config);
  await s3server.init();
  server = s3server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  addr = server.address();
  client = new S3Client({
    endpoint: `http://127.0.0.1:${addr.port}`,
    accessKey: 'testkey',
    secretKey: 'testsecret',
  });
});

after(() => {
  server && server.close();
});

test('auth: unsigned request is rejected', async () => {
  const res = await fetch(`http://127.0.0.1:${addr.port}/`);
  assert.equal(res.status, 403);
});

test('bucket: create / list / head / location / delete', async () => {
  const create = await client.createBucket('alpha');
  assert.ok(create.ok, create.text);

  const dup = await client.createBucket('alpha');
  assert.equal(dup.status, 409);

  const list = await client.listBuckets();
  assert.ok(list.text.includes('<Name>alpha</Name>'));

  const head = await client.headBucket('alpha');
  assert.equal(head.status, 200);

  const loc = await client.request('GET', '/alpha', { query: { location: '' } });
  assert.ok(loc.text.includes('LocationConstraint'));

  const del = await client.deleteBucket('alpha');
  assert.equal(del.status, 204);
});

test('object: put / get / head / delete roundtrip', async () => {
  await client.createBucket('obj');

  const content = 'hello vs3-neo';
  const put = await client.putObject('obj', 'dir/a.txt', content, {
    'Content-Type': 'text/plain',
    'x-amz-meta-owner': 'neo',
  });
  assert.ok(put.ok, put.text);
  assert.ok(put.headers.get('etag')?.startsWith('"'));

  const get = await client.getObject('obj', 'dir/a.txt');
  assert.equal(get.status, 200);
  assert.equal(get.text, content);
  assert.equal(get.headers.get('content-type'), 'text/plain');
  assert.equal(get.headers.get('x-amz-meta-owner'), 'neo');

  const head = await client.headObject('obj', 'dir/a.txt');
  assert.equal(head.status, 200);

  // range get (bytes 6-11 of "hello vs3-neo")
  const range = await client.request('GET', '/obj/dir/a.txt', {
    headers: { Range: 'bytes=6-11' },
  });
  assert.equal(range.status, 206);
  assert.equal(range.text, 'vs3-ne');

  const del = await client.deleteObject('obj', 'dir/a.txt');
  assert.equal(del.status, 204);

  const missing = await client.getObject('obj', 'dir/a.txt');
  assert.equal(missing.status, 404);
});

test('list: ListObjects v1 with prefix/delimiter', async () => {
  await client.createBucket('lst');
  await client.putObject('lst', 'photos/a.jpg', 'a');
  await client.putObject('lst', 'photos/b.jpg', 'b');
  await client.putObject('lst', 'docs.md', 'r');

  const res = await client.listObjects('lst', { delimiter: '/', 'max-keys': '1000' });
  assert.ok(res.text.includes('<Key>docs.md</Key>'));
  assert.ok(res.text.includes('<CommonPrefixes><Prefix>photos/</Prefix></CommonPrefixes>'));
});

test('list: ListObjectsV2', async () => {
  const res = await client.listObjectsV2('lst', { prefix: 'photos' });
  assert.ok(res.text.includes('<Key>photos/a.jpg</Key>'));
  assert.ok(res.text.includes('<Key>photos/b.jpg</Key>'));
});

test('copy object', async () => {
  await client.createBucket('copy-src');
  await client.createBucket('copy-dst');
  await client.putObject('copy-src', 'k.txt', 'copy me');
  const res = await client.request('PUT', '/copy-dst/k2.txt', {
    headers: { 'x-amz-copy-source': '/copy-src/k.txt' },
  });
  assert.ok(res.ok, res.text);
  assert.ok(res.text.includes('CopyObjectResult'));
  const got = await client.getObject('copy-dst', 'k2.txt');
  assert.equal(got.text, 'copy me');
});

test('multipart: create / upload / list / complete', async () => {
  await client.createBucket('mp1');

  const init = await client.request('POST', '/mp1/big.bin', { query: { uploads: '' } });
  assert.ok(init.ok, init.text);
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(init.text)[1];

  const p1 = await client.request('PUT', '/mp1/big.bin', { query: { uploadId, partNumber: '1' }, body: 'AAA' });
  assert.equal(p1.status, 200);
  const etag1 = p1.headers.get('etag').replace(/"/g, '');

  const p2 = await client.request('PUT', '/mp1/big.bin', { query: { uploadId, partNumber: '2' }, body: 'BBB' });
  const etag2 = p2.headers.get('etag').replace(/"/g, '');

  const parts = await client.request('GET', '/mp1/big.bin', { query: { uploadId } });
  assert.ok(parts.text.includes('PartNumber'));

  const completeBody = `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Part><PartNumber>1</PartNumber><ETag>"${etag1}"</ETag></Part>
  <Part><PartNumber>2</PartNumber><ETag>"${etag2}"</ETag></Part>
</CompleteMultipartUpload>`;
  const complete = await client.request('POST', '/mp1/big.bin', {
    query: { uploadId },
    headers: { 'Content-Type': 'application/xml' },
    body: completeBody,
  });
  assert.ok(complete.ok, complete.text);

  const got = await client.getObject('mp1', 'big.bin');
  assert.equal(got.text, 'AAABBB');
});

test('multipart: abort', async () => {
  await client.createBucket('mp2');
  const init = await client.request('POST', '/mp2/x.bin', { query: { uploads: '' } });
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(init.text)[1];
  await client.request('PUT', '/mp2/x.bin', { query: { uploadId, partNumber: '1' }, body: 'Q' });
  const abort = await client.request('DELETE', '/mp2/x.bin', { query: { uploadId } });
  assert.equal(abort.status, 204);
  const missing = await client.getObject('mp2', 'x.bin');
  assert.equal(missing.status, 404);
});

test('delete objects (batch)', async () => {
  await client.createBucket('del');
  await client.putObject('del', 'a', '1');
  await client.putObject('del', 'b', '2');
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Object><Key>a</Key></Object>
  <Object><Key>b</Key></Object>
</Delete>`;
  const res = await client.request('POST', '/del', {
    query: { delete: '' },
    headers: { 'Content-Type': 'application/xml' },
    body,
  });
  assert.ok(res.ok, res.text);
  assert.ok(res.text.includes('<Deleted><Key>a</Key>'));
  const a = await client.headObject('del', 'a');
  assert.equal(a.status, 404);
});

test('versioning: enable, keep versions, delete marker', async () => {
  await client.createBucket('ver');
  const set = await client.setVersioning('ver', 'Enabled');
  assert.ok(set.ok, set.text);

  const gv = await client.getVersioning('ver');
  assert.ok(gv.text.includes('<Status>Enabled</Status>'));

  const put1 = await client.putObject('ver', 'doc.txt', 'version-1');
  const v1 = put1.headers.get('x-amz-version-id');
  assert.ok(v1);

  const put2 = await client.putObject('ver', 'doc.txt', 'version-2');
  const v2 = put2.headers.get('x-amz-version-id');
  assert.notEqual(v1, v2);

  // current (latest)
  const cur = await client.getObject('ver', 'doc.txt');
  assert.equal(cur.text, 'version-2');

  // specific version
  const old = await client.getObject('ver', 'doc.txt', { versionId: v1 });
  assert.equal(old.text, 'version-1');

  // delete creates a delete marker
  const del = await client.deleteObject('ver', 'doc.txt');
  assert.equal(del.headers.get('x-amz-delete-marker'), 'true');

  const gone = await client.getObject('ver', 'doc.txt');
  assert.equal(gone.status, 404);

  // list versions
  const versions = await client.request('GET', '/ver', { query: { versions: '' } });
  assert.ok(versions.text.includes('ListVersionsResult'));
  assert.ok(versions.text.includes('DeleteMarker'));
});

test('presigned URL via __presign', async () => {
  await client.createBucket('pre');
  await client.putObject('pre', 'pub.txt', 'public data');
  const res = await client.request('POST', '/__presign', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'GET', bucket: 'pre', key: 'pub.txt', expires: 300 }),
  });
  assert.ok(res.ok, res.text);
  const { url } = JSON.parse(res.text);
  const fetched = await fetch(url);
  assert.equal(fetched.status, 200);
  assert.equal(await fetched.text(), 'public data');
});

test('functions: list + invoke echo', async () => {
  const list = await fetch(`http://127.0.0.1:${addr.port}/__functions`);
  const data = await list.json();
  assert.ok(data.functions.includes('echo'));

  const echo = await client.request('POST', '/__function/echo', { body: '' });
  assert.ok(echo.ok, echo.text);
  const json = JSON.parse(echo.text);
  assert.equal(json.operation, 'Invoke');
  assert.equal(json.key, 'echo');
});

test('health & info endpoints', async () => {
  const health = await fetch(`http://127.0.0.1:${addr.port}/__health`);
  assert.equal(health.status, 200);
  const info = await fetch(`http://127.0.0.1:${addr.port}/__info`);
  const data = await info.json();
  assert.equal(data.name, 'vs3-neo');
  assert.equal(data.storage, 'memory');
  const metrics = await fetch(`http://127.0.0.1:${addr.port}/__metrics`);
  assert.ok((await metrics.text()).includes('vs3_requests_total'));
});

// ---- object tagging ----
test('tagging: object tag put / get / delete', async () => {
  await client.createBucket('tag-obj');
  await client.putObject('tag-obj', 'doc.txt', 'hello');

  const put = await client.putObjectTagging('tag-obj', 'doc.txt', [
    { Key: 'env', Value: 'prod' },
    { Key: 'team', Value: 'storage' },
  ]);
  assert.ok(put.ok, put.text);

  const get = await client.getObjectTagging('tag-obj', 'doc.txt');
  assert.equal(get.status, 200);
  assert.ok(get.text.includes('<Key>env</Key><Value>prod</Value>'));
  assert.ok(get.text.includes('<Key>team</Key><Value>storage</Value>'));

  const del = await client.deleteObjectTagging('tag-obj', 'doc.txt');
  assert.equal(del.status, 204);

  const empty = await client.getObjectTagging('tag-obj', 'doc.txt');
  assert.equal(empty.status, 200);
  assert.ok(empty.text.includes('<TagSet></TagSet>'));

  const missing = await client.getObjectTagging('tag-obj', 'nope.txt');
  assert.equal(missing.status, 404);
});

test('tagging: object tags are per-version', async () => {
  await client.createBucket('tag-ver');
  await client.setVersioning('tag-ver', 'Enabled');

  const put1 = await client.putObject('tag-ver', 'f.txt', 'v1');
  const v1 = put1.headers.get('x-amz-version-id');
  await client.putObjectTagging('tag-ver', 'f.txt', [{ Key: 'stage', Value: 'one' }], { versionId: v1 });

  const put2 = await client.putObject('tag-ver', 'f.txt', 'v2');
  const v2 = put2.headers.get('x-amz-version-id');

  // latest version has no tags
  const latest = await client.getObjectTagging('tag-ver', 'f.txt');
  assert.ok(latest.text.includes('<TagSet></TagSet>'));

  // old version keeps its tags
  const old = await client.getObjectTagging('tag-ver', 'f.txt', { versionId: v1 });
  assert.ok(old.text.includes('<Key>stage</Key><Value>one</Value>'));
  assert.notEqual(v1, v2);
});

// ---- bucket tagging ----
test('tagging: bucket tag put / get / delete', async () => {
  await client.createBucket('tag-bucket');

  const put = await client.putBucketTagging('tag-bucket', [{ Key: 'owner', Value: 'platform' }]);
  assert.ok(put.ok, put.text);

  const get = await client.getBucketTagging('tag-bucket');
  assert.equal(get.status, 200);
  assert.ok(get.text.includes('<Key>owner</Key><Value>platform</Value>'));

  const del = await client.deleteBucketTagging('tag-bucket');
  assert.equal(del.status, 204);

  const empty = await client.getBucketTagging('tag-bucket');
  assert.equal(empty.status, 404);
  assert.ok(empty.text.includes('NoSuchTagSet'));
});

// ---- server-side encryption (SSE-S3) ----
test('sse: put / get / head roundtrip with AES256', async () => {
  await client.createBucket('sse');
  const content = 'classified payload';
  const put = await client.putObject('sse', 'secret.txt', content, {
    'x-amz-server-side-encryption': 'AES256',
  });
  assert.ok(put.ok, put.text);
  assert.equal(put.headers.get('x-amz-server-side-encryption'), 'AES256');

  const get = await client.getObject('sse', 'secret.txt');
  assert.equal(get.status, 200);
  assert.equal(get.text, content);
  assert.equal(get.headers.get('x-amz-server-side-encryption'), 'AES256');

  const head = await client.headObject('sse', 'secret.txt');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('x-amz-server-side-encryption'), 'AES256');

  // data at rest must not be plaintext in the memory backend
  const raw = s3server.storage.buckets.get('sse').objects.get('secret.txt').versions[0].data;
  assert.ok(Buffer.isBuffer(raw));
  assert.notEqual(raw.toString('utf8'), content);
});

test('sse: copy propagates encryption, non-encrypted stays plain', async () => {
  await client.createBucket('sse-copy');
  await client.putObject('sse-copy', 'src.txt', 'copy me', {
    'x-amz-server-side-encryption': 'AES256',
  });

  // no explicit header => source encryption is preserved
  const copy = await client.request('PUT', '/sse-copy/dst.txt', {
    headers: { 'x-amz-copy-source': '/sse-copy/src.txt' },
  });
  assert.ok(copy.ok, copy.text);
  const got = await client.getObject('sse-copy', 'dst.txt');
  assert.equal(got.text, 'copy me');
  assert.equal(got.headers.get('x-amz-server-side-encryption'), 'AES256');

  // plain object has no sse header
  await client.putObject('sse-copy', 'plain.txt', 'plain');
  const plain = await client.getObject('sse-copy', 'plain.txt');
  assert.equal(plain.headers.get('x-amz-server-side-encryption'), null);
});

test('sse: multipart upload with AES256', async () => {
  await client.createBucket('sse-mp');
  const init = await client.request('POST', '/sse-mp/big.bin', {
    query: { uploads: '' },
    headers: { 'x-amz-server-side-encryption': 'AES256' },
  });
  assert.ok(init.ok, init.text);
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(init.text)[1];

  const p1 = await client.request('PUT', '/sse-mp/big.bin', { query: { uploadId, partNumber: '1' }, body: 'AAA' });
  const etag1 = p1.headers.get('etag').replace(/"/g, '');
  const p2 = await client.request('PUT', '/sse-mp/big.bin', { query: { uploadId, partNumber: '2' }, body: 'BBB' });
  const etag2 = p2.headers.get('etag').replace(/"/g, '');

  const completeBody = `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Part><PartNumber>1</PartNumber><ETag>"${etag1}"</ETag></Part>
  <Part><PartNumber>2</PartNumber><ETag>"${etag2}"</ETag></Part>
</CompleteMultipartUpload>`;
  const complete = await client.request('POST', '/sse-mp/big.bin', {
    query: { uploadId },
    headers: { 'Content-Type': 'application/xml' },
    body: completeBody,
  });
  assert.ok(complete.ok, complete.text);

  const got = await client.getObject('sse-mp', 'big.bin');
  assert.equal(got.text, 'AAABBB');
  assert.equal(got.headers.get('x-amz-server-side-encryption'), 'AES256');
});

// ---- bucket policy ----
test('policy: put / get / delete and enforce deny', async () => {
  await client.createBucket('pol');
  await client.putObject('pol', 'secret.txt', 's3cr3t');

  // no policy yet => 404
  const none = await client.getBucketPolicy('pol');
  assert.equal(none.status, 404);

  const denyGet = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Deny',
        Principal: { AWS: '*' },
        Action: 's3:GetObject',
        Resource: 'arn:aws:s3:::pol/*',
      },
    ],
  };
  const put = await client.putBucketPolicy('pol', denyGet);
  assert.equal(put.status, 204);

  const got = await client.getBucketPolicy('pol');
  assert.equal(got.status, 200);
  assert.ok(JSON.parse(got.text).Statement[0].Effect === 'Deny');

  // GetObject denied by policy
  const denied = await client.getObject('pol', 'secret.txt');
  assert.equal(denied.status, 403);
  assert.ok(denied.text.includes('AccessDenied'));

  // PutObject (not denied) still works
  const putObj = await client.putObject('pol', 'other.txt', 'fine');
  assert.ok(putObj.ok, putObj.text);

  const del = await client.deleteBucketPolicy('pol');
  assert.equal(del.status, 204);

  const allowed = await client.getObject('pol', 'secret.txt');
  assert.equal(allowed.status, 200);
  assert.equal(allowed.text, 's3cr3t');
});

test('policy: malformed JSON is rejected', async () => {
  await client.createBucket('pol-bad');
  const res = await client.request('PUT', '/pol-bad', {
    query: { policy: '' },
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.ok(res.text.includes('MalformedPolicy'));
});

// ---- lifecycle ----
test('lifecycle: put / get / delete + object expiration', async () => {
  await client.createBucket('lc-exp');
  await client.putObject('lc-exp', 'logs/a.txt', 'a');
  await client.putObject('lc-exp', 'logs/b.txt', 'b');
  await client.putObject('lc-exp', 'data/c.txt', 'c');

  const rules = [
    { id: 'expire-logs', prefix: 'logs/', status: 'Enabled', expiration: { days: 0 } },
  ];
  const put = await client.putBucketLifecycle('lc-exp', rules);
  assert.ok(put.ok, put.text);

  const get = await client.getBucketLifecycle('lc-exp');
  assert.equal(get.status, 200);
  assert.ok(get.text.includes('<ID>expire-logs</ID>'));
  assert.ok(get.text.includes('<Prefix>logs/</Prefix>'));
  assert.ok(get.text.includes('<Expiration><Days>0</Days></Expiration>'));

  // trigger lifecycle processing
  const trig = await client.request('POST', '/__lifecycle', { query: { bucket: 'lc-exp' } });
  assert.ok(trig.ok, trig.text);
  const json = JSON.parse(trig.text);
  assert.equal(json.buckets, 1);
  assert.equal(json.removed, 2);

  const gone = await client.headObject('lc-exp', 'logs/a.txt');
  assert.equal(gone.status, 404);
  const kept = await client.headObject('lc-exp', 'data/c.txt');
  assert.equal(kept.status, 200);

  const del = await client.deleteBucketLifecycle('lc-exp');
  assert.equal(del.status, 204);
  const empty = await client.getBucketLifecycle('lc-exp');
  assert.equal(empty.status, 404);
});

test('lifecycle: abort incomplete multipart uploads', async () => {
  await client.createBucket('lc-mp');
  const init = await client.request('POST', '/lc-mp/upload.bin', { query: { uploads: '' } });
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(init.text)[1];
  await client.request('PUT', '/lc-mp/upload.bin', { query: { uploadId, partNumber: '1' }, body: 'Q' });

  const rules = [{ id: 'abort-all', status: 'Enabled', abort: { days: 0 } }];
  const put = await client.putBucketLifecycle('lc-mp', rules);
  assert.ok(put.ok, put.text);

  const trig = await client.request('POST', '/__lifecycle', { query: { bucket: 'lc-mp' } });
  assert.ok(trig.ok, trig.text);
  assert.equal(JSON.parse(trig.text).removed, 1);

  const uploads = await client.request('GET', '/lc-mp', { query: { uploads: '' } });
  assert.ok(!uploads.text.includes(uploadId));
});

test('cors: put / get / delete configuration', async () => {
  await client.createBucket('cors-cfg');

  const missing = await client.getBucketCors('cors-cfg');
  assert.equal(missing.status, 404);
  assert.ok(missing.text.includes('NoSuchCORSConfiguration'));

  const rules = [
    {
      id: 'web',
      allowedOrigins: ['https://example.com'],
      allowedMethods: ['GET', 'PUT'],
      allowedHeaders: ['*'],
      exposeHeaders: ['ETag'],
      maxAgeSeconds: 3000,
    },
  ];
  const put = await client.putBucketCors('cors-cfg', rules);
  assert.ok(put.ok, put.text);

  const get = await client.getBucketCors('cors-cfg');
  assert.equal(get.status, 200);
  assert.ok(get.text.includes('<ID>web</ID>'));
  assert.ok(get.text.includes('<AllowedOrigin>https://example.com</AllowedOrigin>'));
  assert.ok(get.text.includes('<AllowedMethod>GET</AllowedMethod>'));
  assert.ok(get.text.includes('<AllowedMethod>PUT</AllowedMethod>'));
  assert.ok(get.text.includes('<AllowedHeader>*</AllowedHeader>'));
  assert.ok(get.text.includes('<ExposeHeader>ETag</ExposeHeader>'));
  assert.ok(get.text.includes('<MaxAgeSeconds>3000</MaxAgeSeconds>'));

  const del = await client.deleteBucketCors('cors-cfg');
  assert.equal(del.status, 204);
  const gone = await client.getBucketCors('cors-cfg');
  assert.equal(gone.status, 404);
});

test('cors: preflight is unauthenticated and honors the rules', async () => {
  await client.createBucket('cors-pre');
  await client.putBucketCors('cors-pre', [
    {
      id: 'web',
      allowedOrigins: ['https://example.com'],
      allowedMethods: ['GET', 'PUT'],
      allowedHeaders: ['x-amz-meta-*'],
      exposeHeaders: ['ETag'],
      maxAgeSeconds: 600,
    },
  ]);

  const ok = await client.preflightCors('cors-pre', {
    origin: 'https://example.com',
    method: 'PUT',
    headers: ['x-amz-meta-color'],
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://example.com');
  assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(ok.headers.get('access-control-max-age'), '600');
  assert.ok(ok.headers.get('access-control-allow-methods').includes('PUT'));
  assert.equal(ok.headers.get('access-control-allow-headers'), 'x-amz-meta-color');
  assert.equal(ok.headers.get('access-control-expose-headers'), 'ETag');

  // Disallowed origin and disallowed header both fail the preflight.
  const badOrigin = await client.preflightCors('cors-pre', {
    origin: 'https://evil.test',
    method: 'PUT',
  });
  assert.equal(badOrigin.status, 403);
  assert.ok(badOrigin.text.includes('AccessForbidden'));

  const badHeader = await client.preflightCors('cors-pre', {
    origin: 'https://example.com',
    method: 'PUT',
    headers: ['x-not-allowed'],
  });
  assert.equal(badHeader.status, 403);
});

test('cors: actual requests get response headers; wildcard origin returns *', async () => {
  await client.createBucket('cors-res');
  await client.putObject('cors-res', 'a.txt', 'hello');
  await client.putBucketCors('cors-res', [
    { allowedOrigins: ['https://example.com'], allowedMethods: ['GET'], exposeHeaders: ['ETag'] },
  ]);

  const allowed = await client.request('GET', '/cors-res/a.txt', {
    headers: { Origin: 'https://example.com' },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://example.com');
  assert.equal(allowed.headers.get('access-control-expose-headers'), 'ETag');

  const denied = await client.request('GET', '/cors-res/a.txt', {
    headers: { Origin: 'https://other.test' },
  });
  assert.equal(denied.status, 200);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);

  // A "*" rule is echoed literally and must not advertise credentials.
  await client.putBucketCors('cors-res', [
    { allowedOrigins: ['*'], allowedMethods: ['GET'] },
  ]);
  const wild = await client.request('GET', '/cors-res/a.txt', {
    headers: { Origin: 'https://anything.test' },
  });
  assert.equal(wild.headers.get('access-control-allow-origin'), '*');
  assert.equal(wild.headers.get('access-control-allow-credentials'), null);
});

test('cors: wildcard host patterns match subdomains', async () => {
  await client.createBucket('cors-wild');
  await client.putBucketCors('cors-wild', [
    { allowedOrigins: ['https://*.example.com'], allowedMethods: ['GET'] },
  ]);

  const sub = await client.preflightCors('cors-wild', {
    origin: 'https://app.example.com',
    method: 'GET',
  });
  assert.equal(sub.status, 200);
  assert.equal(sub.headers.get('access-control-allow-origin'), 'https://app.example.com');

  const other = await client.preflightCors('cors-wild', {
    origin: 'https://example.org',
    method: 'GET',
  });
  assert.equal(other.status, 403);
});
