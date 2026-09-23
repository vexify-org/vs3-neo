# vs3-neo

An S3-compatible object storage server written in Node.js, with pluggable
storage backends, object versioning, multipart uploads, AWS Signature V4
authentication and a user-defined function (UDF) system.

## Features

- **S3-compatible API** — buckets, objects, multipart uploads, copy,
  versioning and delete markers (S3 XML response format, `ListObjects` v1/v2,
  `ListObjectVersions`, `ListMultipartUploads`, `ListParts`).
- **AWS Signature V4** — header-based and query-based (presigned URL)
  authentication, with the default `minioadmin`/`minioadmin` credentials.
- **Pluggable storage backend** — `disk` (default, atomic writes) and
  `memory` out of the box; a small backend interface lets you register your
  own, including mirror/custom implementations.
- **User-defined functions** — hook into S3 operations or invoke functions
  ad-hoc over an internal endpoint.
- **Versioning** — per-bucket enable/disable, versioned writes, reads of a
  specific `versionId`, delete markers and version listing.
- **Object tagging** — S3-compatible `Tagging` on buckets and objects
  (`Get/Put/DeleteBucketTagging`, `Get/Put/DeleteObjectTagging`); object tags
  are stored per-version.
- **Server-side encryption (SSE-S3)** — `AES256` via the
  `x-amz-server-side-encryption` header; objects are encrypted at rest with
  AES-256-GCM using a configurable master key, transparently decrypted on
  read and propagated on copy/multipart.
- **Bucket policies** — IAM-style JSON policies
  (`Get/Put/DeleteBucketPolicy`) evaluated against every request, with
  `Principal`, `Action` and `Resource` matching (incl. wildcards).
- **Lifecycle management** — S3-compatible `LifecycleConfiguration` with
  `Expiration` (object age-based deletion, honors versioning) and
  `AbortIncompleteMultipartUpload` cleanup, run on demand via
  `POST /__lifecycle`.
- **CORS** — per-bucket `CORSConfiguration` (`Get/Put/DeleteBucketCors`)
  with wildcard origins, headers and methods; `OPTIONS` preflight is
  answered before authentication and matching rules also decorate normal
  responses with the `Access-Control-*` headers.
- **Metrics & health** — Prometheus-style `/__metrics`, plus `/__health` and
  `/__info` introspection endpoints.

## Requirements

- Node.js >= 18 (tested on 24.x)

## Quick start

```sh
npm install        # no runtime dependencies — only dev tooling
npm start          # starts on http://0.0.0.0:9000
```

Or run directly:

```sh
node bin/vs3-neo.js
```

A bundled client for testing/CLI usage lives at `src/client.js`
(`S3Client`), and a full end-to-end suite is in `test/`.

```sh
npm test
```

## Configuration

Configuration is read from (in order of precedence):

1. Environment variables `VS3_*`
2. `--config <path>` / `VS3_CONFIG`
3. `./vs3-neo.json` if present
4. defaults (see `config/vs3-neo.json`)

| Variable                     | Default             | Description                          |
| ---------------------------- | ------------------- | ------------------------------------ |
| `VS3_SERVER_HOST`            | `0.0.0.0`           | listen address                       |
| `VS3_SERVER_PORT`            | `9000`              | listen port                          |
| `VS3_SERVER_REGION`          | `us-east-1`         | SigV4 region                         |
| `VS3_STORAGE_BACKEND`        | `disk`              | `disk` \| `memory` \| custom         |
| `VS3_STORAGE_DISK_DATA_DIR`  | `./data`            | data directory for the disk backend  |
| `VS3_AUTH_ANONYMOUS`         | `false`             | allow unsigned requests              |
| `VS3_AUTH_ACCESS_KEY`        | `minioadmin`        | access key (sets a single user)      |
| `VS3_AUTH_SECRET_KEY`        | `minioadmin`        | secret key                           |
| `VS3_ENCRYPTION_KEY`         | *(generated)*       | SSE-S3 master key (any secret string) |

Config file example (`config/vs3-neo.json`):

```json
{
  "server": { "host": "0.0.0.0", "port": 9000, "region": "us-east-1" },
  "storage": { "backend": "disk", "disk": { "dataDir": "./data" } },
  "auth": {
    "anonymous": false,
    "users": [{ "accessKey": "minioadmin", "secretKey": "minioadmin" }]
  },
  "encryption": { "key": "" },
  "versioning": { "default": false },
  "functions": {
    "enabled": true,
    "hooks": { "onPut": "log", "onGet": "log", "onDelete": "log" }
  },
  "metrics": { "enabled": true }
}
```

## Internal endpoints

| Endpoint                  | Description                                  |
| ------------------------- | -------------------------------------------- |
| `GET /__health`           | liveness probe (`{"status":"ok", ...}`)      |
| `GET /__info`             | service info (backend, functions, region)    |
| `GET /__metrics`          | Prometheus-style metrics                     |
| `POST /__presign`         | mint a presigned URL (authenticated)         |
| `POST /__lifecycle`       | run lifecycle rules now (see below)          |
| `POST /__function/:name`  | invoke a user-defined function ad-hoc        |
| `GET /__functions`        | list registered functions                    |

`POST /__presign` body:

```json
{ "method": "GET", "bucket": "my-bucket", "key": "dir/file.txt", "expires": 3600 }
```

Returns `{ "url": "http://...?...X-Amz-Signature=..." }` — the URL is a
normal S3 presigned URL usable with any S3 client or `curl`.

## Storage backends

Backends implement a small interface (see `src/storage/storage.js`):
`createBucket`, `deleteBucket`, `bucketExists`, `listBuckets`,
`putObject`, `getObject`, `headObject`, `deleteObject`, `listObjects`,
`copyObject`, versioning (`setVersioning`/`getVersioning`/`listVersions`)
and multipart (`createMultipartUpload`, `uploadPart`, `listParts`,
`completeMultipartUpload`, `abortMultipartUpload`,
`listMultipartUploads`), plus the extension points: tagging
(`get/set/deleteObjectTagging`, `get/set/deleteBucketTagging`), bucket
policy (`get/set/deleteBucketPolicy`), lifecycle
(`get/set/deleteLifecycle`, `runLifecycle`) and CORS
(`get/set/deleteBucketCors`). Unimplemented extension methods throw
`NotImplemented`, so custom backends can opt in incrementally.

- **disk** (`src/storage/disk.js`) — default. Objects are written to disk
  with atomic tmp-file+rename, MD5 ETags, per-object version metadata and
  key-level locking.
- **memory** (`src/storage/memory.js`) — ephemeral, in-process storage;
  handy for tests.
- **custom-mirror** (`src/storage/custom.js`) — example of a custom backend
  that mirrors reads/writes to another S3 endpoint.

Register a custom backend from any module:

```js
import { registerBackend } from './src/storage/storage.js';

registerBackend('my-backend', { name: 'my-backend', async putObject(...) { ... } });
```

Then select it with `VS3_STORAGE_BACKEND=my-backend`.

## User-defined functions (UDF)

A function is `{ name(), handle(ctx) }` and can be registered with
`registerFunction()` (or the shorthand `defineFunction(name, handle)`).
The context exposes the request, bucket/key, query, headers and the active
storage backend; setting `ctx.response` short-circuits the S3 handler.

Two ways to run functions:

1. **Hooks** — `config.functions.hooks` maps S3 operations to
   comma-separated function names:
   `onPut`, `onGet`, `onHead`, `onDelete`, `onCopy`, `onList`, `onMultipart`.
2. **Ad-hoc** — `POST /__function/:name` invokes a function directly.

Built-in functions (`src/plugin/builtin.js`): `log`, `echo`,
`transform-upper`, `counter`, `deny`.

Example — deny deletions:

```json
{ "functions": { "hooks": { "onDelete": "deny" } } }
```

## Tagging, SSE, policies, lifecycle & CORS

### Object / bucket tagging

Use the S3-compatible `?tagging` endpoints. The bundled client exposes
`getBucketTagging`, `putBucketTagging`, `getObjectTagging`,
`putObjectTagging`, `deleteObjectTagging`:

```sh
curl -X PUT "http://localhost:9000/bucket/doc.txt?tagging" \
  -H 'Content-Type: application/xml' \
  -d '<Tagging><TagSet><Tag><Key>env</Key><Value>prod</Value></Tag></TagSet></Tagging>'
```

### Server-side encryption (SSE-S3)

Send `x-amz-server-side-encryption: AES256` on `PutObject` /
`CreateMultipartUpload` / `CopyObject`. Data is encrypted at rest with
AES-256-GCM; the ciphertext nonce + tag are stored in object metadata and
decryption is transparent on `GetObject`/`HeadObject`. The `AES256`
response header echoes the encryption state.

The master key comes from `VS3_ENCRYPTION_KEY` or `config.encryption.key`
(any secret string — it is hashed to a 32-byte AES key). When unset, the
`memory` backend derives a random ephemeral key and the `disk` backend
generates one and persists it at `<dataDir>/sse-master.key`, so encrypted
objects stay readable across restarts. Changing the key makes previously
encrypted objects unreadable.

### Bucket policies

`PutBucketPolicy` stores an IAM-style JSON policy; every subsequent request
is checked with `evaluatePolicy` (see `src/auth/policy.js`) — an explicit
`Deny` wins, otherwise the bucket's own statements may allow; anonymous
requests require an explicit `Allow`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Deny",
      "Principal": { "AWS": "*" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::secret-bucket/*"
    }
  ]
}
```

### Lifecycle management

`PutBucketLifecycle` accepts an S3 `LifecycleConfiguration` with
`Expiration.Days` (delete objects older than N days, honoring versioning)
and `AbortIncompleteMultipartUpload.DaysAfterInitiation`. Rules match by
`Filter.Prefix` and `Status`.

Expiration runs on demand:

```sh
curl -X POST "http://localhost:9000/__lifecycle?bucket=my-bucket" -H 'Authorization: ...'
# omit ?bucket to run all buckets; returns { "buckets": n, "removed": n }
```

### CORS

`PutBucketCors` takes a `CORSConfiguration`; rules match on origin (with
`*` wildcards such as `https://*.example.com`), method and requested
headers. `OPTIONS` preflights are answered without a signature, and a
request that matches no rule is rejected with `AccessForbidden`.

```sh
curl -X PUT "http://localhost:9000/my-bucket?cors" \
  -H 'Content-Type: application/xml' \
  -d '<CORSConfiguration><CORSRule>
        <AllowedOrigin>https://example.com</AllowedOrigin>
        <AllowedMethod>GET</AllowedMethod>
        <AllowedMethod>PUT</AllowedMethod>
        <AllowedHeader>*</AllowedHeader>
        <ExposeHeader>ETag</ExposeHeader>
        <MaxAgeSeconds>3000</MaxAgeSeconds>
      </CORSRule></CORSConfiguration>'
```

Preflight check:

```sh
curl -i -X OPTIONS "http://localhost:9000/my-bucket" \
  -H 'Origin: https://example.com' \
  -H 'Access-Control-Request-Method: PUT' \
  -H 'Access-Control-Request-Headers: x-amz-meta-color'
```

Note that a rule whose `AllowedOrigin` is exactly `*` returns
`Access-Control-Allow-Origin: *` and omits `Access-Control-Allow-Credentials`
(the two are mutually exclusive); any other match echoes the request origin
and allows credentials.

## Authentication

Requests must be signed with AWS Signature V4. Both forms are supported:

- **Header auth**: `Authorization: AWS4-HMAC-SHA256 ...` with
  `x-amz-date` and `x-amz-content-sha256`.
- **Query auth (presigned URLs)**: `X-Amz-Algorithm`,
  `X-Amz-Credential`, `X-Amz-Date`, `X-Amz-Expires`, `X-Amz-Signature`.

When `auth.anonymous` is enabled, unsigned requests are allowed.

## License

Apache-2.0. See [LICENSE](LICENSE).
