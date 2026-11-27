-- Lab-only replication role for the docker-compose HA profile.
-- Production: create the role with a secret from the secret manager and grant
-- only REPLICATION; never keep the password in the repository.
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replicator';
