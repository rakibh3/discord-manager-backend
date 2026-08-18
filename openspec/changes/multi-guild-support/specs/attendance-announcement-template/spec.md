## MODIFIED Requirements

### Requirement: Mention targets are validated on save and resolved at post time

The system SHALL validate the shape of every allowlist entry when it is saved — role entries as Discord snowflakes, member entries against the accepted Discord handle format — and SHALL reject a save that fails those checks. A member entry SHALL be accepted when it resolves to a current member of **any** configured server. Resolution to a live role or member SHALL happen when the message is posted and SHALL be performed **separately within each configured server**: an entry that does not resolve in a given server SHALL be dropped from that server's post and recorded against it, and SHALL NOT prevent the announcement from being posted in that server or any other.

#### Scenario: Malformed role ID

- **WHEN** an administrator saves a role entry that is not a 17-20 digit snowflake
- **THEN** the save is rejected and the stored allowlist is unchanged

#### Scenario: A handle that exists in only one server

- **WHEN** an administrator saves a handle that is a current member of one configured server but not the other
- **THEN** the save is accepted
- **AND** the post mentions them in the server they are a member of and records them as unresolved for the other

#### Scenario: A member in the allowlist has left the guild

- **WHEN** the announcement is posted and one allowlisted handle no longer matches a member in that server
- **THEN** the message is posted in that server mentioning the targets that did resolve
- **AND** the unresolved handle is recorded on that server's send outcome

#### Scenario: A role ID belongs to only one server

- **WHEN** the announcement is posted and an allowlisted role identifier exists in one configured server and not in another
- **THEN** the role is mentioned in the server it exists in
- **AND** it is recorded as unresolved on the other server's outcome, without withholding that server's message

#### Scenario: A role in the allowlist was deleted

- **WHEN** the announcement is posted and an allowlisted role ID no longer exists in a server that previously had it
- **THEN** the message is posted in that server without that mention and the missing role is recorded

#### Scenario: Handles resolve through the shared member lookup

- **WHEN** an allowlisted handle is resolved for a server
- **THEN** it is resolved through the same normalized, current-member lookup the attendance form uses, scoped to that server, so "who counts as a member" keeps one definition

## ADDED Requirements

### Requirement: Mention safety holds independently in every server

The system SHALL build each server's permitted mentions from the structured allowlist alone, resolved within that server, and SHALL never parse mentions out of the message body. The everyone-mention SHALL remain a separate explicit choice and SHALL apply in every server the announcement is posted to.

#### Scenario: A stray everyone-mention in the body

- **WHEN** the body contains text that would otherwise resolve an everyone-mention and the explicit everyone flag is off
- **THEN** no server's post notifies everyone

#### Scenario: The everyone flag applies everywhere

- **WHEN** the explicit everyone flag is on
- **THEN** every configured server's post carries the everyone-mention, because the flag is a property of the one shared template

#### Scenario: One server's unresolved targets do not affect another's mentions

- **WHEN** a target resolves in one server and not in another
- **THEN** the resolving server's post carries that mention and the other server's post does not
- **AND** neither post carries a mention the allowlist does not name
