## ADDED Requirements

### Requirement: A single member's daily status can be retrieved with their messages

The system SHALL provide a repository function that, for a given member ID and date, returns that member's status row (using the same derivation as the page query) plus the daily-update messages posted on that date. The status derivation SHALL use the same CASE expression as `getDailyStatusPage` and `getDailyStatusCounts`, so the three can never disagree.

#### Scenario: Member with both attendance and updates

- **WHEN** the single-member status is requested for a member who submitted attendance and posted daily updates on the date
- **THEN** the result carries status `COMPLETE` and a messages array with each message's id, content, and send timestamp

#### Scenario: Member with no activity

- **WHEN** the single-member status is requested for a member who neither submitted attendance nor posted updates
- **THEN** the result carries status `MISSING_BOTH` and an empty messages array

#### Scenario: Unknown member

- **WHEN** the single-member status is requested for a member ID that does not exist in the directory
- **THEN** the result is null or empty, so the caller can distinguish "not found" from "found with no activity"

#### Scenario: Messages use messageCreatedAt as the timestamp

- **WHEN** the messages for a member and date are retrieved
- **THEN** each message carries the `messageCreatedAt` timestamp (when the message was sent), not the database insertion timestamp
