#!/usr/bin/env bash
# Turns an empty Postgres database into a stand-in for a Supabase project, for the store
# integration tests: API roles and auth shim, then the real migrations, then two test users.
#
#   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/nearcited_test scripts/integration-db.sh
#
# Point PostgREST at the same database as the `authenticator` role (password `postgres`).
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a throwaway Postgres database}"
root="$(cd "$(dirname "$0")/.." && pwd)"
run() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --quiet "$@"; }

run -f "$root/packages/db/test/supabase-shim.sql"
for migration in "$root"/supabase/migrations/*.sql; do
  run -f "$migration"
done

run <<'SQL'
insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-000000000001', 'alice@example.com'),
  ('b0000000-0000-4000-8000-000000000002', 'bob@example.com');
notify pgrst, 'reload schema';
SQL

echo "Database ready."
