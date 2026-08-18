## MODIFIED Requirements

### Requirement: A broadcast targets the members missing a daily update on a stated date

The system SHALL target exactly the members who are currently in **any** configured server and have no daily update recorded for the requested Dhaka date in that server. One broadcast SHALL cover every configured server. The date SHALL be supplied explicitly and SHALL NOT be inferred from the current time, because a broadcast started near midnight would otherwise remind the wrong day's members with no visible sign of the mistake.

#### Scenario: Targets resolved for a date across servers

- **WHEN** a broadcast is started for a date
- **THEN** the targets are the members of every configured server with no daily update recorded for that date in that server

#### Scenario: A person missing in both servers is targeted once per server record

- **WHEN** a Discord account is a current member of two configured servers and posted no update in either on the date
- **THEN** a recipient record is created for each of that account's member records
- **AND** the account is contacted exactly once, because delivery is grouped by Discord account

#### Scenario: A person missing in one server only

- **WHEN** a Discord account posted an update in one configured server and not in the other on the date
- **THEN** only the server where they are missing produces a recipient record
- **AND** they are contacted

#### Scenario: Departed members excluded

- **WHEN** a member has left the server their record belongs to
- **THEN** that record is not targeted, whether or not they submitted an update that day
- **AND** their record in a server they are still in is targeted normally

#### Scenario: Date omitted

- **WHEN** a broadcast is requested without a date
- **THEN** the request is rejected with a validation error

#### Scenario: Malformed or future date

- **WHEN** the requested date is not a valid `YYYY-MM-DD` Dhaka date, or is later than the current Dhaka date
- **THEN** the request is rejected with a validation error

#### Scenario: Nobody is missing in any server

- **WHEN** every member of every configured server submitted an update for that date
- **THEN** no broadcast is started and the response says the target list is empty

### Requirement: Two broadcasts for the same date cannot run at once

The system SHALL refuse to start a broadcast for a date while another broadcast for that date is still running, so that a repeated click cannot schedule a second mass DM behind the first. This restriction SHALL be global across configured servers rather than per server, because the constraint it protects — the bot's single shared DM budget — is global.

#### Scenario: Second broadcast while one is running

- **WHEN** a broadcast for a date is started while an unfinished broadcast for that date exists
- **THEN** the request is rejected with a conflict response identifying the running broadcast

#### Scenario: The conflict is not escapable by naming a server

- **WHEN** a broadcast for a date is started while an unfinished broadcast for that date exists
- **THEN** the request is rejected regardless of which servers either broadcast covers, because both draw on the same DM budget

#### Scenario: Second broadcast after the first finished

- **WHEN** a broadcast for a date is started after the previous one for that date reached a terminal state
- **THEN** it is accepted and its target list is computed fresh across every configured server

#### Scenario: Different dates

- **WHEN** broadcasts for two different dates are started
- **THEN** both are accepted

### Requirement: Broadcast progress is readable while it runs

The system SHALL report a broadcast's live progress: how many member records were targeted, how many distinct Discord accounts that is, how many have been delivered, how many could not be reached, how many remain, the session's status, and the same breakdown per configured server.

#### Scenario: Progress during delivery

- **WHEN** an administrator reads a running broadcast
- **THEN** the response reports the target count, the number of distinct accounts being contacted, the delivered count, the not-delivered count, the number still outstanding, and a status showing it is in progress

#### Scenario: Per-server breakdown

- **WHEN** an administrator reads a broadcast covering more than one server
- **THEN** the response additionally reports the same counts per server, so it is visible whether one server is lagging or failing

#### Scenario: Targets and accounts may differ

- **WHEN** some targeted accounts are members of more than one configured server
- **THEN** the number of distinct accounts is lower than the recipient count
- **AND** both figures are reported, so the difference is explained rather than looking like a defect

#### Scenario: Progress after completion

- **WHEN** a broadcast has finished
- **THEN** the reported counts are recomputed from the recipient records rather than from the running counters, so a worker that stopped mid-run cannot leave the totals permanently wrong

#### Scenario: Unknown broadcast

- **WHEN** an administrator reads a broadcast identifier that does not exist
- **THEN** the request is rejected as not found

### Requirement: Broadcast history and per-recipient outcomes are auditable

The system SHALL retain every broadcast with its date, message, counts, status, and the administrator who started it, and SHALL let an administrator page through a broadcast's recipients, filter them by outcome, and filter them by configured server.

#### Scenario: Listing past broadcasts

- **WHEN** an administrator lists broadcasts
- **THEN** the response is a paged list, most recent first, each entry carrying its date, status, counts, and who started it

#### Scenario: Listing recipients of a broadcast

- **WHEN** an administrator reads a broadcast's recipients
- **THEN** the response is a paged list of members with their server, their outcome, any error detail, and when the DM was sent

#### Scenario: Filtering recipients by outcome

- **WHEN** the recipient list is filtered to a single outcome
- **THEN** only recipients with that outcome are returned

#### Scenario: Filtering recipients by server

- **WHEN** the recipient list is filtered to one configured server
- **THEN** only recipient records whose member belongs to that server are returned

#### Scenario: One account, two recipient records

- **WHEN** a broadcast contacted an account that is a member of two configured servers
- **THEN** both recipient records appear, each under its own server, carrying the same outcome

#### Scenario: Administrator account removed

- **WHEN** the administrator account that started a broadcast is deleted
- **THEN** the broadcast record and its recipients remain, with the originating administrator no longer identified

## ADDED Requirements

### Requirement: A broadcast may be restricted to named servers

The system SHALL allow an administrator to restrict a broadcast to one or more named configured servers. Omitting the restriction SHALL mean every configured server.

#### Scenario: Broadcast without a server restriction

- **WHEN** a broadcast is started without naming any server
- **THEN** every configured server's missing members are targeted

#### Scenario: Broadcast restricted to one server

- **WHEN** a broadcast is started naming one configured server
- **THEN** only that server's missing members are targeted
- **AND** an account that is also a member of another server is contacted only on account of the named server's record

#### Scenario: Unknown server named

- **WHEN** a broadcast names a server that is not configured
- **THEN** the request is rejected naming the unknown server, and no broadcast is started

#### Scenario: Restriction does not weaken the same-date conflict

- **WHEN** a broadcast restricted to one server is started while an unfinished broadcast for the same date exists
- **THEN** it is still rejected as a conflict
