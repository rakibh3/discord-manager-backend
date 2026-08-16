## ADDED Requirements

### Requirement: Endpoints reachable without credentials are rate limited

The system SHALL apply a request budget to every endpoint that can be called without an administrator token. An endpoint added without a budget SHALL be treated as a defect, not as an accepted default.

#### Scenario: Public endpoint carries a budget

- **WHEN** a request arrives at a public attendance endpoint
- **THEN** it is counted against a budget before any directory lookup or database write is attempted

#### Scenario: Administrator endpoints unaffected

- **WHEN** an authenticated administrator calls a dashboard or sync endpoint
- **THEN** the public budget does not apply to it

### Requirement: Budgets are scoped to the caller and sized to the endpoint's real use

The system SHALL count requests per calling client address, per endpoint, over a fixed window. The verification endpoint's budget SHALL accommodate a form that re-checks a handle as the student types; the submission endpoint's budget SHALL be materially tighter, because a legitimate student submits once per day.

#### Scenario: Student fills the form normally

- **WHEN** a student types a handle, triggering several debounced verification calls, and then submits once
- **THEN** no request is throttled

#### Scenario: Verification budget exhausted

- **WHEN** one client address exceeds the verification budget within the window
- **THEN** further verification requests from that address are throttled until the window rolls over

#### Scenario: Submission budget is tighter than verification

- **WHEN** the two budgets are compared
- **THEN** the submission endpoint permits materially fewer requests per window than the verification endpoint

#### Scenario: Budgets are independent

- **WHEN** one client address exhausts the verification budget
- **THEN** its submission budget is unaffected, and the reverse also holds

#### Scenario: One client does not throttle another

- **WHEN** one client address is throttled
- **THEN** requests from a different address are served normally

### Requirement: A throttled request is refused informatively and cheaply

A throttled request SHALL receive the standard too-many-requests outcome in the same response envelope every other endpoint uses, SHALL carry a message telling the caller to wait, and SHALL NOT reach the database.

#### Scenario: Throttled response shape

- **WHEN** a request is throttled
- **THEN** the response uses the application's standard envelope with a `429` status
- **AND** carries a human-readable message rather than a bare status

#### Scenario: Throttled request performs no work

- **WHEN** a request is throttled
- **THEN** no member lookup, no attendance write, and no contact-detail update occurs

#### Scenario: Throttling does not reveal membership

- **WHEN** a throttled verification request would have concerned a real member
- **THEN** the response is identical to one that would have concerned an unknown handle

### Requirement: The client address is derived from a trusted source

Because the API runs behind a proxy in deployment, the system SHALL derive the client address from the proxy's forwarded-for header only when the application is explicitly configured to trust that proxy, and SHALL otherwise use the direct connection address.

#### Scenario: Deployed behind a trusted proxy

- **WHEN** proxy trust is configured and a request arrives with a forwarded-for header
- **THEN** the budget is counted against the originating client address, not the proxy's

#### Scenario: Proxy trust not configured

- **WHEN** proxy trust is not configured and a request arrives with a forwarded-for header
- **THEN** the header is ignored and the direct connection address is used
- **AND** a caller cannot evade the budget by supplying a forged header

### Requirement: The counter store is replaceable without changing routes

The system SHALL keep the rate-limiter's counting store behind a single configuration point, so that moving from process-local counting to a shared store does not require editing any route or controller.

#### Scenario: Store swapped

- **WHEN** the counting store is changed
- **THEN** only the rate-limiter's own module changes
- **AND** the routes that apply the limiters are untouched

#### Scenario: Process-local counting acknowledged

- **WHEN** the application runs as more than one process against a process-local store
- **THEN** each process counts independently, and the effective budget is the per-endpoint budget multiplied by the process count
