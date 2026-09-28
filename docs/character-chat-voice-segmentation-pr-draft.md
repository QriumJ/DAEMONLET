# Group voice inputs while preserving conversational turns

Completed replies previously triggered independent synthesis at nearly every
sentence ending. Short connected expressions were split into tiny calls. The
shared planner now groups short expressions and uses bounded structural cuts for
longer replies. After listening, the user requested a compromise: explicit
conversational turns can start a new group so the first sentence's delivery is
not carried through an entire changing thought.

The final default is `transition-v1` (96 preferred UTF-16 units), with the original
sentence splitter and initial 180-unit grouping retained for comparison/rollback.
The rainy-day fixture changes from 5 legacy calls to 3, and the short hesitation
from 3 to 1. Both chunk and complete profiles consume the same immutable plan.
No inference, model, LoRA, reference, seed, receipt, queue, credit or cancellation
policy is changed.

The existing voice CLI gains dependency-free planning and same-worker A/B
measurements with per-input/concatenated WAVs and a pending listening sheet.
Regression tests retain earlier multi-input ownership/cancellation races and add
Unicode, bounds, discourse turns, actual service profile/default selection,
entry-point, and PCM concatenation coverage. See the segmentation validation
report for exact host counts, real-device scope, and remaining listening work.

This is a local PR body draft. No remote branch or pull request was created for
this task, and no release, installed-app replacement or model upload was done.
