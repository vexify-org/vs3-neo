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

// Bucket CORS helpers. A rule looks like:
//   {
//     id?, allowedOrigins: [..], allowedMethods: [..],
//     allowedHeaders?: [..], exposeHeaders?: [..], maxAgeSeconds?
//   }
// Origin patterns support "*" (either alone or inside a host pattern such as
// "https://*.example.com"); headers match case-insensitively.

// Return the first rule matching the origin (and, for preflight, the requested
// method and headers), or null when no rule applies.
export function matchCorsRule(rules, { origin, method, headers } = {}) {
  for (const rule of rules || []) {
    if (!rule) continue;
    if (!matchAny(rule.allowedOrigins, origin, false)) continue;
    if (method && !matchAny(rule.allowedMethods, method, true)) continue;
    if (headers && headers.length && !headers.every((h) => matchAny(rule.allowedHeaders, h, true))) {
      continue;
    }
    return rule;
  }
  return null;
}

// Headers for an actual (non-preflight) cross-origin request.
export function corsResponseHeaders(rule, origin) {
  const headers = { Vary: 'Origin' };
  applyOrigin(headers, rule, origin);
  const expose = rule.exposeHeaders || [];
  if (expose.length) headers['Access-Control-Expose-Headers'] = expose.join(', ');
  return headers;
}

// Headers for an OPTIONS preflight response.
export function corsPreflightHeaders(rule, origin, requestedHeaders = []) {
  const headers = {
    Vary: 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method',
  };
  applyOrigin(headers, rule, origin);

  const methods = rule.allowedMethods || [];
  if (methods.length) headers['Access-Control-Allow-Methods'] = methods.join(', ');

  const requested = requestedHeaders.filter(Boolean);
  if (requested.length) {
    headers['Access-Control-Allow-Headers'] = requested.join(', ');
  } else if ((rule.allowedHeaders || []).length) {
    headers['Access-Control-Allow-Headers'] = rule.allowedHeaders.join(', ');
  }

  const expose = rule.exposeHeaders || [];
  if (expose.length) headers['Access-Control-Expose-Headers'] = expose.join(', ');

  if (rule.maxAgeSeconds !== undefined && rule.maxAgeSeconds !== null) {
    headers['Access-Control-Max-Age'] = String(rule.maxAgeSeconds);
  }
  return headers;
}

// A literal "*" origin is echoed as-is (and credentials must then be omitted,
// since the two are mutually exclusive); any other match echoes the origin.
function applyOrigin(headers, rule, origin) {
  const origins = rule.allowedOrigins || [];
  if (origins.includes('*')) {
    headers['Access-Control-Allow-Origin'] = '*';
    return;
  }
  headers['Access-Control-Allow-Origin'] = origin;
  headers['Access-Control-Allow-Credentials'] = 'true';
}

function matchAny(patterns, value, caseInsensitive) {
  if (!value) return false;
  const list = Array.isArray(patterns) ? patterns : patterns ? [patterns] : [];
  if (list.length === 0) return false;
  return list.some((p) => wildcardMatch(p, value, caseInsensitive));
}

function wildcardMatch(pattern, value, caseInsensitive) {
  if (pattern === undefined || pattern === null) return false;
  let p = String(pattern);
  let v = String(value);
  if (caseInsensitive) {
    p = p.toLowerCase();
    v = v.toLowerCase();
  }
  if (p === '*') return true;
  if (!p.includes('*')) return p === v;
  const re = new RegExp('^' + p.split('*').map(escapeRe).join('.*') + '$');
  return re.test(v);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}