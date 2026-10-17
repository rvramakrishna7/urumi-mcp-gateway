import { parseUpstreamPolicy } from '../../src/upstream/ssrf.ts';
import type { UpstreamPolicyConfig } from '../../src/config.ts';

// The policy that the tests give to the admin routes and to the seed: exactly the hosts that the tests register, built
// with the production parser. There is no flag or variable in the production code that switches the check off.
export const TEST_NAMESPACE = 'gateway';
export const TEST_UPSTREAM_HOSTS = [
  'alpha.test:8080', 'beta.test:80', 'gamma.test:80', 'x.test:80',
  'one.test:80', 'hanging.test:80', 'rejecting.test:80', 'throwing.test:80', 'moved.test:80',
  'viasession.test:80', 'viamember.test:80', 'viakey.test:80',
  'woo-mcp.mcp-servers.svc.cluster.local:8080', 'woo-mcp.mcp-servers.svc.cluster.local:9090', 'woo-mcp.mcp-servers.svc.cluster.local:7070',
];

export const TEST_UPSTREAM: UpstreamPolicyConfig = {
  policy: parseUpstreamPolicy(TEST_UPSTREAM_HOSTS.join(','), TEST_NAMESPACE),
  ownNamespace: TEST_NAMESPACE,
};
