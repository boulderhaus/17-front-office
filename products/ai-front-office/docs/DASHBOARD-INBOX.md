# Owner dashboard and action inbox

## Product decision

The dashboard separates **work that needs an owner** from the permanent call record:

- **Needs your attention** contains open and expired-snooze callback tasks. Emergencies sort first, then due time.
- Each item explains why it exists, links to the originating call, and supports complete, undo, and one-hour/four-hour/tomorrow snooze actions.
- A task closes automatically only after a verified calendar booking; uncertain provider outcomes always stay owned by a person.
- The selected-call panel keeps call back, map, transcript, and full evidence one click away.
- **Recent calls** and **Recent activity** remain the evidence ledger for intake, booking, alerts, and owner actions.
- Setup collapses after completion; a thin coverage strip and usage summary stay visible without competing with urgent work.

This follows the useful parts of Gmail, Todoist, Jobber, and Attio without turning a small-shop phone product into a general CRM: one familiar inbox, explicit ownership, reversible completion, deterministic automation, and contextual help. Saved views and team assignment are later features, not V1 requirements.

## Automatic task triggers

- Life-safety or urgent escalation
- Caller explicitly asks for a human
- Appointment requires owner confirmation
- Provider ends without a trustworthy final payload
- Booking or integration failure that still needs a usable owner outcome

## Automatic completion rule

- Only a calendar write that has been read back and verified can close the related task.
- Manual completion is reversible through the immediate Undo action.
- Snoozing changes when work appears; it never deletes the task or call evidence.

## Sources

- [Attio: Tasks](https://attio.com/help/reference/productivity-collaborating/tasks)
- [Attio: Objects, lists, and views](https://attio.com/help/reference/attio-101/attios-data-model/define-your-data-model-objects-lists-and-views)
- [Attio: Filter and sort views](https://attio.com/help/reference/managing-your-data/views/filter-and-sort-views)
- [Gmail: Snooze emails](https://support.google.com/mail/answer/7622010)
- [Todoist: Plan your day with Today](https://www.todoist.com/help/articles/plan-your-day-with-the-today-view-UVUXaiSs)
- [Jobber: Home](https://help.getjobber.com/en/articles/home/)
