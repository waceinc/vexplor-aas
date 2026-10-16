#!/bin/sh
# A database account for the app that is not a superuser (lead request §7 T3 — the TimescaleDB licence review asks
# for technical support of "the customer does not redefine the schema": the app owns its tables, nobody else needs
# the superuser).
#
# Runs once, when the database volume is empty — the official PostgreSQL entrypoint runs every *.sh in
# /docker-entrypoint-initdb.d after the image's own TimescaleDB scripts (000_ · 001_), so the extension already exists.
# Without AAS_DB_USER nothing happens and the app keeps using POSTGRES_USER, as every install before this did.
#
# Important: the superuser password (POSTGRES_PASSWORD) stays only in .env — the install guide never prints it.
set -eu
[ -n "${AAS_DB_USER:-}" ] || exit 0
[ -n "${AAS_DB_PASSWORD:-}" ] || { echo "AAS_DB_USER is set but AAS_DB_PASSWORD is empty" >&2; exit 1; }
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app="$AAS_DB_USER" -v password="$AAS_DB_PASSWORD" -v db="$POSTGRES_DB" <<'SQL'
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE ROLE :"app" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'password';
ALTER DATABASE :"db" OWNER TO :"app";
ALTER SCHEMA public OWNER TO :"app";
SQL
