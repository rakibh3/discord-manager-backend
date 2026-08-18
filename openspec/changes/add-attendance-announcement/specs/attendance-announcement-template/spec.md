## ADDED Requirements

### Requirement: One stored announcement template, seeded with the current message

The system SHALL keep exactly one announcement template row, identified by a fixed key, holding the message body, the mention allowlist, and the termination-day threshold. The row SHALL be created lazily on first access with the message the program posts today, so the feature is usable before any administrator has edited anything and there is no separate seed step. Creation SHALL be safe against concurrent first access.

#### Scenario: First access on a fresh database

- **WHEN** the template is read for the first time
- **THEN** a row is created with the default Bangla message body, an empty mention allowlist, `@everyone` disabled, and the default termination-day threshold
- **AND** the created row is returned

#### Scenario: Subsequent access

- **WHEN** the template is read again
- **THEN** the stored row is returned unchanged and its audit timestamp is not rewritten

#### Scenario: Two readers arrive together

- **WHEN** the scheduler and an administrator request the template at the same moment on a cold deployment
- **THEN** exactly one row exists afterwards and both callers receive it

### Requirement: Placeholders resolve from live sources at render time

The system SHALL substitute the following placeholders when rendering the template, and SHALL resolve each from its live source rather than from text stored in the body:

- `{{date}}` — the current Asia/Dhaka civil date
- `{{close_time}}` — the close time stored on the `#daily-update` channel schedule
- `{{daily_update_channel_id}}` — a channel link built from `DAILY_UPDATE_CHANNEL_ID`
- `{{attendance_form_link}}` — the configured attendance form URL
- `{{termination_day}}` — the threshold stored on the template row

Rendering SHALL be the only place substitution happens, so a preview and a posted message produced from the same template and the same moment are identical.

#### Scenario: Close time changes

- **WHEN** an administrator changes the `#daily-update` close time to `22:00` and the announcement is rendered afterwards
- **THEN** the rendered message states `22:00` without the template body having been edited

#### Scenario: Date is the Dhaka civil date

- **WHEN** the announcement is rendered at 19:00 Dhaka on a day when the server's own clock is on the previous UTC date
- **THEN** `{{date}}` renders as the Dhaka date, not the server's date

#### Scenario: Channel placeholder renders as a link

- **WHEN** the template contains `{{daily_update_channel_id}}`
- **THEN** the rendered message contains a Discord channel mention that resolves to the configured daily-update channel

#### Scenario: A placeholder appears more than once

- **WHEN** the body uses `{{close_time}}` twice
- **THEN** every occurrence is substituted

### Requirement: Only the supported placeholders are accepted

The system SHALL reject a saved body containing a `{{…}}` placeholder outside the supported set, naming the unsupported placeholder and listing the supported ones. An unsupported placeholder SHALL NOT be silently left in the text, because a message posted to the whole program with a literal `{{attendance_link}}` in it is a visible failure that the save could have prevented.

#### Scenario: Misspelled placeholder

- **WHEN** an administrator saves a body containing `{{attendance_link}}`
- **THEN** the save is rejected with a message naming `attendance_link` and listing the supported placeholders
- **AND** the stored template is unchanged

#### Scenario: Supported placeholders only

- **WHEN** an administrator saves a body using any subset of the supported placeholders, including none of them
- **THEN** the save succeeds

### Requirement: Mentions come only from the structured allowlist

The system SHALL build the posted message's allowed mentions exclusively from the template's stored allowlist — role IDs, member handles, and the `@everyone` flag — and SHALL NOT resolve any mention written into the message body. Mention text typed into the body SHALL be inert.

#### Scenario: `@everyone` typed into the body

- **WHEN** the body contains the literal text `@everyone` and the `@everyone` flag is off
- **THEN** the posted message displays that text without notifying anybody

#### Scenario: A role mention pasted into the body

- **WHEN** the body contains a raw role mention for a role that is not in the allowlist
- **THEN** no member of that role is notified by the posted message

#### Scenario: Allowlisted targets are notified

- **WHEN** the allowlist names two roles and one member handle
- **THEN** the posted message notifies exactly those two roles and that member

### Requirement: `@everyone` is a separate, explicit choice

The system SHALL treat `@everyone` as its own stored flag, off by default, independent of the role and member lists. Enabling it SHALL be the only way the announcement can notify the whole guild.

#### Scenario: Flag off

- **WHEN** the flag is off and the announcement is posted
- **THEN** no `@everyone` or `@here` notification is produced, whatever the body or the role list contains

#### Scenario: Flag on

- **WHEN** an administrator enables the flag and the announcement is posted
- **THEN** the message notifies `@everyone`

#### Scenario: Enabling is auditable

- **WHEN** the flag is changed
- **THEN** the administrator who changed it and the time of the change are recorded on the template

### Requirement: Mention targets are validated on save and resolved at post time

The system SHALL validate the shape of every allowlist entry when it is saved — role entries as Discord snowflakes, member entries against the accepted Discord handle format — and SHALL reject a save that fails those checks. Resolution to a live role or member SHALL happen when the message is posted: an entry that no longer resolves SHALL be dropped from that post and recorded, and SHALL NOT prevent the announcement from being posted.

#### Scenario: Malformed role ID

- **WHEN** an administrator saves a role entry that is not a 17-20 digit snowflake
- **THEN** the save is rejected and the stored allowlist is unchanged

#### Scenario: A member in the allowlist has left the guild

- **WHEN** the announcement is posted and one allowlisted handle no longer matches a member in the guild
- **THEN** the message is posted mentioning the targets that did resolve
- **AND** the unresolved handle is recorded on the send outcome

#### Scenario: A role in the allowlist was deleted

- **WHEN** the announcement is posted and an allowlisted role ID no longer exists in the guild
- **THEN** the message is posted without that mention and the missing role is recorded

### Requirement: A saved template must produce a postable message

The system SHALL reject a template whose body is empty or whose rendered output would exceed Discord's per-message character limit, measuring the rendered output rather than the raw body so that placeholder expansion is accounted for.

#### Scenario: Empty body

- **WHEN** an administrator saves an empty or whitespace-only body
- **THEN** the save is rejected

#### Scenario: Body that renders too long

- **WHEN** the rendered message would exceed Discord's message length limit
- **THEN** the save is rejected with a message stating the rendered length and the limit

### Requirement: Administrators can preview the rendered message

The system SHALL expose the stored template together with its rendered output, its resolved mention targets, and the supported placeholder list to authenticated administrators, so a change can be checked before it reaches the channel.

#### Scenario: Reading the template

- **WHEN** an administrator requests the announcement configuration
- **THEN** the response includes the raw body, the rendered preview for today, the mention allowlist, the `@everyone` flag, the termination-day threshold, the supported placeholders, and the audit fields

#### Scenario: Unauthenticated request

- **WHEN** a request without a valid admin token reaches any announcement endpoint
- **THEN** it is rejected, since no student-facing client has any reason to read or change the template
