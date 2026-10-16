# The reference Fetch MCP server (mcp-server-fetch, Python, stdio) behind supergateway, which serves it as Streamable HTTP
# (docs/architecture.md, decision 42). There is no code of ours in this image.
#
# The base image is pinned by tag and by digest (the digest of the multi-arch index). Never use latest or the floating uvx tag.
# supergateway 4.2.0 is the first release with --apiKeyFile (a bearer token on the way in); 3.4.3 and 4.0.0 / 4.1.0 do not have it.
ARG BASE_IMAGE=supercorp/supergateway:4.2.0-uvx@sha256:f5289d1f4c8925f6a7c9666368af5bd3b19ecb3c50ab08325f991124166b8b62
FROM ${BASE_IMAGE}

# mcp-server-fetch and everything it needs is installed at build time, from a lock file in which every package has an exact
# version and its hashes (requirements.txt is made from requirements.in with "uv pip compile --generate-hashes"). Nothing is
# downloaded when a pod starts. The base image runs as root; this layer is the only one that writes, and the files stay owned
# by root and are only readable by the process.
COPY requirements.txt /tmp/requirements.txt
RUN uv venv --python /usr/bin/python3 /opt/fetch \
 && uv pip install --python /opt/fetch/bin/python --require-hashes --no-deps --compile-bytecode -r /tmp/requirements.txt \
 && rm /tmp/requirements.txt

# ReadabiliPy (used by mcp-server-fetch to cut an article out of a page) runs "npm install" for its JavaScript part the first time a
# page is read, into its own package folder. That would need the internet, a writable folder and unpinned versions (its
# package.json uses >= ranges) at run time, and fails as a non-root user on a read-only filesystem. So the JavaScript part is
# installed here, from a lock file (readability/package-lock.json, made from the package.json of ReadabiliPy with
# "npm install --package-lock-only"). cmp stops the build if the package.json of ReadabiliPy ever differs from the one the lock was made for.
COPY readability/package.json readability/package-lock.json /tmp/readability/
RUN JSDIR=/opt/fetch/lib/python3.12/site-packages/readabilipy/javascript \
 && cmp /tmp/readability/package.json "$JSDIR/package.json" \
 && cp /tmp/readability/package-lock.json "$JSDIR/package-lock.json" \
 && cd "$JSDIR" \
 && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && rm -rf /tmp/readability /root/.npm

# The Python process must not need to write anywhere except /tmp (the chart mounts an emptyDir there).
ENV HOME=/tmp \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# A numeric user, so that Kubernetes can check runAsNonRoot without looking up a name.
USER 10001:10001
EXPOSE 8080

# ENTRYPOINT is "supergateway" (from the base image). The arguments are the default; the chart sets them in its values.
# --apiKeyFile: a request to /mcp needs "Authorization: Bearer <key>"; the health endpoint stays open.
# mcp-server-fetch is started without --allow-private-ips and without a proxy: its refusal of private addresses stays on.
CMD ["--stdio", "/opt/fetch/bin/mcp-server-fetch", "--outputTransport", "streamableHttp", "--port", "8080", "--streamableHttpPath", "/mcp", "--healthEndpoint", "/healthz", "--logLevel", "info", "--logFormat", "json", "--apiKeyFile", "/secrets/auth/token"]
