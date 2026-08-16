## ADDED Requirements

### Requirement: The current Dhaka time of day is derived from the shared module

The system SHALL derive the current wall-clock time of day in `Asia/Dhaka` — hours, minutes, and the day of the week — from the same shared module that produces civil dates, and SHALL NOT compute it from the process's own clock settings. Any consumer that needs to decide whether "now" falls inside a configured daily window SHALL use that helper.

#### Scenario: Time of day derived

- **WHEN** the current Dhaka time of day is requested
- **THEN** the result is the hour and minute as they read on a wall clock in Dhaka at that instant
- **AND** the result is independent of the server process's own timezone or `TZ` environment variable

#### Scenario: Weekday derived

- **WHEN** the current Dhaka weekday is requested
- **THEN** the result is the day of the week in Dhaka, expressed as an integer where `0` is Sunday through `6` is Saturday

#### Scenario: Weekday differs from the server's own day

- **WHEN** the instant is `2026-08-17T19:00:00Z`, which is Tuesday `01:00` in Dhaka but still Monday in UTC
- **THEN** the derived weekday is Tuesday and the derived time of day is `01:00`

#### Scenario: Comparison against a configured time

- **WHEN** a configured window of `18:00` to `23:59` is compared against the current Dhaka time of day
- **THEN** the comparison uses the Dhaka wall clock on both sides, so an instant at `20:00` Dhaka falls inside the window regardless of the server's timezone

#### Scenario: Zero-padded output

- **WHEN** the Dhaka time of day is six minutes past nine in the morning
- **THEN** the formatted result is `09:06`, with both hour and minute zero-padded to two digits
