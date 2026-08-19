## ADDED Requirements

### Requirement: The window reports whether an enrolled email address is required

The window projection SHALL report whether roster enforcement is currently enabled, so the form can tell a student in advance that the email address they enter must be the one they are enrolled under, rather than discovering it only when their submission is refused.

The reported value SHALL be the stored enforcement setting itself, read from the same place the submission path reads it, so the form can never advertise a requirement different from the one actually enforced.

#### Scenario: Enforcement enabled

- **WHEN** the window is read while roster enforcement is enabled
- **THEN** the response reports that an enrolled email address is required

#### Scenario: Enforcement disabled

- **WHEN** the window is read while roster enforcement is disabled
- **THEN** the response reports that an enrolled email address is not required

#### Scenario: Setting never configured

- **WHEN** the window is read before any administrator has changed the setting
- **THEN** the response reports that an enrolled email address is not required, matching the default

#### Scenario: One source for the flag and the gate

- **WHEN** the reported value and the value the submission path enforces are compared at the same moment
- **THEN** they are the same value, because both are read from the stored setting

### Requirement: Reporting the requirement exposes no roster data

The window response SHALL carry the enforcement flag as a boolean and nothing else about the roster. It SHALL NOT carry a roster entry, a name, an email address, a phone number, a count of enrolled people, or the identity of the administrator who changed the setting.

Reading the window SHALL NOT allow a caller to learn whether any particular address is enrolled. The endpoint SHALL continue to accept no parameters, so there is nothing for a caller to probe with.

#### Scenario: Response inspected

- **WHEN** the window response is inspected while enforcement is enabled
- **THEN** it carries only a boolean for the requirement
- **AND** no roster entry, count, address, or editor identity appears anywhere in it

#### Scenario: Caller attempts to probe an address

- **WHEN** the window endpoint is called with an email address attached as a query parameter
- **THEN** the parameter is ignored and the same response is returned

### Requirement: Reading the window performs no roster-gated work

Serving the window SHALL remain a read of stored configuration only. Adding the enforcement flag SHALL NOT introduce a Discord API call, and SHALL NOT introduce a per-request roster scan; the flag is a single stored value, read the same way the schedule is.

#### Scenario: Window served under load

- **WHEN** the window endpoint is called repeatedly as students load the form
- **THEN** each call reads stored configuration only
- **AND** no Discord API request and no scan of roster entries is performed

## MODIFIED Requirements

### Requirement: The response exposes only the window

The response SHALL carry exactly the window projection: whether it is open, today's Dhaka civil date, the open and close times, the scheduled days of week, the enabled flag, the timezone name, the next opening instant, the closing instant of the current window, and whether an enrolled email address is required in order to submit. It SHALL NOT carry the identity or contact details of the administrator who last edited the schedule or the enforcement setting, scheduler run state or failure strings, any Discord channel or guild identifier, or any roster entry or roster count.

#### Scenario: Administrative fields withheld

- **WHEN** the window response is inspected
- **THEN** it contains no editor identity, no scheduler state, no internal failure message, and no channel or guild identifier

#### Scenario: Editor detail present on the stored row

- **WHEN** the stored schedule records the administrator who last changed it
- **THEN** that information is not present in the window response

#### Scenario: Scheduler has recorded a failure

- **WHEN** the scheduler's last run failed and recorded an error string
- **THEN** the window response is unaffected and carries no trace of that error

#### Scenario: Enforcement editor withheld

- **WHEN** the stored enforcement setting records the administrator who last changed it
- **THEN** the window response carries the requirement flag but not that administrator's identity
