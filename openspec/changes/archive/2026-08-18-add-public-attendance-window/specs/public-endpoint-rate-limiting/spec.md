## MODIFIED Requirements

### Requirement: Budgets are scoped to the caller and sized to the endpoint's real use

The system SHALL count requests per calling client address, per endpoint, over a fixed window. The verification endpoint's budget SHALL accommodate a form that re-checks a handle as the student types; the window endpoint's budget SHALL accommodate a page load, and MAY be the same size as the verification budget since both are cheap reads driven by the form rather than by user input; the submission endpoint's budget SHALL be materially tighter, because a legitimate student submits once per day.

#### Scenario: Student fills the form normally

- **WHEN** a student loads the form, types a handle triggering several debounced verification calls, and then submits once
- **THEN** no request is throttled

#### Scenario: Verification budget exhausted

- **WHEN** one client address exceeds the verification budget within the window
- **THEN** further verification requests from that address are throttled until the window rolls over

#### Scenario: Window budget exhausted

- **WHEN** one client address exceeds the window endpoint's budget within the window period
- **THEN** further window requests from that address are throttled until the window period rolls over

#### Scenario: Submission budget is tighter than verification

- **WHEN** the two budgets are compared
- **THEN** the submission endpoint permits materially fewer requests per window than the verification endpoint

#### Scenario: Budgets are independent

- **WHEN** one client address exhausts the verification budget
- **THEN** its submission and window budgets are unaffected, and the same independence holds between every pair of public endpoints

#### Scenario: One client does not throttle another

- **WHEN** one client address is throttled
- **THEN** requests from a different address are served normally

## ADDED Requirements

### Requirement: The window endpoint carries a budget of its own

The public attendance window endpoint SHALL be rate limited per client address like every other endpoint reachable without a token. Its budget SHALL be registered in the shared limiter module rather than declared inline at the route, so the whole public surface's budgets remain visible and replaceable in one place.

#### Scenario: Window endpoint is limited

- **WHEN** a request arrives at the window endpoint
- **THEN** it is counted against a per-address budget before the schedule is read

#### Scenario: Limiter defined centrally

- **WHEN** the public route definitions are inspected
- **THEN** the window route references a limiter exported by the shared rate limit module, and defines no budget of its own
