import { describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { ROOT, read, stripComments } from './helpers/files';

// There is no nginx in the test environment, so these tests read nginx.conf. The real answer is checked with curl on the cluster.
const conf = stripComments(read(join(ROOT, 'nginx.conf')));

// The body of one "location" block, found by its exact header text.
function block(header: string): string | undefined {
  const start = conf.indexOf(header);
  if (start < 0) return undefined;
  const open = conf.indexOf('{', start);
  const close = conf.indexOf('}', open);
  return conf.slice(open + 1, close);
}

describe('nginx.conf: paths of the gateway that the Ingress does not route', () => {
  test('/readyz is an exact location that answers 404 with the security headers, not the single-page fallback', () => {
    const body = block('location = /readyz');
    expect(body).toBeDefined();
    expect(body).toMatch(/return\s+404\b/);
    expect(body).toContain('security-headers.conf');
    expect(body).not.toContain('index.html');
  });

  test('/api and /mcp answer 404', () => {
    expect(block('location ~ ^/(api|mcp)(/|$)')).toMatch(/return\s+404\b/);
  });

  test('the fallback to index.html still exists for the routes of the app', () => {
    expect(block('location / {')).toContain('try_files $uri /index.html');
  });

  test('the block finder does find a planted block and reports a missing one', () => {
    expect(block('location = /nothing-here')).toBeUndefined();
  });
});
