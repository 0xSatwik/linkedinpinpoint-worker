-- Migration to add explanation column to existing pinpoint_data table
-- Run this migration before deploying the updated worker

ALTER TABLE pinpoint_data ADD COLUMN explanation TEXT;
