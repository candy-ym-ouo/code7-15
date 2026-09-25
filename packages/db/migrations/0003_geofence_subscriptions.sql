CREATE TYPE subscription_frequency AS ENUM ('instant', 'daily', 'weekly');

CREATE TABLE geofence_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  center geography(Point, 4326) NOT NULL,
  radius_m integer NOT NULL CHECK (radius_m BETWEEN 100 AND 50000),
  category_keys text[] NOT NULL DEFAULT '{}',
  frequency subscription_frequency NOT NULL DEFAULT 'daily',
  is_active boolean NOT NULL DEFAULT true,
  scope_version integer NOT NULL DEFAULT 1,
  recomputed_version integer NOT NULL DEFAULT 0,
  last_digest_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX geofence_subscriptions_user_idx ON geofence_subscriptions(user_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX geofence_subscriptions_center_gix ON geofence_subscriptions USING gist (center) WHERE deleted_at IS NULL;
CREATE INDEX geofence_subscriptions_recompute_idx ON geofence_subscriptions(scope_version, recomputed_version) WHERE deleted_at IS NULL AND is_active = true;
CREATE INDEX geofence_subscriptions_digest_idx ON geofence_subscriptions(frequency, last_digest_at) WHERE deleted_at IS NULL AND is_active = true;

CREATE TABLE geofence_matches (
  subscription_id uuid NOT NULL REFERENCES geofence_subscriptions(id) ON DELETE CASCADE,
  feature_id uuid NOT NULL REFERENCES map_features(id) ON DELETE CASCADE,
  scope_version integer NOT NULL,
  matched_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  PRIMARY KEY (subscription_id, feature_id)
);
CREATE INDEX geofence_matches_pending_idx ON geofence_matches(subscription_id, matched_at) WHERE notified_at IS NULL;
CREATE INDEX geofence_matches_feature_idx ON geofence_matches(feature_id);

CREATE TABLE geofence_scan_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id uuid NOT NULL REFERENCES map_features(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX geofence_scan_events_queue_idx ON geofence_scan_events(status, created_at) WHERE status = 'pending';
