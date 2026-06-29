-- ────────────────────────────────────────────────────────────────────────────
-- Probation Feedback Module
-- Cycle-based feedback submissions by DM / NSM / TM / PM-GPM, with follow-up
-- comments and DV checkbox tracking per active probation employee.
-- Applies to new hires from July 2026 onward — no backfill of prior records.
-- ────────────────────────────────────────────────────────────────────────────

-- ── 1. DV checkbox columns on employee_probation ─────────────────────────────
-- NULL on pm_gpm_dv_done = "not applicable" (CNS line employees have no PM/GPM).
ALTER TABLE employee_probation
  ADD COLUMN IF NOT EXISTS dm_dv_done           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dm_dv_done_at        TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS dm_dv_done_manually  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS nsm_dv_done          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS nsm_dv_done_at       TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS nsm_dv_done_manually BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pm_gpm_dv_done       BOOLEAN NULL,
  ADD COLUMN IF NOT EXISTS pm_gpm_dv_done_at    TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS pm_gpm_dv_done_manually BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tm_dv_done           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tm_dv_done_at        TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS tm_dv_done_manually  BOOLEAN NOT NULL DEFAULT false;

-- ── 2. probation_feedback_submissions ────────────────────────────────────────
-- One record per manager per cycle (for DM/NSM) or per probation period (TM/PM-GPM).
CREATE TABLE IF NOT EXISTS probation_feedback_submissions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  probation_id    BIGINT      NOT NULL REFERENCES employee_probation(id) ON DELETE CASCADE,
  employee_hr_id  TEXT        NOT NULL REFERENCES employees(hr_id),
  cycle_number    INTEGER     NOT NULL CHECK (cycle_number BETWEEN 1 AND 3),
  cycle_key       TEXT        NOT NULL,   -- reminder_type from notification_events
  submitter_hr_id TEXT        NOT NULL REFERENCES employees(hr_id),
  submitter_role  TEXT        NOT NULL
    CHECK (submitter_role IN ('dm', 'nsm', 'tm', 'pm_gpm')),
  feedback_text   TEXT        NOT NULL CHECK (char_length(feedback_text) >= 10),
  recommendation  TEXT        NOT NULL
    CHECK (recommendation IN ('recommend_pass', 'recommend_dismissal', 'not_sure_yet')),
  -- true for TM and PM/GPM who submit once per probation (not per cycle)
  is_once_only    BOOLEAN     NOT NULL DEFAULT false,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One submission per cycle per person (DM / NSM)
CREATE UNIQUE INDEX IF NOT EXISTS pfs_cycle_unique
  ON probation_feedback_submissions (probation_id, submitter_hr_id, cycle_number)
  WHERE NOT is_once_only;

-- One submission per probation period per once-only person (TM / PM-GPM)
CREATE UNIQUE INDEX IF NOT EXISTS pfs_once_only_unique
  ON probation_feedback_submissions (probation_id, submitter_hr_id)
  WHERE is_once_only;

CREATE INDEX IF NOT EXISTS pfs_employee_idx
  ON probation_feedback_submissions (employee_hr_id, cycle_number);
CREATE INDEX IF NOT EXISTS pfs_submitter_idx
  ON probation_feedback_submissions (submitter_hr_id);
CREATE INDEX IF NOT EXISTS pfs_probation_idx
  ON probation_feedback_submissions (probation_id);

ALTER TABLE probation_feedback_submissions ENABLE ROW LEVEL SECURITY;

-- ── 3. probation_feedback_comments ───────────────────────────────────────────
-- Follow-up comments on a submitted feedback (submitter / HR / CEO only).
CREATE TABLE IF NOT EXISTS probation_feedback_comments (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  UUID        NOT NULL
    REFERENCES probation_feedback_submissions(id) ON DELETE CASCADE,
  commenter_hr_id TEXT       NOT NULL REFERENCES employees(hr_id),
  comment_text   TEXT        NOT NULL CHECK (char_length(comment_text) >= 1),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pfc_submission_idx
  ON probation_feedback_comments (submission_id, created_at DESC);

ALTER TABLE probation_feedback_comments ENABLE ROW LEVEL SECURITY;
