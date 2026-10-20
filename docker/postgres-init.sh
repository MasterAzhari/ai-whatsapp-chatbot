#!/bin/sh
# Runs once when the postgres volume is first created.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -v pw="$CHATBOT_DB_PASSWORD" <<'SQL'
CREATE ROLE chatbot LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'pw';
CREATE DATABASE chatbot OWNER chatbot;
SQL
