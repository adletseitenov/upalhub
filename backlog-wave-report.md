# Backlog Wave Report

## Fixed Issues

### exam_profiles insert column-grant compatibility (HIGH)
- **Issue**: After migration 20260709150000 (column-level insert grant), `repo.insert()` was still trying to send `trust: p.trust` in the payload. Since the grant only allows (slug, title, language, spec, sources, origin, created_by), the insert would fail with 42501 (permission denied) on every POST /api/exam-profiles.
- **Fix**: 
  - Removed `trust: p.trust` from insert payload in `src/features/exam-profile/repo.ts` (line 73)
  - Made `trust` optional in `NewExamProfile` type (defaults to DB's 'ai_draft' from column default)
  - Removed redundant `trust: "ai_draft"` pass in `findOrCreateExamProfile()` in `service.ts`
  - Updated mock repo in tests to default trust to 'ai_draft' when not provided
  - Added clarifying comment in repo.ts documenting the invariant
- **Test Coverage**: Existing migration test (migrations.test.ts line 396-413) already verified authenticated insert without trust column succeeds and defaults to 'ai_draft'
- **Verification**: `npm test` (660 pass), `npm run typecheck`, `npm run lint` all pass

