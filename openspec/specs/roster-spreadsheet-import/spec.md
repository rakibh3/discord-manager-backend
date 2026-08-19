# roster-spreadsheet-import Specification

## Purpose

Defines how the enrolment roster is populated: an administrator uploads the spreadsheet the program already maintains, and its rows are loaded into the roster. The shape of this capability is decided almost entirely by what happens when an upload is wrong. Columns are located by header name rather than by position, because an administrator who reorders or inserts a column would otherwise load phone numbers into the email field with nothing appearing to be wrong. Rows are validated individually and reported by their workbook row number, so one bad cell does not discard the other four hundred ninety-nine rows and the administrator can find the offending line without guessing. Loading is an upsert keyed on the normalized email and can never deactivate or delete anybody — a truncated or wrong-sheet upload would otherwise remove people from the roster in a single statement, and with enforcement enabled that removal locks those students out of submitting attendance with no error raised anywhere. Removing an entry stays a separate, explicit action. A partially successful import is therefore a success carrying a summary rather than an error: the valid rows really were loaded, and an error status would invite a re-upload under the belief that nothing took effect. Writes go out in bounded batches, each in its own transaction, so a long-running load does not hold one transaction open against the same database the public attendance form is reading. Every attempt is recorded with its file name, its administrator, and its counts, because an unexplained change to who may submit attendance has to be traceable to a person and a file.

## Requirements

### Requirement: The roster is loaded from an uploaded spreadsheet workbook

The system SHALL expose an authenticated administrator endpoint that accepts a single spreadsheet workbook as a multipart file upload and loads its rows into the roster. The endpoint SHALL require an administrator token; it is the only write path that can change who is allowed to submit attendance, so it SHALL NOT be reachable without credentials.

The endpoint SHALL accept the Office Open XML workbook format (`.xlsx`) and comma-separated values (`.csv`), and SHALL reject any other content, deciding on the file's actual parseability rather than on its declared MIME type alone, because the declared type is supplied by the caller.

The legacy binary Excel format (`.xls`) SHALL be refused with a message telling the administrator to re-save the file as `.xlsx`. It is not readable by the parser, and an administrator whose file simply fails to parse has no way to know that the format is the reason.

#### Scenario: Workbook uploaded by an administrator

- **WHEN** an administrator uploads a valid `.xlsx` workbook with a recognized header row
- **THEN** its rows are loaded into the roster and a summary of the load is returned

#### Scenario: Upload without credentials

- **WHEN** the import endpoint is called with no administrator token
- **THEN** the request is rejected as unauthorized and no file is parsed

#### Scenario: File of an unsupported type

- **WHEN** a file that is not a supported workbook is uploaded
- **THEN** the request is rejected as a validation failure naming the accepted formats
- **AND** no roster entry is created or changed

#### Scenario: Legacy binary Excel file

- **WHEN** a file in the legacy binary `.xls` format is uploaded
- **THEN** the request is rejected with a message instructing the administrator to re-save it as `.xlsx`
- **AND** no roster entry is created or changed

#### Scenario: Misdeclared content type

- **WHEN** a file declaring a spreadsheet content type is uploaded but cannot be parsed as a workbook
- **THEN** the request is rejected as a validation failure rather than reported as an internal error

#### Scenario: No file in the request

- **WHEN** the endpoint is called with no file attached
- **THEN** the request is rejected as a validation failure naming the expected field

### Requirement: Upload size and row count are bounded before any parsing

The system SHALL enforce a maximum upload size and a maximum row count, and SHALL reject a workbook exceeding either. The size limit SHALL be applied by the upload handler before the file is parsed, so an oversized file is refused without being read into memory.

#### Scenario: File larger than the limit

- **WHEN** a file exceeding the configured size limit is uploaded
- **THEN** the request is rejected as a validation failure naming the limit
- **AND** the file is not parsed

#### Scenario: Workbook with more rows than the limit

- **WHEN** a parseable workbook containing more data rows than the configured maximum is uploaded
- **THEN** the request is rejected as a validation failure naming the limit
- **AND** no roster entry is created or changed

#### Scenario: Workbook within both limits

- **WHEN** a workbook within the size and row limits is uploaded
- **THEN** it is parsed and loaded

### Requirement: Columns are located by header name, not by position

The system SHALL read the workbook's first non-empty row as a header row and map its cells onto the name, email, and phone fields by comparing header text case-insensitively and ignoring surrounding whitespace, accepting a documented set of aliases for each field. Columns SHALL NOT be identified by their position, because an administrator reordering or inserting a column would otherwise load phone numbers into the email field with nothing appearing to be wrong.

A workbook whose header row carries no recognizable email column SHALL be rejected as a whole, before any row is written, and the rejection SHALL name the headers that were found and the aliases that are accepted. Columns the system does not recognize SHALL be ignored rather than treated as an error.

#### Scenario: Headers in a different order

- **WHEN** a workbook's columns are ordered phone, email, name
- **THEN** each column is mapped to its field by its header text and the rows load correctly

#### Scenario: Header text differing in case and spacing

- **WHEN** a header cell reads ` Email Address `
- **THEN** it is recognized as the email column

#### Scenario: No email column present

- **WHEN** a workbook's header row names only a name column and a phone column
- **THEN** the upload is rejected before any row is written
- **AND** the message names the headers found and the accepted aliases

#### Scenario: Unrecognized extra columns

- **WHEN** a workbook carries additional columns such as a batch or a roll number
- **THEN** those columns are ignored and the recognized columns load normally

#### Scenario: Name column absent

- **WHEN** a workbook carries an email column but no name column
- **THEN** the upload is rejected before any row is written, because an entry without a name cannot be identified by an administrator reading the roster

### Requirement: Rows are validated individually and invalid rows are reported by row number

The system SHALL validate each data row on its own — a well-formed email address, a non-empty name, and a phone number that is either absent or well-formed — and SHALL load every row that passes while skipping every row that fails. A failing row SHALL NOT prevent the rest of the workbook from loading.

Each skipped row SHALL be reported with its row number as it appears in the workbook and the reason it was skipped, so that an administrator can correct the source spreadsheet without guessing which line is wrong.

#### Scenario: A single malformed row among valid ones

- **WHEN** a workbook of one hundred rows contains one row whose email cell is not a valid address
- **THEN** ninety-nine rows are loaded
- **AND** the response reports the offending row's number and that its email address was invalid

#### Scenario: Row missing an email address

- **WHEN** a row carries a name but an empty email cell
- **THEN** that row is skipped and reported as missing an email address

#### Scenario: Row missing a name

- **WHEN** a row carries a valid email address but an empty name cell
- **THEN** that row is skipped and reported as missing a name

#### Scenario: Blank rows

- **WHEN** a workbook contains trailing or interspersed rows with no values in any recognized column
- **THEN** those rows are ignored silently rather than reported as errors

#### Scenario: Every row invalid

- **WHEN** no row in a workbook passes validation
- **THEN** the response reports that nothing was loaded and lists the reasons
- **AND** the roster is left unchanged

### Requirement: Loading upserts on email and never removes an entry the workbook omits

The system SHALL load each valid row by normalized email address: an address the roster does not hold SHALL create an entry, and an address it already holds SHALL update that entry's name and phone number and reactivate it if it was inactive. An entry whose email address does not appear in the uploaded workbook SHALL be left untouched.

An import SHALL NOT be able to deactivate or delete anybody. A partial, truncated, or wrong-sheet upload would otherwise remove people from the roster in a single statement, and with enforcement enabled that removal locks those students out of submitting attendance with no error raised anywhere. Removing an entry is a separate, explicit administrator action.

#### Scenario: New address

- **WHEN** a row carries an email address the roster does not hold
- **THEN** an active entry is created from that row

#### Scenario: Existing address with corrected details

- **WHEN** a row carries an email address an entry already holds, with a different name and phone number
- **THEN** that entry's name and phone number are updated to the imported values

#### Scenario: Entries absent from the workbook

- **WHEN** a workbook containing ten of the roster's two thousand addresses is imported
- **THEN** ten entries are created or updated
- **AND** the other one thousand nine hundred ninety remain exactly as they were, still active

#### Scenario: Truncated upload

- **WHEN** an administrator mistakenly uploads a workbook containing a single row
- **THEN** one entry is created or updated and no other entry is affected
- **AND** no student is locked out as a result

#### Scenario: Inactive entry present in the workbook

- **WHEN** a workbook carries the address of an entry that was previously deactivated
- **THEN** that entry is updated and reactivated

### Requirement: An address repeated within one workbook resolves to one entry and is reported

The system SHALL tolerate the same normalized email address appearing on more than one row of a single workbook. The last such row SHALL determine the stored entry, and the repetition SHALL be reported in the response with the row numbers involved, because a repeated address is usually a mistake in the source spreadsheet and silently absorbing it hides that mistake.

#### Scenario: Address on two rows

- **WHEN** a workbook carries the same address on row 12 and row 40 with different phone numbers
- **THEN** one entry exists afterwards holding row 40's values
- **AND** the response reports the address as repeated, naming both rows

#### Scenario: Addresses differing only by case

- **WHEN** a workbook carries `Rakib@example.com` and `rakib@EXAMPLE.com` on separate rows
- **THEN** they are treated as the same address and resolve to one entry

### Requirement: A partially successful import is a success carrying a summary

The system SHALL answer a workbook containing both valid and invalid rows with a success outcome and a summary reporting how many entries were created, how many were updated, how many rows were skipped, how many addresses were repeated, how many rows were collapsed into an earlier row carrying the same address, and the total number of data rows read. It SHALL NOT report an error status because some rows failed.

The valid rows really were loaded; an error status would tell the administrator nothing happened and invite them to re-upload a corrected sheet under the belief that the first attempt did not take effect.

#### Scenario: Mixed workbook

- **WHEN** a workbook of five hundred rows loads four hundred ninety of them and skips ten
- **THEN** the response is a success carrying counts of created, updated, skipped, and total rows
- **AND** the ten skipped rows are listed with their row numbers and reasons

#### Scenario: Fully valid workbook

- **WHEN** every row of a workbook loads
- **THEN** the response is a success with a skipped count of zero and an empty skipped-row list

#### Scenario: Summary counts reconcile

- **WHEN** any import completes
- **THEN** the created, updated, skipped, and collapsed-duplicate counts together account for every data row read, excluding rows ignored as blank
- **AND** a row collapsed into an earlier row carrying the same address is counted as a collapsed duplicate rather than as skipped, because nothing about it was rejected

### Requirement: Rows are written in bounded batches rather than one transaction

The system SHALL write the loaded rows in bounded batches, each batch in its own transaction, rather than holding one transaction open across the whole workbook. A roster large enough to matter would otherwise hold a single long transaction against the same database the public attendance form is reading, and a failure near the end would discard the entire load.

A batch that fails SHALL be reported in the summary while the remaining batches continue, consistent with a partial import being a success.

#### Scenario: Large workbook

- **WHEN** a workbook of several thousand valid rows is imported
- **THEN** the rows are written in batches, each committed independently

#### Scenario: One batch fails

- **WHEN** one batch fails to commit while the others succeed
- **THEN** the successfully committed entries remain
- **AND** the response reports the failure in its summary rather than claiming the whole import failed

### Requirement: Every import is recorded for audit

The system SHALL record each import attempt with the uploaded file's name, the administrator who performed it, the time it ran, and the resulting counts, and SHALL expose that history to administrators. An unexplained change to who is allowed to submit attendance must be traceable to a person and a file.

#### Scenario: Import recorded

- **WHEN** an import completes
- **THEN** a record is stored holding the file name, the administrator, the time, and the created, updated, and skipped counts

#### Scenario: Rejected upload

- **WHEN** an upload is rejected because its header row carried no email column
- **THEN** no roster entry is changed
- **AND** the rejection is not recorded as a successful import

#### Scenario: History readable

- **WHEN** an administrator reads the import history
- **THEN** past imports are listed most recent first with their file names, administrators, times, and counts

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
