## MODIFIED Requirements

### Requirement: The announcement is posted to the configured attendance channel

The system SHALL post the announcement to the attendance channel **of every configured server**, resolving each by that server's configured attendance channel identifier, and SHALL confirm each is a text channel in the server it was configured under before posting there. No logic SHALL key off a channel's name. Posting SHALL be confined to a single module, so there is exactly one code path that writes to an attendance channel.

#### Scenario: Channels resolve

- **WHEN** each configured identifier names a text channel in the server it was configured under
- **THEN** the message is posted in each of those channels

#### Scenario: ID points at another guild's channel

- **WHEN** a configured attendance channel identifier resolves to a channel in a different guild than the server it was configured under
- **THEN** nothing is posted for that server and the mismatch is recorded as that server's send outcome
- **AND** the other servers are still posted to

#### Scenario: One server's channel is unreachable

- **WHEN** one server's attendance channel cannot be fetched
- **THEN** that server's outcome records the failure
- **AND** the remaining servers still receive the announcement

#### Scenario: Discord is not connected

- **WHEN** the announcement is due while the bot is not connected to the gateway
- **THEN** no post is attempted in any server and the outcome is recorded as a connection failure

### Requirement: The announcement is posted at most once per Dhaka day

The system SHALL record one send **per configured server** per key and Dhaka civil date, and SHALL claim that record before sending so that a second attempt for the same server and day does not post a second message. The claim SHALL be enforced by a database uniqueness constraint that includes the server, rather than by reading before writing, because a restart, a manual send racing the timed one, and a second replica can all attempt the send at the same moment. A claim for one server SHALL NOT consume another server's day.

#### Scenario: Process restarts at the announce time

- **WHEN** the process restarts while a post for today has already been recorded for a server
- **THEN** no second announcement is posted in that server

#### Scenario: Two attempts race

- **WHEN** the timed task and a manual send begin at the same instant
- **THEN** exactly one message is posted per server and the other attempt reports that today's announcement was already sent

#### Scenario: One server posted, one not

- **WHEN** the announcement posted successfully in one server and failed in another earlier the same day
- **THEN** a later attempt skips the server already posted to and retries the failed one
- **AND** the successful server is not posted to twice

#### Scenario: The next day

- **WHEN** the announce time is reached on the following Dhaka date
- **THEN** a new claim is taken per server and the announcement is posted again in each

#### Scenario: A failed send does not consume the day

- **WHEN** the post fails in a server because the bot lacks permission
- **THEN** the failure is recorded for that server and a later attempt on the same day is allowed to post there

#### Scenario: Retries within one send cannot duplicate a message

- **WHEN** the underlying request to Discord is retried because its response was lost
- **THEN** the retry is recognised as the same message rather than creating a second one in that server's channel

### Requirement: Every send outcome is recorded and reported

The system SHALL record each attempt's outcome **per configured server** — posted, refused as already sent, or failed with the reason — including the identifier of the posted message and any mention targets that could not be resolved in that server, and SHALL report the most recent outcome per server and the next scheduled run to administrators. A missing `Send Messages` permission on a server's attendance channel SHALL be reported distinctly and against that server, since its only other symptom is a channel that silently goes quiet.

#### Scenario: Successful post

- **WHEN** the announcement is posted in a server
- **THEN** that server's outcome records the server, the Dhaka date, the time, the posted message identifier, and the mention targets used

#### Scenario: Missing Send Messages permission in one server

- **WHEN** Discord refuses the post in one server because the bot lacks permission on its attendance channel
- **THEN** the status response reports a permission failure naming that server, the channel, and the required permission
- **AND** the other server's successful post is reported as such

#### Scenario: Reading status

- **WHEN** an administrator reads the announcement status
- **THEN** the response includes the shared schedule, whether this process runs the timed task, the next scheduled run, and — for each configured server — whether today has been posted and that server's last outcome

#### Scenario: Partial success is not reported as failure

- **WHEN** a send posts in one server and fails in another
- **THEN** the request is reported as a success carrying the failed server's reason, rather than as a request-level failure

## ADDED Requirements

### Requirement: One shared template and schedule drive every server's announcement

The system SHALL store one announcement template, one announcement schedule, and one mention allowlist, and SHALL apply them to every configured server. The timed task SHALL be registered once and fan out. No per-server body, time, weekday set, or enabled flag SHALL exist.

#### Scenario: One firing posts to every server

- **WHEN** the announce time is reached on an active weekday
- **THEN** one timed run posts the same rendered message to every configured server's attendance channel

#### Scenario: Editing the body reaches every server

- **WHEN** an administrator edits the announcement body
- **THEN** every configured server receives the edited message on the next post

#### Scenario: Disabling stops every server

- **WHEN** the announcement's enabled flag is turned off
- **THEN** no server receives a timed announcement

#### Scenario: The closing time is the one that locks every channel

- **WHEN** the rendered message states the closing time
- **THEN** it is read from the single stored channel schedule, which is the same schedule that locks every server's daily-update channel

#### Scenario: A manual send may name servers

- **WHEN** an administrator posts manually naming one or more configured servers
- **THEN** only those servers are posted to, each subject to its own once-per-day claim
- **AND** naming a server that is not configured is refused
