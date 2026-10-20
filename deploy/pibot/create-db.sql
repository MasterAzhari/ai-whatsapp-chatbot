-- Run once inside the existing Postgres (typebot-db) as its admin user:
--   docker exec -i typebot-db psql -U <admin-user> -v pw="$POSTGRES_PASSWORD" < deploy/pibot/create-db.sql
-- Creates a non-superuser role so row-level security (the tenant boundary) applies,
-- and a separate database so Typebot data is untouched.
CREATE ROLE chatbot LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'pw';
CREATE DATABASE chatbot OWNER chatbot;
REVOKE ALL ON DATABASE chatbot FROM PUBLIC;
