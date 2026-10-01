# Windows connection review follow-up

Windows PATH entries now trim surrounding whitespace and remove one matching pair of outside quotes before executable candidates are formed. Empty entries, embedded quotes and NULs are rejected. This preserves executable discovery for custom paths containing spaces.

Stopping the owned Windows tunnel supervisor sends stdin EOF, waits, then kills only that owned child if necessary. A second bounded wait confirms exit; a surviving child rejects with the fixed `CONNECTION_FAILED` code. Wait timers and exit listeners are released. The runtime retains its private working directory after an unconfirmed stop and permits a later explicit stop retry.

The manager reports an error, releases the local bridge, disables persistent automatic connection on disconnect and retains the owned running handle after stop failure. It does not publish disconnected success, discard the handle, or launch a replacement process. A later explicit disconnect can retry cleanup. Background callbacks consume already-reported cleanup rejection to avoid an unhandled rejection.

The original review identified possible edge cases by reading; it did not establish a real leftover process. Regression tests simulate kill failure and verify state propagation/handle retry, while native Windows tests confirm the normal Job Object cleanup path and unrelated-process survival. No process-name scan, broad kill or new process privilege is introduced.
