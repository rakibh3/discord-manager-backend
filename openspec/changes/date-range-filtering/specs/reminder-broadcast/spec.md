## MODIFIED Requirements

### Requirement: A broadcast targets the members missing a daily update on a stated date

The system SHALL target exactly the members who are currently in **any** configured server and whose Discord ACCOUNT failed the requested criterion over the requested Dhaka date or date range in **any** configured server. One broadcast SHALL cover every configured server.

The period SHALL be supplied explicitly, as either a single `date` or a `from`/`to` pair, and SHALL NOT be inferred from the current time, because a broadcast started near midnight would otherwise remind the wrong day's members with no visible sign of the mistake. Supplying both forms, or half of the pair, SHALL be rejected.

The criterion SHALL be stated explicitly as either `MISSING_UPDATE` — the account recorded no daily update — or `MISSING_BOTH` — the account recorded neither an attendance submission nor a daily update. When omitted it SHALL default to `MISSING_UPDATE`, so that an existing single-date broadcast is unchanged.

Over a range the criterion SHALL be evaluated per counted day and the account SHALL be targeted only when the number of days it failed reaches `minMissedDays`, which SHALL default to 1. An optional `daysOfWeek` set SHALL restrict which days in the range count, using the 0-is-Sunday numbering the channel schedule uses; omitting it SHALL count every day in the range. A range SHALL be rejected when it is reversed, when its end is later than the current Dhaka date, when it spans more than 92 days, or when `daysOfWeek` leaves no day counted.

Whether someone is missing SHALL be decided per account, not per member record, and SHALL match the definition the dashboard applies for the same period, criterion and threshold, so that "missing" cannot mean one thing on screen and another in a DM.

#### Scenario: Targets resolved for a date across servers

- **WHEN** a broadcast is started for a date with the default criterion
- **THEN** the targets are the members of every configured server whose account has no daily update recorded for that date anywhere

#### Scenario: A person missing everywhere is targeted once per server record

- **WHEN** a Discord account is a current member of two configured servers and fails the criterion
- **THEN** a recipient record is created for each of that account's member records, giving each server its own audit trail
- **AND** the account is contacted exactly once, because delivery is grouped by Discord account

#### Scenario: A person who posted in one server is not reminded at all

- **WHEN** a Discord account posted an update in one configured server and not in the other on the date
- **THEN** no recipient record is created for either server
- **AND** they are not contacted, because they did the day's work and owe it only once

#### Scenario: Departed members excluded

- **WHEN** a member has left the server their record belongs to
- **THEN** that record is not targeted, whether or not they submitted an update that day
- **AND** their record in a server they are still in is targeted normally

#### Scenario: Period omitted

- **WHEN** a broadcast is requested with neither a date nor a range
- **THEN** the request is rejected with a validation error

#### Scenario: Both a date and a range supplied

- **WHEN** a broadcast is requested with `date` together with `from` or `to`
- **THEN** the request is rejected with a validation error naming the conflict

#### Scenario: Malformed or future date

- **WHEN** the requested date is not a valid `YYYY-MM-DD` Dhaka date, or is later than the current Dhaka date
- **THEN** the request is rejected with a validation error

#### Scenario: Range ending in the future

- **WHEN** a broadcast is requested for a range whose `to` is later than the current Dhaka date
- **THEN** the request is rejected, because there is nothing to be missing yet

#### Scenario: Range beyond the cap

- **WHEN** a broadcast is requested for a range spanning more than 92 days
- **THEN** the request is rejected stating the maximum span, so a mistyped year cannot become a mass DM

#### Scenario: Nobody is missing in any server

- **WHEN** no account in any configured server fails the criterion enough times to reach the threshold
- **THEN** no broadcast is started and the response says the target list is empty

#### Scenario: A server filter does not narrow the credit

- **WHEN** a broadcast is restricted to one configured server and one of its members posted their update in a different server
- **THEN** that member is not targeted
- **AND** the restriction limits which servers' members may be reminded, never what counts as having submitted

#### Scenario: Missed two of the past three days

- **WHEN** a broadcast is started for a three-day range with criterion `MISSING_BOTH` and `minMissedDays` of 2
- **THEN** exactly the accounts that submitted neither attendance nor a daily update on at least two of the three counted days are targeted
- **AND** an account that failed only one of the three days is not targeted

#### Scenario: Attendance alone exempts a day under MISSING_BOTH

- **WHEN** the criterion is `MISSING_BOTH` and an account submitted attendance but posted no update on a day in the range
- **THEN** that day does not count towards the account's threshold

#### Scenario: The default criterion preserves the existing broadcast

- **WHEN** a broadcast is started for a single date with no criterion stated
- **THEN** the accounts targeted are exactly those a broadcast for that date targeted before ranges existed
- **AND** an account that submitted attendance but posted no update is still targeted

#### Scenario: Excluded weekdays do not count against anybody

- **WHEN** a broadcast is started for a range with a `daysOfWeek` set that excludes a day on which an account did nothing
- **THEN** that day does not count towards the account's threshold

#### Scenario: A weekday set leaving no counted day

- **WHEN** a broadcast is requested for a range whose `daysOfWeek` set matches no day in it
- **THEN** the request is rejected rather than producing an empty or universal target list

### Requirement: The target list can be previewed before sending

The system SHALL let an administrator see how many members, and which members, would be targeted for a date or a range without sending anything. The preview SHALL accept the same period, criterion, threshold, weekday set and server restriction as the send, and SHALL apply them identically.

#### Scenario: Preview a date

- **WHEN** an administrator requests the targets for a date
- **THEN** the response reports the count and the targeted members
- **AND** no broadcast session is created and no DM is sent

#### Scenario: Preview a range with a threshold

- **WHEN** an administrator requests the targets for a range with a criterion and a minimum missed-day count
- **THEN** the response reports the count and the targeted members for exactly those criteria
- **AND** each target carries the number of counted days it failed
- **AND** no broadcast session is created and no DM is sent

#### Scenario: Preview matches the send

- **WHEN** a broadcast is started with the same period and criteria immediately after a preview
- **THEN** the target list is recomputed at that moment rather than reused, so a member who submitted in between is not targeted

#### Scenario: Preview rejects what the send rejects

- **WHEN** a preview is requested with a reversed range, a range beyond the cap, or a future range end
- **THEN** it is rejected with the same validation error the send would give

### Requirement: Two broadcasts for the same date cannot run at once

The system SHALL refuse to start a broadcast whose period OVERLAPS the period of another broadcast that is still running, so that a repeated click cannot schedule a second mass DM behind the first. Two periods SHALL be treated as overlapping when either shares any Dhaka date with the other. This restriction SHALL be global across configured servers rather than per server, and SHALL be independent of the criterion, threshold and weekday set of either broadcast, because the constraint it protects — the bot's single shared DM budget — is global and is unaffected by how the target list was computed.

#### Scenario: Second broadcast while one is running

- **WHEN** a broadcast for a date is started while an unfinished broadcast covering that date exists
- **THEN** the request is rejected with a conflict response identifying the running broadcast and the period it covers

#### Scenario: Overlapping ranges

- **WHEN** a broadcast for 2026-08-16 to 2026-08-18 is started while an unfinished broadcast for 2026-08-18 to 2026-08-20 exists
- **THEN** the request is rejected, because the two share a date

#### Scenario: A single date inside a running range

- **WHEN** a broadcast for a single date is started while an unfinished broadcast for a range containing that date exists
- **THEN** the request is rejected

#### Scenario: The conflict is not escapable by naming a server

- **WHEN** a broadcast is started while an unfinished broadcast covering an overlapping period exists
- **THEN** the request is rejected regardless of which servers either broadcast covers, because both draw on the same DM budget

#### Scenario: The conflict is not escapable by changing the criterion

- **WHEN** a broadcast with criterion `MISSING_BOTH` is started while an unfinished broadcast with criterion `MISSING_UPDATE` covers an overlapping period
- **THEN** the request is rejected

#### Scenario: Second broadcast after the first finished

- **WHEN** a broadcast is started after the previous overlapping one reached a terminal state
- **THEN** it is accepted and its target list is computed fresh across every configured server

#### Scenario: Non-overlapping periods

- **WHEN** broadcasts for two periods sharing no date are started
- **THEN** both are accepted

## ADDED Requirements

### Requirement: A broadcast records the criteria that produced its target list

The system SHALL persist, on every broadcast session, the period it covered as a start and an end Dhaka date, the criterion, the minimum missed-day count, and the weekday set it applied, alongside the message text. A single-date broadcast SHALL record the same date as both ends.

These SHALL be readable wherever the broadcast is read, because recomputing "who would this have targeted" from current data gives a different answer as members join and leave, and an administrator reviewing a past broadcast must be able to see which rule produced its recipient list.

#### Scenario: Criteria stored with the run

- **WHEN** a broadcast is started for a range with a criterion, a threshold and a weekday set
- **THEN** the session record holds the start date, the end date, the criterion, the threshold, the weekday set, and the message

#### Scenario: Single-date broadcast recorded as a one-day period

- **WHEN** a broadcast is started for a single date
- **THEN** the session record holds that date as both its start and its end

#### Scenario: Criteria visible in the history

- **WHEN** the broadcast history is read
- **THEN** each entry reports the period it covered and the criteria it applied

#### Scenario: Criteria visible on the progress read

- **WHEN** a running broadcast's progress is read
- **THEN** the response reports the period and criteria the run is working from
