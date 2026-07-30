-- Serialize relay membership snapshot ordering across every relay pod.
--
-- A process-local timestamp guard is insufficient: two pods can commit
-- membership mutations in order and then publish their kind:13534 snapshots
-- in the opposite order. Allocating a monotonic Nostr created_at while holding
-- the tenant's communities row lock makes NIP-33 replacement deterministic.

ALTER TABLE communities
    ADD COLUMN relay_membership_snapshot_at BIGINT NOT NULL DEFAULT 0;

ALTER TABLE communities
    ADD CONSTRAINT chk_relay_membership_snapshot_at_nonnegative
    CHECK (relay_membership_snapshot_at >= 0);
