-- Allocate strictly increasing NIP-29 discovery timestamps per channel.
-- Addressable events use created_at as their conflict clock; wall-clock seconds
-- alone can collide when several membership mutations land in one second.
ALTER TABLE channels
    ADD COLUMN relay_snapshot_created_at BIGINT NOT NULL DEFAULT 0;

ALTER TABLE channels
    ADD CONSTRAINT chk_relay_snapshot_created_at_nonnegative
    CHECK (relay_snapshot_created_at >= 0);
