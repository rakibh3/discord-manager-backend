## 1. Validation schema

- [x] 1.1 In `src/modules/attendance/attendance.validation.ts`, drop the `name` and `phone` fields from `submitAttendanceValidationSchema`. Keep `email`, `discordUsername`, and the optional `cannotEnterRealDiscordUsername` flag.
- [x] 1.2 Apply `.strict()` to `submitAttendanceValidationSchema` so any `name`, `phone`, or other unknown key produces a 400 naming the first unknown field. Strip the "Unknown fields supplied" silent-ignore behaviour that the prior schema relied on.
- [x] 1.3 Verify the existing field-level error messages still fire for the remaining accepted fields when they are missing or malformed.

## 2. Service signature and payload type

- [x] 2.1 In `src/modules/attendance/attendance.service.ts`, drop `name` and `phone` from `TSubmitAttendancePayload`. The type is now `{ email, discordUsername, cannotEnterRealDiscordUsername? }`.
- [x] 2.2 Refactor `assertEnrolled` so it returns the matched active roster entry (or `null` when enforcement is off) instead of being a void gate. The submit path needs the entry in hand to source `name` and `phone`.
- [x] 2.3 In `submitAttendance`, thread the matched entry's `name` and `phone` (or `''` / `''` when enforcement is off) into the `attendanceRepository.createAttendanceForMembers` call. The repository signature does not change.
- [x] 2.4 When enforcement is disabled, do not include a `phone` field in the directory update (leave the existing directory `phone` untouched); when enforcement is enabled, set `phone` to the matched roster entry's stored phone (or `''` when the entry's phone is `null`).

## 3. Verification and unchanged behaviour

- [x] 3.1 Re-read `attendance.service.ts` end-to-end after the changes. Confirm the verify-user, verify-email, and `getAttendanceWindow` paths are untouched. Confirm the pairing-mismatch check (`assertHandleMatchesPairingIfPaired`), the pairing write (`recordRosterPairing`), the multi-server fanout, the unique-constraint duplicate check, the four distinguishable outcomes (400 / 403 / 404 / 409), the discord-pairing-mismatch report, and the controller's 201/202 split all still work end-to-end with the new payload.
- [x] 3.2 Confirm the controller (`attendance.controller.ts`), routes (`attendance.routes.ts`), and rate limiters are unchanged.

## 4. Documentation and tooling

- [x] 4.1 Update `API_INTEGRATION.md`: the submit endpoint's request body drops `name` and `phone`; the accepted-fields list shrinks from four to two; the unknown-fields behaviour is now "refused as a 400" rather than "ignored". Update the example request and any example responses that still show the old fields.
- [x] 4.2 Update `postman-collection.json`: the submit example body drops `name` and `phone`; the example status remains 201.
- [x] 4.3 Note in `CLAUDE.md` (in the attendance section, if present) that the form's name and phone are sourced from the matched roster entry under enforcement and are recorded as empty strings when enforcement is off.