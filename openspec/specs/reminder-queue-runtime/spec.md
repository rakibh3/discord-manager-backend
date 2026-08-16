# reminder-queue-runtime Specification

## Purpose

Defines how reminder DMs are actually delivered: through a durable job queue in which one targeted member is one unit of work. The governing constraint is that the unit of retry must equal the unit of delivery — a broadcast to thousands of members driven from a request handler or a single long-running job has no way to resume after an interruption that does not either lose recipients or message them twice.

Two properties follow from delivering at Discord's pace rather than the database's. Delivery is throttled to a small, configurable number of messages per second, shared across every worker on the queue, so that a mass DM cannot trigger Discord's abuse protections. And because queue delivery is at-least-once, a repeated job must be harmless: a job is identified by its broadcast and member so the same pair cannot be enqueued twice, and every job reads the recipient's recorded state before sending. Where neither can be guaranteed — a DM sent but not yet recorded — a duplicate DM is the preferred outcome over a member recorded as reminded who never was.

The queue's datastore is a dependency of the reminder feature and of nothing else. Unreachable, it must not stop the HTTP API, the gateway connection, message ingestion, or the channel scheduler; it may only refuse a broadcast, visibly. The worker starts solely once the gateway reports ready, because a job cannot deliver a DM without a connected client, and it closes before the client is destroyed. Like the scheduler, it runs outside any HTTP request: nothing in it throws past its own boundary, and its health is reported to administrators rather than left in the logs.

## Requirements

### Requirement: Reminder DMs are delivered through a durable job queue

The system SHALL deliver reminder DMs through a persistent job queue rather than by iterating over recipients in a request handler or a single long-running job. Each targeted member SHALL be one unit of work, so that the unit of retry is the unit of delivery and an interruption cannot lose or repeat the whole run.

#### Scenario: Broadcast enqueued

- **WHEN** a reminder broadcast is started for a list of targeted members
- **THEN** one job is enqueued per targeted member
- **AND** the request returns without waiting for any DM to be sent

#### Scenario: Process restarts mid-broadcast

- **WHEN** the process stops while a broadcast is still being delivered and then starts again
- **THEN** the undelivered jobs are still queued and resume being processed
- **AND** members already recorded with an outcome are not sent a second DM

#### Scenario: Job unit is a single recipient

- **WHEN** one recipient's delivery fails permanently
- **THEN** only that recipient is affected and the remaining recipients continue to be processed

### Requirement: Delivery is rate limited below Discord's DM limits

The system SHALL pace DM delivery to a configured small number of messages per second, defaulting to two, so that a broadcast to thousands of members cannot trigger Discord's abuse protections. The configured rate SHALL be constrained to a safe range so that a mistaken value cannot remove the protection.

#### Scenario: Large broadcast is paced

- **WHEN** a broadcast targets thousands of members
- **THEN** DMs are sent at no more than the configured messages per second
- **AND** the broadcast completes over a period proportional to the target count rather than all at once

#### Scenario: Rate is configurable

- **WHEN** the messages-per-second setting is changed and the process restarts
- **THEN** delivery is paced at the new rate

#### Scenario: Unsafe rate rejected

- **WHEN** the configured rate is missing, non-numeric, zero, or above the permitted maximum
- **THEN** the effective rate falls back to a safe value within the permitted range

#### Scenario: Rate limit shared across workers

- **WHEN** more than one worker processes the same queue
- **THEN** the combined delivery rate still respects the configured limit

### Requirement: Transient failures are retried with backoff, permanent ones are not

The system SHALL retry a delivery that failed for a reason that could succeed later — a network error, a timeout, or a server-side error from Discord — using an exponential backoff, up to a bounded number of attempts. A failure whose cause cannot change SHALL NOT be retried.

#### Scenario: Transient failure

- **WHEN** a DM attempt fails with a network or server error
- **THEN** the job is retried after an increasing delay
- **AND** the recipient's outcome is not yet marked terminal

#### Scenario: Attempts exhausted

- **WHEN** every retry attempt for a recipient has failed
- **THEN** that recipient is recorded with a failed outcome and the error detail
- **AND** no further attempts are made for that recipient

#### Scenario: Permanent condition

- **WHEN** a DM attempt fails because the member cannot receive DMs or the account no longer exists
- **THEN** the outcome is recorded immediately and the job is not retried

#### Scenario: Discord signals a rate limit

- **WHEN** Discord responds that the bot is rate limited
- **THEN** processing pauses for the duration Discord indicates
- **AND** the job returns to the queue without consuming a retry attempt

### Requirement: A repeated job does not deliver a second DM

Queue delivery is at-least-once, so the system SHALL make a repeated job harmless. A job SHALL be identified so that enqueuing the same broadcast and member twice cannot create two jobs, and SHALL check the recipient's recorded state before sending so that a retry after a recorded success does nothing.

#### Scenario: Duplicate enqueue

- **WHEN** the same broadcast and member are enqueued twice
- **THEN** only one job exists for that pair

#### Scenario: Retry after a recorded outcome

- **WHEN** a job runs for a recipient whose outcome is already recorded as terminal
- **THEN** no DM is sent and the recorded outcome is left unchanged

#### Scenario: Failure between sending and recording

- **WHEN** a DM is sent but the process stops before the outcome is recorded
- **THEN** the retry may deliver the DM a second time, and this is preferred over a member being recorded as reminded without having been

### Requirement: The queue runtime is isolated from the rest of the process

The system SHALL treat the queue's datastore as a dependency of the reminder feature alone. A datastore that is unreachable SHALL NOT prevent the HTTP API from serving, the Discord gateway from connecting, message ingestion from running, or the channel scheduler from firing. No queue or worker code path SHALL throw past its own boundary.

#### Scenario: Datastore unavailable at startup

- **WHEN** the process starts and the queue datastore cannot be reached
- **THEN** the failure is logged
- **AND** the HTTP server, the bot, ingestion, and the channel scheduler all start normally

#### Scenario: Broadcast attempted with no datastore

- **WHEN** an administrator starts a broadcast while the queue datastore is unreachable
- **THEN** the request is refused with a service-unavailable response naming the datastore
- **AND** no broadcast session or recipient records are created

#### Scenario: Datastore fails mid-broadcast

- **WHEN** the connection to the queue datastore is lost during a broadcast
- **THEN** the error is logged and the worker keeps retrying the connection rather than terminating the process

#### Scenario: A job throws unexpectedly

- **WHEN** a job's processing raises an error that was not anticipated
- **THEN** the error is contained by the queue's failure handling and the process stays alive

### Requirement: The worker starts only with a ready gateway connection

The system SHALL start the queue worker only after the Discord gateway reports ready, because a job cannot deliver a DM without a connected client. If the bot never connects, the worker SHALL NOT be started.

#### Scenario: Bot connects

- **WHEN** the gateway connection becomes ready
- **THEN** the worker starts and begins processing queued jobs

#### Scenario: Bot never connects

- **WHEN** the bot fails to log in
- **THEN** the worker is not started
- **AND** the reminder status reports that it is not running, rather than jobs being consumed and failed against a disconnected client

#### Scenario: Worker disabled by configuration

- **WHEN** the worker is disabled for this process by configuration
- **THEN** no jobs are consumed by this process
- **AND** the administrator-facing endpoints for reading, starting, and cancelling broadcasts continue to work

### Requirement: The queue runtime's health is observable

The system SHALL expose, to an administrator, whether the worker is running, whether the queue datastore is reachable, how much work is outstanding, and the outcome of the most recent fallback announcement.

#### Scenario: Healthy runtime

- **WHEN** an administrator reads the reminder status
- **THEN** the response reports the worker as running, the datastore as reachable, and the current queue depth

#### Scenario: Datastore unreachable

- **WHEN** the queue datastore cannot be reached
- **THEN** the status reports it as unreachable with the reason

#### Scenario: Fallback announcement failed

- **WHEN** the most recent fallback announcement could not be posted
- **THEN** the status reports the failure and its cause

### Requirement: Shutdown does not abandon a delivery in flight

The system SHALL close the worker on a termination signal, allowing a job that is currently sending to finish, and SHALL do so before the Discord client is destroyed so that no job sends into a closing connection.

#### Scenario: Termination signal during a broadcast

- **WHEN** the process receives a termination signal while a DM is being sent
- **THEN** the worker stops accepting new jobs and the in-flight job is allowed to finish
- **AND** the worker is closed before the Discord client is destroyed

#### Scenario: Undelivered jobs after shutdown

- **WHEN** the process exits with jobs still queued
- **THEN** those jobs remain queued and are processed when a worker next runs

#### Scenario: Shutdown with no worker running

- **WHEN** the process receives a termination signal and the worker was never started
- **THEN** shutdown completes without error
