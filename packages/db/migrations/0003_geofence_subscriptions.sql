CREATE TYPE geofence_frequency AS ENUM ('instant', 'daily', 'weekly');

CREATE TABLE geofence_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  center geography(Point, 4326) NOT NULL,
  radius_m integer NOT NULL CHECK (radius_m BETWEEN 100 AND 20000),
  category_keys text[] NOT NULL DEFAULT '{}',
  frequency geofence_frequency NOT NULL DEFAULT 'instant',
  is_active boolean NOT NULL DEFAULT true,
  scope_version integer NOT NULL DEFAULT 1,
  next_digest_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX geofence_subscriptions_user_idx ON geofence_subscriptions(user_id, created_at DESC);
CREATE INDEX geofence_subscriptions_center_gix ON geofence_subscriptions USING gist (center) WHERE is_active;
CREATE INDEX geofence_subscriptions_digest_idx ON geofence_subscriptions(next_digest_at)
  WHERE is_active AND next_digest_at IS NOT NULL;

-- One row per (subscription, feature) pair that has ever matched. Rows are kept
-- across scope edits so a feature leaving and re-entering the fence never
-- triggers a duplicate notification; notified_at IS NULL marks digest-pending rows.
CREATE TABLE geofence_subscription_matches (
  subscription_id uuid NOT NULL REFERENCES geofence_subscriptions(id) ON DELETE CASCADE,
  feature_id uuid NOT NULL REFERENCES map_features(id) ON DELETE CASCADE,
  scope_version integer NOT NULL,
  matched_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  PRIMARY KEY (subscription_id, feature_id)
);
CREATE INDEX geofence_matches_feature_idx ON geofence_subscription_matches(feature_id);
CREATE INDEX geofence_matches_pending_idx ON geofence_subscription_matches(subscription_id, matched_at)
  WHERE notified_at IS NULL;
