-- Rename task status 'learning' → 'wrapping_up' to match the new UI label.
UPDATE tasks SET status = 'wrapping_up' WHERE status = 'learning';
