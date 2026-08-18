## ADDED Requirements

### Requirement: The submission window is readable without credentials

The system SHALL expose the current attendance submission window at a public endpoint that requires no administrator token, because the students who need it are directory members rather than user accounts and hold no credential. The endpoint SHALL be a read; it SHALL NOT accept parameters, and SHALL NOT modify any stored state.

#### Scenario: Anonymous caller reads the window

- **WHEN** the window endpoint is called with no authorization header
- **THEN** the window is returned with a success outcome

#### Scenario: Administrator token neither required nor rejected

- **WHEN** the window endpoint is called with a valid administrator token present
- **THEN** the same window is returned, unchanged by the presence of the token

#### Scenario: No parameters are read

- **WHEN** the window endpoint is called with arbitrary query parameters attached
- **THEN** they are ignored and the same window is returned

### Requirement: The window is always answerable

The endpoint SHALL always report a window. A schedule that has never been configured SHALL be materialized with the system defaults rather than reported as missing, and a paused schedule SHALL be reported as paused rather than as an error. A caller SHALL NOT receive a not-found outcome from this endpoint.

#### Scenario: No schedule row has ever been stored

- **WHEN** the window endpoint is called before any administrator has saved a schedule
- **THEN** the default schedule is materialized and returned as the window, with a success outcome

#### Scenario: Schedule is paused

- **WHEN** the stored schedule is disabled
- **THEN** the window is returned with a success outcome reporting that it is disabled, not an error

### Requirement: The window is derived from the stored schedule, never from the live channel

`isOpen` SHALL be computed from the stored open time, close time, days of week and enabled flag, evaluated against the current Dhaka clock. Serving this endpoint SHALL NOT perform a Discord API call, because it is requested by every student loading the form — thousands of times in an evening — against a bot that is concurrently synchronizing members and pacing reminder messages. It also answers the correct question: the student is submitting to the web form, not posting in the channel.

#### Scenario: Current time inside the scheduled window

- **WHEN** the current Dhaka weekday is in the schedule's days and the current Dhaka time of day is at or after the open time and before the close time, and the schedule is enabled
- **THEN** `isOpen` is true

#### Scenario: Current time outside the scheduled window

- **WHEN** the current Dhaka time of day is before the open time or at or after the close time
- **THEN** `isOpen` is false

#### Scenario: Today is not a scheduled day

- **WHEN** the current Dhaka weekday is not present in the schedule's days
- **THEN** `isOpen` is false regardless of the time of day

#### Scenario: Schedule disabled

- **WHEN** the schedule is disabled
- **THEN** `isOpen` is false even if the current time falls inside the stored open and close times

#### Scenario: Repeated calls perform no external work

- **WHEN** the endpoint is called many times in succession
- **THEN** no Discord API request is issued by any of them

#### Scenario: Channel overwrite changed by hand is not reflected

- **WHEN** an administrator manually locks the channel inside the scheduled window
- **THEN** `isOpen` still reports the schedule's answer, because the endpoint describes the form's hours rather than the channel's state

### Requirement: The response exposes only the window

The response SHALL carry exactly the window projection: whether it is open, today's Dhaka civil date, the open and close times, the scheduled days of week, the enabled flag, the timezone name, the next opening instant, and the closing instant of the current window. It SHALL NOT carry the identity or contact details of the administrator who last edited the schedule, scheduler run state or failure strings, or any Discord channel or guild identifier.

#### Scenario: Administrative fields withheld

- **WHEN** the window response is inspected
- **THEN** it contains no editor identity, no scheduler state, no internal failure message, and no channel or guild identifier

#### Scenario: Editor detail present on the stored row

- **WHEN** the stored schedule records the administrator who last changed it
- **THEN** that information is not present in the window response

#### Scenario: Scheduler has recorded a failure

- **WHEN** the scheduler's last run failed and recorded an error string
- **THEN** the window response is unaffected and carries no trace of that error

### Requirement: Times are wall-clock strings and instants are absolute

The open and close times SHALL be reported as Dhaka wall-clock strings in `HH:mm` form, exactly as stored, and the timezone SHALL be reported as a fixed name that is never accepted from a caller. The date SHALL be today's Dhaka civil date. The next opening and current closing values SHALL be absolute instants, produced by converting the schedule's Dhaka wall-clock times through the single module that owns Dhaka time conversion.

#### Scenario: Times echo the stored values

- **WHEN** the schedule stores an open time and a close time
- **THEN** the response reports those same strings without reformatting or conversion

#### Scenario: Date is the Dhaka civil date

- **WHEN** the endpoint is called at an instant where the Dhaka civil date differs from the server's own date
- **THEN** the reported date is the Dhaka one

#### Scenario: Timezone is reported, never accepted

- **WHEN** a caller supplies a timezone in the request
- **THEN** it is ignored and the fixed Dhaka timezone name is reported

#### Scenario: Instants correspond to the wall-clock times

- **WHEN** a closing instant is reported for a close time on a given Dhaka date
- **THEN** that instant is the moment the Dhaka wall clock reaches that close time on that date

### Requirement: The next opening instant is reported whenever the schedule will open again

`nextOpenAt` SHALL be the next future instant at which the window opens, searching forward across the schedule's days of week from the current moment. It SHALL be reported even while the window is currently open, in which case it names the following occurrence. It SHALL be null when and only when the schedule is disabled, since a disabled schedule never opens.

#### Scenario: Before today's opening on a scheduled day

- **WHEN** today is a scheduled day and the current Dhaka time is before the open time
- **THEN** `nextOpenAt` is today's opening instant

#### Scenario: After today's closing on a scheduled day

- **WHEN** today is a scheduled day and the current Dhaka time is at or after the close time
- **THEN** `nextOpenAt` is the opening instant of the next scheduled day

#### Scenario: Window currently open

- **WHEN** the window is open right now
- **THEN** `nextOpenAt` is the opening instant of the next scheduled occurrence, not the one currently in progress

#### Scenario: Today is not a scheduled day

- **WHEN** today is not in the schedule's days of week
- **THEN** `nextOpenAt` is the opening instant of the nearest future day that is

#### Scenario: Only one scheduled day per week

- **WHEN** the schedule contains a single day of week and that day has already passed this week
- **THEN** `nextOpenAt` is that day's opening instant in the following week

#### Scenario: Schedule disabled

- **WHEN** the schedule is disabled
- **THEN** `nextOpenAt` is null

### Requirement: The closing instant is reported only while the window is open

`closesAt` SHALL be the instant the currently open window closes. It SHALL be null when the window is not currently open, because there is no window in progress to close.

#### Scenario: Window open

- **WHEN** `isOpen` is true
- **THEN** `closesAt` is today's closing instant and is later than the current moment

#### Scenario: Window closed

- **WHEN** `isOpen` is false
- **THEN** `closesAt` is null

#### Scenario: Schedule disabled

- **WHEN** the schedule is disabled
- **THEN** `closesAt` is null

### Requirement: The window and the announced deadline share one source

The close time reported by this endpoint SHALL be read from the same stored schedule row that the channel scheduler locks the daily-update channel by and that the attendance announcement renders its closing time from. No second copy of the window SHALL be stored or configured for the public form.

#### Scenario: Administrator changes the close time

- **WHEN** an administrator saves a new close time on the schedule
- **THEN** the next window response reports the new close time, without any further deployment or configuration step

#### Scenario: Announcement and window agree

- **WHEN** the announcement's rendered closing time and the window response's close time are compared for the same day
- **THEN** they are identical, because both are read from the same stored value

### Requirement: Reading the window does not enforce the window

Exposing the window SHALL NOT change what the submission endpoint accepts. A submission from a verified member SHALL continue to be accepted outside the window exactly as it is inside it. The published window is guidance for the form, not an enforcement point.

#### Scenario: Submission outside the window

- **WHEN** a verified member submits attendance at a time when `isOpen` is false
- **THEN** the submission is accepted and recorded as it would be inside the window

#### Scenario: Window unavailable

- **WHEN** the window endpoint cannot be reached by the form
- **THEN** submission behavior is unchanged
