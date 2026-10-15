# Both base images are pinned to an exact version. Never use latest.
ARG NODE_IMAGE=node:24.21.0-alpine3.24
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.31.6-alpine

# Stage 1: install the dependencies (.npmrc: exact versions, no install scripts) and build the static files into dist.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npm run build

# Stage 2: the runtime image. Only the built files and the nginx configuration: no Node, no source, no node_modules.
# The image runs as the unprivileged user 101 and listens on 8080. Its pid file and temp paths are under /tmp, which
# the chart mounts as an emptyDir, so the root filesystem can be read-only. The files stay owned by root.
FROM ${NGINX_IMAGE}
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
