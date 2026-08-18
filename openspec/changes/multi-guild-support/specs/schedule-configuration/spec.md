## MODIFIED Requirements

### Requirement: The schedule read reports what will happen next

The system SHALL report, alongside the stored values, the next open and lock instants implied by the schedule, so an administrator can confirm a change did what they intended without waiting for it to fire. It SHALL additionally report the servers the schedule applies to and each of their live channel states, because one stored schedule now governs several channels and the schedule alone no longer describes what an administrator will see.

#### Scenario: Enabled schedule

- **WHEN** the schedule is read while enabled and running
- **THEN** the response includes the next open time and the next lock time as instants
- **AND** it lists every configured server the schedule applies to

#### Scenario: Disabled schedule

- **WHEN** the schedule is read while disabled
- **THEN** the response reports no next run times
- **AND** it still lists the configured servers and their live channel states

#### Scenario: Days excluded

- **WHEN** the schedule runs only on Sunday through Thursday and is read on a Friday
- **THEN** the reported next open time is on the following Sunday

#### Scenario: Servers disagree about their live state

- **WHEN** one server's channel is open and another's is locked at the moment of the read
- **THEN** each server's state is reported separately rather than collapsed into one answer

## ADDED Requirements

### Requirement: One stored schedule governs every configured server

The system SHALL store exactly one daily-update schedule and SHALL apply it to every configured server. It SHALL NOT store a per-server open time, close time, weekday set, or enabled flag, so the servers cannot drift apart.

#### Scenario: Editing the schedule changes every server

- **WHEN** an administrator changes the open time, close time, weekdays, or enabled flag
- **THEN** the change takes effect for every configured server on the next firing
- **AND** no per-server override exists that could keep one server on the old value

#### Scenario: Adding a server adopts the existing schedule

- **WHEN** a further server is configured
- **THEN** it is governed by the existing stored schedule immediately, with no schedule record to create for it

#### Scenario: The timezone stays a single constant

- **WHEN** the schedule is read
- **THEN** the reported timezone is the single Asia/Dhaka constant for every server
- **AND** no per-server timezone is stored or accepted
