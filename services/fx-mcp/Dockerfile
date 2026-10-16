# The base image is pinned to an exact version. Never use latest.
ARG NODE_IMAGE=node:24.21.0-alpine3.24

# Stage 1: install every dependency (TypeScript is a dev dependency) and compile src to dist.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Stage 2: production dependencies only. This is the only node_modules that reaches the final image.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Stage 3: the runtime image. No compiler, no test files, no source.
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
# package.json is needed at run time: its "type": "module" tells Node that dist/*.js are ES modules.
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# A numeric user, so that Kubernetes can check runAsNonRoot without looking up a name. The files stay owned by
# root and are only readable, so the process cannot change its own code.
USER 10001:10001
EXPOSE 8080
CMD ["node", "dist/index.js"]
