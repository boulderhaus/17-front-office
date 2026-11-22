# Owner dashboard and action inbox

## Product decision

The dashboard separates **work that needs an owner** from the permanent call record:

- **Needs attention** contains only open callback tasks. Emergencies sort first, then due time.
- Each item explains why it exists, links to the originating call, and can be marked done.
- **Recent calls** remains the evidence ledger for recordings, transcripts, intake, booking state, and alerts.
- Setup, billing, calendar, and usage stay visible without competing with urgent work.

This follows the useful part of Attio's model without turning a small-shop phone product into a general CRM: tasks are tied to records, can be created automatically by workflow events, and live in one queue that can be sorted or grouped. Saved views and team assignment are later features, not V1 requirements.

## Automatic task triggers

- Life-safety or urgent escalation
- Caller explicitly asks for a human
- Appointment requires owner confirmation
- Provider ends without a trustworthy final payload
- Booking or integration failure that still needs a usable owner outcome

## Sources

- [Attio: Tasks](https://attio.com/help/reference/productivity-collaborating/tasks)
- [Attio: Objects, lists, and views](https://attio.com/help/reference/attio-101/attios-data-model/define-your-data-model-objects-lists-and-views)
- [Attio: Filter and sort views](https://attio.com/help/reference/managing-your-data/views/filter-and-sort-views)
