# Does the private-address guard of the pinned mcp-server-fetch also run on the hop of a REDIRECT? (docs/architecture.md,
# decision 42.) A public site cannot be made to redirect to a private address on demand, so this runs the real fetch code of
# the image against two throwaway servers on loopback, with two made-up names:
#   pub.test   -> the guard is told that this name is public (its resolver is replaced for this name only), the connection
#                 really goes to loopback through /etc/hosts
#   int.test   -> not replaced, so the guard sees the real address (loopback) and must refuse it
# Run it in a throwaway container of the image, as root (it writes into /etc/hosts, which a read-only container does not allow):
#   docker run --rm -i -u 0 --entrypoint /opt/fetch/bin/python <image> - < test/redirect-hop-check.py
# Exit code 0 only if every check below behaves as expected.
import asyncio
import http.server
import socket
import sys
import threading

import mcp_server_fetch.server as fetch_server
from mcp.shared.exceptions import McpError

MARKER = "INTERNAL-CANARY-9f3a"
REDIRECT_PORT = 9001
CANARY_PORT = 9002

with open("/etc/hosts", "a", encoding="utf-8") as hosts:
    hosts.write("\n127.0.0.1 pub.test int.test\n")

real_resolve = fetch_server._resolve_host
PUBLIC_NAMES = {"pub.test"}


async def lying_resolve(host):
    if host in PUBLIC_NAMES:
        return ["93.184.216.34"]  # a public address, so the guard lets the name pass
    return await real_resolve(host)


fetch_server._resolve_host = lying_resolve


class Canary(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write((MARKER + "\n").encode())

    def log_message(self, *args):
        pass


def redirector_to(location):
    class Redirect(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(302)
            self.send_header("Location", location)
            self.end_headers()

        def log_message(self, *args):
            pass

    return Redirect


def serve(port, handler):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


async def fetch(url, allow_private_ips=False):
    try:
        text, _prefix = await fetch_server.fetch_url(url, "redirect-hop-check", force_raw=True, allow_private_ips=allow_private_ips)
        return ("FETCHED", text)
    except McpError as error:
        return ("REFUSED", str(error.error.message))


async def main():
    failures = 0
    serve(CANARY_PORT, Canary)

    def check(name, got, expected_kind, must_contain=None, must_not_contain=None):
        nonlocal failures
        kind, text = got
        ok = kind == expected_kind
        if must_contain is not None:
            ok = ok and must_contain in text
        if must_not_contain is not None:
            ok = ok and must_not_contain not in text
        failures += 0 if ok else 1
        shown = "" if kind == "FETCHED" else " | " + text[:120]
        print(("PASS " if ok else "FAIL ") + name + " -> " + kind + shown)

    # 1. Control: a public-looking name that redirects to another public-looking name works. The redirect is followed.
    PUBLIC_NAMES.add("pub2.test")
    with open("/etc/hosts", "a", encoding="utf-8") as hosts:
        hosts.write("127.0.0.1 pub2.test\n")
    first = serve(REDIRECT_PORT, redirector_to(f"http://pub2.test:{CANARY_PORT}/c"))
    check("control: public name -> redirect -> public name is followed", await fetch(f"http://pub.test:{REDIRECT_PORT}/r"), "FETCHED", must_contain=MARKER)
    first.shutdown()
    first.server_close()

    # 2. The attack: a public-looking name redirects to a name that resolves to loopback. The hop must be refused.
    second = serve(REDIRECT_PORT, redirector_to(f"http://int.test:{CANARY_PORT}/c"))
    got = await fetch(f"http://pub.test:{REDIRECT_PORT}/r")
    check("attack: public name -> redirect -> name that resolves to loopback", got, "REFUSED", must_contain="not a public address", must_not_contain=MARKER)

    # 3. The attack with an address literal in the Location header.
    second.shutdown()
    second.server_close()
    third = serve(REDIRECT_PORT, redirector_to(f"http://127.0.0.1:{CANARY_PORT}/c"))
    check("attack: redirect to http://127.0.0.1", await fetch(f"http://pub.test:{REDIRECT_PORT}/r"), "REFUSED", must_contain="not a public address", must_not_contain=MARKER)
    third.shutdown()
    third.server_close()

    fourth = serve(REDIRECT_PORT, redirector_to("http://169.254.169.254/latest/meta-data/"))
    check("attack: redirect to the metadata address", await fetch(f"http://pub.test:{REDIRECT_PORT}/r"), "REFUSED", must_contain="not a public address")
    fourth.shutdown()
    fourth.server_close()

    # 4. Control for the control: with the guard switched off, the same redirect to loopback reads the canary. This proves that
    #    check 2 and 3 were refused by the guard and not by something else.
    fifth = serve(REDIRECT_PORT, redirector_to(f"http://int.test:{CANARY_PORT}/c"))
    check("mutation: guard off (allow_private_ips) -> the canary IS read", await fetch(f"http://pub.test:{REDIRECT_PORT}/r", allow_private_ips=True), "FETCHED", must_contain=MARKER)
    fifth.shutdown()
    fifth.server_close()

    print("failures:", failures)
    return failures


sys.exit(1 if asyncio.run(main()) else 0)
