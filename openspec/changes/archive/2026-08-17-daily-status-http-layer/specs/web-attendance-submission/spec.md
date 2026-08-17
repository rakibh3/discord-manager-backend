## MODIFIED Requirements

### Requirement: Attendance submissions are validated field by field

The system SHALL accept an attendance submission carrying exactly a full name, a phone number, an email address, and a Discord username, and SHALL reject the submission if any field is missing or malformed, reporting which fields failed.

#### Scenario: All fields valid

- **WHEN** a submission carries a name of at least 3 characters using English letters and spaces only, a valid Bangladeshi mobile number, a well-formed email, and a valid Discord handle
- **THEN** field validation passes and the submission proceeds to membership verification

#### Scenario: Name too short or containing digits

- **WHEN** the full name is shorter than 3 characters, or contains anything other than English letters and spaces
- **THEN** the submission is rejected as a validation error naming the field

#### Scenario: Name in Bengali script

- **WHEN** a student enters a name using Bengali characters (e.g. `রাকিবুল হাসান`)
- **THEN** the submission is rejected with a message stating that the name must use English letters and spaces only

#### Scenario: Name with only Bengali consonants

- **WHEN** a student enters a name using only Bengali consonant characters (e.g. `রকব`)
- **THEN** the submission is rejected, because non-Latin scripts are not accepted regardless of Unicode category

#### Scenario: Name with digits

- **WHEN** a student enters a name containing digits (e.g. `Rakib 2`)
- **THEN** the submission is rejected as a validation error

#### Scenario: Phone number in an accepted form

- **WHEN** the phone number is given as `01711000000` or as `+8801711000000`
- **THEN** it passes validation

#### Scenario: Phone number malformed

- **WHEN** the phone number does not match an accepted Bangladeshi mobile form
- **THEN** the submission is rejected as a validation error naming the field

#### Scenario: Email malformed

- **WHEN** the email address is not a well-formed address
- **THEN** the submission is rejected as a validation error naming the field

#### Scenario: Unknown fields supplied

- **WHEN** a submission carries fields beyond the four accepted ones
- **THEN** the extra fields are ignored and never written
