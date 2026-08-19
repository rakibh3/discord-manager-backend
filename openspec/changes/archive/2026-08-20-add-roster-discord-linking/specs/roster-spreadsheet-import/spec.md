## ADDED Requirements

### Requirement: An import never writes or clears an entry's Discord account

The system SHALL NOT write, overwrite, or clear an entry's recorded Discord account or its pairing instant during a spreadsheet import. An import SHALL continue to write only the name, the phone number, and the active flag on an entry it updates, and SHALL create new entries with no account recorded.

This is stated explicitly because the import already forces the active flag to true on every entry it updates, and extending that write-everything pattern to the new column is precisely the destructive behaviour forbidden here. Re-uploading the enrolment sheet is a routine administrative act; if it cleared the pairings, every learned account would be erased in bulk, silently, and the only symptom would be a report that suddenly shows the whole roster as unreachable.

The spreadsheet SHALL NOT be a source of Discord accounts. No header alias SHALL map a column onto the account field, so an administrator cannot introduce an unverified pairing by adding a column.

#### Scenario: Re-importing a sheet that includes a paired person

- **WHEN** a workbook containing the address of an already-paired entry is imported
- **THEN** the entry's name and phone number are updated from the sheet
- **AND** its Discord account and pairing instant are unchanged

#### Scenario: Import reinstating a deactivated paired entry

- **WHEN** a workbook contains the address of a deactivated entry that holds an account
- **THEN** the entry is reinstated
- **AND** it still holds the same account

#### Scenario: New rows create unpaired entries

- **WHEN** a workbook introduces addresses no entry holds
- **THEN** the created entries hold no account and no pairing instant

#### Scenario: A column that looks like a Discord handle

- **WHEN** a workbook carries a column headed with a Discord handle or user ID
- **THEN** the column is ignored for pairing purposes
- **AND** no entry gains an account from the file
