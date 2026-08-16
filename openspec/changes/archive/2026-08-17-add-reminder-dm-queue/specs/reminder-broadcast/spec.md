## ADDED Requirements

### Requirement: A broadcast targets the members missing a daily update on a stated date

The system SHALL target exactly the members who are currently in the guild and have no daily update recorded for the requested Dhaka date. The date SHALL be supplied explicitly and SHALL NOT be inferred from the current time, because a broadcast started near midnight would otherwise remind the wrong day's members with no visible sign of the mistake.

#### Scenario: Targets resolved for a date

- **WHEN** a broadcast is started for a date
- **THEN** the targets are the members in the guild with no daily update recorded for that date

#### Scenario: Departed members excluded

- **WHEN** a member has left the guild
- **THEN** they are not targeted, whether or not they submitted an update that day

#### Scenario: Date omitted

- **WHEN** a broadcast is requested without a date
- **THEN** the request is rejected with a validation error

#### Scenario: Malformed or future date

- **WHEN** the requested date is not a valid `YYYY-MM-DD` Dhaka date, or is later than the current Dhaka date
- **THEN** the request is rejected with a validation error

#### Scenario: Nobody is missing

- **WHEN** every member submitted an update for that date
- **THEN** no broadcast is started and the response says the target list is empty

### Requirement: The target list can be previewed before sending

The system SHALL let an administrator see how many members, and which members, would be targeted for a date without sending anything.

#### Scenario: Preview a date

- **WHEN** an administrator requests the targets for a date
- **THEN** the response reports the count and the targeted members
- **AND** no broadcast session is created and no DM is sent

#### Scenario: Preview matches the send

- **WHEN** a broadcast is started for the same date immediately after a preview
- **THEN** the target list is recomputed at that moment rather than reused, so a member who submitted in between is not targeted

### Requirement: The reminder message is supplied by the administrator

The system SHALL send the message text the administrator wrote, wrapped in a fixed reminder heading, and SHALL validate that the message is present and short enough to be delivered as a single Discord message.

#### Scenario: Message supplied

- **WHEN** a broadcast is started with message text
- **THEN** that text is stored on the broadcast session and delivered to every recipient

#### Scenario: Message missing or blank

- **WHEN** the message is absent, empty, or only whitespace
- **THEN** the request is rejected with a validation error

#### Scenario: Message too long

- **WHEN** the message would exceed what Discord accepts in one message once the fixed heading is added
- **THEN** the request is rejected with a validation error stating the limit

### Requirement: Starting a broadcast is acknowledged, not completed

The system SHALL create the broadcast session and every recipient record before enqueuing any delivery, and SHALL respond immediately with the broadcast's identifier and target count rather than waiting for delivery to finish.

#### Scenario: Broadcast accepted

- **WHEN** a broadcast is started
- **THEN** the response is an acceptance carrying the broadcast identifier and the number of members targeted
- **AND** the response does not claim any DM has been delivered

#### Scenario: Recipients recorded before delivery

- **WHEN** a broadcast is started
- **THEN** every targeted member has a recipient record in a not-yet-attempted state before the first DM is sent

#### Scenario: Enqueue cannot proceed

- **WHEN** the delivery queue cannot accept work
- **THEN** no broadcast session and no recipient records are created, and the request is refused

### Requirement: Two broadcasts for the same date cannot run at once

The system SHALL refuse to start a broadcast for a date while another broadcast for that date is still running, so that a repeated click cannot schedule a second mass DM behind the first.

#### Scenario: Second broadcast while one is running

- **WHEN** a broadcast for a date is started while an unfinished broadcast for that date exists
- **THEN** the request is rejected with a conflict response identifying the running broadcast

#### Scenario: Second broadcast after the first finished

- **WHEN** a broadcast for a date is started after the previous one for that date reached a terminal state
- **THEN** it is accepted and its target list is computed fresh

#### Scenario: Different dates

- **WHEN** broadcasts for two different dates are started
- **THEN** both are accepted

### Requirement: A broadcast in flight can be cancelled

The system SHALL let an administrator stop a running broadcast. Pending deliveries SHALL NOT be sent, recipients already delivered SHALL keep their recorded outcome, and the broadcast SHALL end in a cancelled state that is distinguishable from a failed one.

#### Scenario: Cancel a running broadcast

- **WHEN** an administrator cancels a running broadcast
- **THEN** no further DMs are sent for it
- **AND** the session is recorded as cancelled

#### Scenario: Already delivered recipients

- **WHEN** a broadcast is cancelled after some DMs were delivered
- **THEN** those recipients keep their delivered outcome and the remaining recipients stay recorded as never attempted

#### Scenario: A job runs after cancellation

- **WHEN** a queued or in-flight delivery job is processed after the broadcast was cancelled
- **THEN** it sends nothing

#### Scenario: Cancelling a finished broadcast

- **WHEN** an administrator cancels a broadcast that already reached a terminal state
- **THEN** the request is rejected and the recorded outcome is unchanged

### Requirement: Broadcast progress is readable while it runs

The system SHALL report a broadcast's live progress: how many members were targeted, how many have been delivered, how many could not be reached, how many remain, and the session's status.

#### Scenario: Progress during delivery

- **WHEN** an administrator reads a running broadcast
- **THEN** the response reports the target count, the delivered count, the not-delivered count, the number still outstanding, and a status showing it is in progress

#### Scenario: Progress after completion

- **WHEN** a broadcast has finished
- **THEN** the reported counts are recomputed from the recipient records rather than from the running counters, so a worker that stopped mid-run cannot leave the totals permanently wrong

#### Scenario: Unknown broadcast

- **WHEN** an administrator reads a broadcast identifier that does not exist
- **THEN** the request is rejected as not found

### Requirement: Broadcast history and per-recipient outcomes are auditable

The system SHALL retain every broadcast with its date, message, counts, status, and the administrator who started it, and SHALL let an administrator page through a broadcast's recipients and filter them by outcome.

#### Scenario: Listing past broadcasts

- **WHEN** an administrator lists broadcasts
- **THEN** the response is a paged list, most recent first, each entry carrying its date, status, counts, and who started it

#### Scenario: Listing recipients of a broadcast

- **WHEN** an administrator reads a broadcast's recipients
- **THEN** the response is a paged list of members with their outcome, any error detail, and when the DM was sent

#### Scenario: Filtering recipients by outcome

- **WHEN** the recipient list is filtered to a single outcome
- **THEN** only recipients with that outcome are returned

#### Scenario: Administrator account removed

- **WHEN** the administrator account that started a broadcast is deleted
- **THEN** the broadcast record and its recipients remain, with the originating administrator no longer identified

### Requirement: Every reminder endpoint requires an administrator

The system SHALL require an authenticated, active administrator for previewing targets, starting, reading, cancelling, and auditing broadcasts, and for reading the queue status. None of these endpoints SHALL be reachable without credentials.

#### Scenario: Administrator request

- **WHEN** an authenticated administrator calls any reminder endpoint
- **THEN** the request is served

#### Scenario: Missing or invalid credentials

- **WHEN** a request carries no token or an invalid one
- **THEN** it is rejected as unauthorized and no broadcast is started or changed

#### Scenario: Inactive administrator account

- **WHEN** the requesting account is not in an active state
- **THEN** the request is rejected
