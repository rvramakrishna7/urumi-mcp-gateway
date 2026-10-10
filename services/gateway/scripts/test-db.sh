#!/bin/sh
# Runs the whole test suite, including the tests that need a real PostgreSQL, against a throwaway container.
# The container is removed when the script ends. Needs Docker. Plain "npm test" skips the database tests.
set -eu

IMAGE="postgres:17.9-alpine3.23"
NAME="gateway-test-pg-$$"
PASSWORD=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')

docker run -d --name "$NAME" -e POSTGRES_PASSWORD="$PASSWORD" -p 127.0.0.1::5432 "$IMAGE" > /dev/null
trap 'docker rm -f "$NAME" > /dev/null 2>&1 || true' EXIT

# The image starts a temporary server to run its init, then restarts. Wait for the real one.
i=0
until docker logs "$NAME" 2>&1 | grep -q "PostgreSQL init process complete; ready for start up"; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "PostgreSQL did not initialise in 60 s" >&2; exit 1; }
  sleep 1
done
until docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres > /dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 90 ] && { echo "PostgreSQL did not become ready" >&2; exit 1; }
  sleep 1
done

PORT=$(docker port "$NAME" 5432/tcp | head -1 | sed 's/.*://')
echo "PostgreSQL ($IMAGE) is ready on 127.0.0.1:$PORT"
TEST_DB_HOST=127.0.0.1 TEST_DB_PORT="$PORT" TEST_DB_USER=postgres TEST_DB_PASSWORD="$PASSWORD" node --test
