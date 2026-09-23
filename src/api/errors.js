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

import { xmlDoc, el } from '../util/xml.js';

// S3 error catalogue: code -> HTTP status.
export const ERROR_STATUS = {
  AccessDenied: 403,
  AccessForbidden: 403,
  AccountProblem: 403,
  AmbiguousGrantByEmailAddress: 400,
  AuthorizationHeaderMalformed: 400,
  BadDigest: 400,
  BucketAlreadyExists: 409,
  BucketAlreadyOwnedByYou: 409,
  BucketNotEmpty: 409,
  CredentialsNotSupported: 400,
  CrossLocationLoggingProhibited: 403,
  EntityTooSmall: 400,
  EntityTooLarge: 400,
  ExpiredToken: 400,
  IllegalVersioningConfigurationException: 400,
  IncompleteBody: 400,
  IncorrectNumberOfFilesInPostRequest: 400,
  InlineDataTooLarge: 400,
  InternalError: 500,
  InvalidAccessKeyId: 403,
  InvalidArgument: 400,
  InvalidBucketName: 400,
  InvalidDigest: 400,
  InvalidLocationConstraint: 400,
  InvalidPart: 400,
  InvalidPartOrder: 400,
  InvalidRange: 416,
  InvalidRequest: 400,
  InvalidSecurity: 403,
  InvalidTag: 400,
  InvalidToken: 400,
  InvalidURI: 400,
  KeyTooLongError: 400,
  MalformedACLError: 400,
  MalformedPolicy: 400,
  MalformedPOSTRequest: 400,
  MalformedXML: 400,
  MaxMessageLengthExceeded: 400,
  MaxPostPreDataLengthExceededError: 400,
  MetadataTooLarge: 400,
  MethodNotAllowed: 405,
  MissingContentLength: 411,
  MissingRequestBodyError: 400,
  MissingSecurityHeader: 400,
  NoSuchBucket: 404,
  NoSuchBucketPolicy: 404,
  NoSuchCORSConfiguration: 404,
  NoSuchKey: 404,
  NoSuchLifecycleConfiguration: 404,
  NoSuchTagSet: 404,
  NoSuchUpload: 404,
  NoSuchVersion: 404,
  NotImplemented: 501,
  NotModified: 304,
  OperationAborted: 409,
  PermanentRedirect: 301,
  PreconditionFailed: 412,
  Redirect: 307,
  RequestTimeout: 400,
  RequestTimeTooSkewed: 403,
  RequestTorrentOfBucketError: 400,
  RestoreAlreadyInProgress: 409,
  RestoreObjectInProgress: 409,
  SignatureDoesNotMatch: 403,
  ServiceUnavailable: 503,
  SlowDown: 503,
  TemporaryRedirect: 307,
  TokenRefreshRequired: 400,
  TooManyBuckets: 400,
  UnexpectedContent: 400,
  UnresolvableGrantByEmailAddress: 400,
  UserKeyMustBeSpecified: 400,
};

export class S3Error extends Error {
  constructor(code, message, status, resource, requestId) {
    super(message || code);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 500;
    this.resource = resource;
    this.requestId = requestId;
  }
}

// Build a new S3 error with defaults.
export function s3Error(code, message, resource) {
  return new S3Error(code, message, undefined, resource);
}

// Render an S3 error document.
export function errorXml(err, resource, requestId) {
  const code = err.code || 'InternalError';
  const message = err.message || code;
  const status = err.status || ERROR_STATUS[code] || 500;
  const body = xmlDoc(
    'Error',
    el('Code', code) +
      el('Message', message) +
      el('Resource', resource || '') +
      el('RequestId', requestId || ''),
  );
  return { status, body, contentType: 'application/xml' };
}

// Map an arbitrary thrown error to an S3Error.
export function toS3Error(err) {
  if (err instanceof S3Error) return err;
  if (err && err.code) return new S3Error(err.code, err.message, err.status, err.resource);
  return new S3Error('InternalError', String(err && err.message ? err.message : err));
}
