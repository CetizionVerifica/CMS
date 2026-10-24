-- pg-boss (M9's job runner) keeps its tables in the pgboss schema. The app's login has no CREATE on the database, so
-- the schema is created here, owned by canopy_app; pg-boss then creates its tables and queue partitions inside it as
-- a member of the owner (ADR M9-0001 decision 16). A deploy where pg-boss already made the schema keeps it.
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION canopy_app;
