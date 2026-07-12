/**
 * urlScrub — masks credential-bearing query parameters in a URL/path string
 * before it reaches any log line or persisted record (audit_logs, error
 * logs, shadow-mode warnings).
 *
 * Release Gate hardening: no code path is allowed to put tokens in URLs
 * anymore (the SSE stream authenticates via the Authorization header), but
 * logs must stay safe even if a buggy client, an old bookmark, or an
 * attacker sends one anyway — defense in depth.
 */
'use strict';

const SENSITIVE_QS =
  /([?&](?:token|access_token|refresh_token|id_token|jwt|authorization|auth|bearer|apikey|api_key|api-key|password|pass|pwd|secret|client_secret|session|sid)=)[^&#\s]*/gi;

function scrubUrl(u) {
  if (typeof u !== 'string' || u.indexOf('=') === -1) return u;
  return u.replace(SENSITIVE_QS, '$1***');
}

module.exports = { scrubUrl };
