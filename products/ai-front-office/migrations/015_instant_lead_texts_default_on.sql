BEGIN;

-- Texts on every new lead are now on by default and included in every plan. Turn them on for existing shops
-- that never touched the toggle; an owner who explicitly changed it (ownerRealtimeSmsSetByOwner) keeps their
-- choice. Texts still go only to numbers in ownerNotificationRefs (the owner's SMS consent).
UPDATE business_configs
SET config = jsonb_set(config, '{ownerRealtimeSmsEnabled}', 'true'::jsonb), updated_at = now()
WHERE COALESCE(config->>'ownerRealtimeSmsEnabled', 'false') <> 'true'
  AND NOT (config ? 'ownerRealtimeSmsSetByOwner');

COMMIT;
