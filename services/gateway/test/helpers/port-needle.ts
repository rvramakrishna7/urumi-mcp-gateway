// A port number as a needle for a leak scan. A bare "52550" also matches the digits inside a UUID (hex), so a scan with a
// random port as a plain substring fails now and then for no reason (measured: about 0.3 % of the runs of the scan of
// test/gateway-core.test.ts, every in-range window of its database text was inside a UUID). The pattern matches the port
// only when it is not part of a longer run of hex digits, so "127.0.0.1:52550", "port":52550 and "52550/mcp" still match.
export function portPattern(port: number): RegExp {
  return new RegExp(`(?<![0-9a-f])${port}(?![0-9a-f])`);
}

export function containsPort(text: string, port: number): boolean {
  return portPattern(port).test(text);
}
