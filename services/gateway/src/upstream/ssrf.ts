import { isIP } from 'node:net';

// SSRF guard for the URL of an upstream MCP server (brief stand-out: protection against server-side request forgery
// when an admin adds a URL).
//
// The policy is an exact allowlist of "host:port" pairs, taken from configuration. There are no wildcards. Every IP
// literal is refused, whatever the allowlist says: the WHATWG URL parser already turns decimal, octal and hex IPv4
// forms (2130706433, 0x7f.1, 0177.0.0.1) into dotted form, so they all end up as an ip_literal here, and so do all
// bracketed IPv6 forms (::1, ::ffff:7f00:1, fd00:ec2::254).
//
// There is no DNS resolution by design. The allowlisted names are cluster Service names, and the gateway admin who
// registers a URL cannot change what the cluster DNS answers for them. The NetworkPolicy "gateway-egress" is the second
// layer. Pinning the connection to a checked address would be needed only if names outside the cluster were ever put on
// the allowlist.
//
// The module is pure: it reads no environment and no file, it never resolves a name, and no message or result of it
// carries the URL or the configured list.

export type UrlBlockReason = 'invalid_url' | 'scheme_not_allowed' | 'userinfo' | 'ip_literal' | 'blocked_host' | 'host_not_allowed';

export type UpstreamPolicy = { readonly allowed: ReadonlySet<string> };

// The message names the problem (and the position of the entry), never the value of the list or of an entry.
export class UpstreamPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamPolicyError';
  }
}

// Lowercase, and one trailing dot (the absolute form of a DNS name) removed.
function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

const DNS_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
// A last label that a URL parser reads as a number: the whole host is then an IPv4 address ("127.1", "2130706433", "0x7f").
const NUMERIC_LABEL = /^(0x[0-9a-f]*|[0-9]+)$/;
const KUBERNETES_API_NAMES: readonly string[] = [
  'kubernetes',
  'kubernetes.default',
  'kubernetes.default.svc',
  'kubernetes.default.svc.cluster.local',
];

// Hosts that can never be an upstream: this machine, the Kubernetes API, and the gateway's own namespace (it holds
// PostgreSQL). Both arguments are compared after lowercase and trailing-dot removal.
export function isBlockedHost(host: string, ownNamespace: string): boolean {
  const name = normalizeHost(host);
  // A single-label name is resolved through the pod's DNS search list, which starts with the gateway's own namespace, so "postgres" would reach the gateway's own PostgreSQL.
  if (!name.includes('.')) return true;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (KUBERNETES_API_NAMES.includes(name)) return true;
  const namespace = normalizeHost(ownNamespace);
  if (namespace === '') return false;
  for (const base of [`${namespace}.svc.cluster.local`, `${namespace}.svc`, namespace]) {
    if (name === base || name.endsWith(`.${base}`)) return true;
  }
  return false;
}

// raw: the comma-separated value of the setting. Every entry is exactly "host:port".
export function parseUpstreamPolicy(raw: string, ownNamespace: string): UpstreamPolicy {
  if (normalizeHost(ownNamespace) === '') throw new UpstreamPolicyError('the own namespace must not be empty');
  const entries = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (entries.length === 0) throw new UpstreamPolicyError('the upstream allowlist must name at least one host:port');

  const allowed = new Set<string>();
  entries.forEach((entry, index) => {
    const position = index + 1;
    const fail = (problem: string): never => {
      throw new UpstreamPolicyError(`upstream allowlist entry ${position} ${problem}`);
    };
    if (entry.includes('*')) fail('must not contain a wildcard');
    const colon = entry.lastIndexOf(':');
    if (colon < 0) fail('must be host:port (the port is required)');
    const hostPart = entry.slice(0, colon);
    const portPart = entry.slice(colon + 1);
    if (!/^[0-9]{1,5}$/.test(portPart) || Number(portPart) < 1 || Number(portPart) > 65535) fail('has a port that is not an integer from 1 to 65535');
    if (hostPart === '') fail('has an empty host');
    const host = normalizeHost(hostPart);
    if (hostPart.includes('[') || hostPart.includes(']') || isIP(host) !== 0) fail('must not be an IP address');
    if (!DNS_NAME.test(host)) fail('has a host that is not a plain DNS name (no scheme, path, user or IP)');
    if (NUMERIC_LABEL.test(host.slice(host.lastIndexOf('.') + 1))) fail('must not be an IP address');
    if (isBlockedHost(host, ownNamespace)) fail('names a host that is never allowed');
    allowed.add(`${host}:${Number(portPart)}`);
  });
  return { allowed };
}

// Never throws, and never returns or logs the URL: the answer is a fixed reason code.
export function checkUpstreamUrl(policy: UpstreamPolicy, ownNamespace: string, value: string): { ok: true } | { ok: false; reason: UrlBlockReason } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'scheme_not_allowed' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'userinfo' };
  if (url.hostname.startsWith('[') || isIP(url.hostname) !== 0) return { ok: false, reason: 'ip_literal' };
  const host = normalizeHost(url.hostname);
  if (isBlockedHost(host, ownNamespace)) return { ok: false, reason: 'blocked_host' };
  const port = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80';
  if (!policy.allowed.has(`${host}:${port}`)) return { ok: false, reason: 'host_not_allowed' };
  return { ok: true };
}
