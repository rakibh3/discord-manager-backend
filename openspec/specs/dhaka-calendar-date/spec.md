# dhaka-calendar-date Specification

## Purpose

Defines the single notion of an operational day used across the attendance domain: a civil calendar date in the `Asia/Dhaka` timezone, formatted `YYYY-MM-DD`, derived from one shared helper so no consumer computes it another way. It covers how an instant maps to a Dhaka date across UTC and Dhaka day boundaries, the rule that a record is attributed to the date in force when it was created rather than when it was processed, and the validation that rejects malformed date strings and full timestamps before they reach a query or a write.

## Requirements

### Requirement: A civil day is defined in Asia/Dhaka

The system SHALL represent an operational day as a civil calendar date in the `Asia/Dhaka` timezone, formatted as `YYYY-MM-DD`. Every date used to group attendance, daily updates, and reminders SHALL be derived from a single shared helper, and no consumer SHALL compute one another way.

#### Scenario: Current day derived from an instant

- **WHEN** the current Dhaka date is requested
- **THEN** the result is the `YYYY-MM-DD` calendar date as it reads on a wall clock in Dhaka at that instant
- **AND** the result is independent of the server process's own timezone or `TZ` environment variable

#### Scenario: Instant near the UTC day boundary

- **WHEN** the instant is `2026-08-17T19:00:00Z`, which is `2026-08-18 01:00` in Dhaka
- **THEN** the derived date is `2026-08-18`, not `2026-08-17`

#### Scenario: Instant near the Dhaka day boundary

- **WHEN** the instant is `2026-08-17T17:59:00Z`, which is `2026-08-17 23:59` in Dhaka
- **THEN** the derived date is `2026-08-17`

#### Scenario: Zero-padded output

- **WHEN** the Dhaka date is the 3rd of February
- **THEN** the formatted result is `2026-02-03`, with both month and day zero-padded to two digits

### Requirement: An operational day ends at Dhaka midnight

The system SHALL treat the operational day as running from `00:00:00` to `23:59:59.999` Dhaka time. A record SHALL be attributed to the Dhaka date in force at the moment it was created, never to the date the record was later processed.

#### Scenario: Message sent just before midnight

- **WHEN** a daily-update message is sent at `23:58` Dhaka time and is persisted at `00:01` the following Dhaka day
- **THEN** the record's date is the date the message was sent, not the date it was written to the database

#### Scenario: Reminder run after midnight targets the previous day

- **WHEN** a reminder run starts at `00:05` Dhaka time for the day that just closed
- **THEN** the date it operates on is explicitly supplied by the caller rather than defaulting to the current Dhaka date

### Requirement: Date strings are validated before use

The system SHALL reject any date string that is not a well-formed `YYYY-MM-DD` calendar date before it reaches a query or a write.

#### Scenario: Well-formed date accepted

- **WHEN** the value `2026-08-17` is validated
- **THEN** it is accepted

#### Scenario: Malformed date rejected

- **WHEN** the value is `17-08-2026`, `2026-8-17`, `2026-13-01`, `2026-02-30`, or an empty string
- **THEN** validation rejects it

#### Scenario: Instant is not a date

- **WHEN** a full timestamp such as `2026-08-17T18:00:00Z` is supplied where a civil date is expected
- **THEN** validation rejects it rather than silently truncating it
