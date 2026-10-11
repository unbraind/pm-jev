# Local triage latency baseline

Measured on main `7c0f0e0` with Ollama **0.35.1** and **tev1:4b**, digest
`9b5bb969e46c4b776826d6f2d401e22893205693f172653af6254897255025b8`.
The disposable real tracker contained one Feature, priority 3, with title
"Every login crashes with an unhandled exception" and description "Regression:
the application closes and users cannot sign in". No user backlog data was used.

| Scenario | Command/harness time | HTTP time | Input/output tokens | HTTP calls |
| --- | ---: | ---: | ---: | ---: |
| Original triage, initially no loaded models | 53,072 ms | 44,974 ms | 2,530 / 5 | 1 |
| Original triage, immediate warm repeat | 8,237 ms | 7,630 ms | 2,530 / 5 | 1 |

Server startup logs measured **25.30 seconds** to start the model runner in the
cold case. The System One response exposes answers and token usage, without
load/evaluation duration fields. The remaining cold-request time includes prompt
processing and scoring, plus scheduling; the difference between cold and warm
requests also includes cache effects. It must not all be labeled model load.
The first command had about 8.1 seconds outside HTTP under shared-host load; the
warm command had about 0.6 seconds. These are observations, not service guarantees.

An additional warm HTTP-only profile compared the same question catalog against
smaller state and separate single-question requests. Each request used
`keep_alive="10m"`; these calls measured the real local model.

| Request | HTTP time | Input/output tokens |
| --- | ---: | ---: |
| Original state, four questions | 16,676 ms | 2,530 / 5 |
| Only title and description, four questions | 20,257 ms | 2,466 / 5 |
| Type question alone | 5,191 ms | 356 / 1 |
| Priority question alone | 3,468 ms | 237 / 1 |
| Needs-human question alone | 2,131 ms | 176 / 1 |
| Sensitive question alone | 1,775 ms | 183 / 1 |

Removing routing fields and empty state saved **64 input tokens (2.5%)**, without
a latency improvement in this single noisy sample. Four separate requests totaled
12,565 ms and 952 input tokens, versus 16,676 ms and 2,530 tokens for the combined
request. This identifies question/schema construction as a substantial cost in
this short-item case; it does not justify replacing one typed request with four
calls or claim a repeatable speedup. The package already batches its four
questions into one request per item.

The [Ollama System One API](https://docs.ollama.com/api/systemone) accepts one shared
state and a named question map, returns one non-streaming response, and accepts
`keep_alive`. Different independent item states are handled per item, with client
and model reuse. Backlog output streaming is performed by the extension after
each complete item response. The official SDK forwards additional properties on
a request variable, so residency can be supplied without replacing its transport,
validation, retry or abort behavior.

The candidate used the same two-line item, tracker initialization and model digest.
The first after-change request also started with an empty model inventory. The
observer measured the official SDK request without modifying it or its answers.

| Scenario | Command/harness time | HTTP time | Input/output tokens | HTTP calls |
| --- | ---: | ---: | ---: | ---: |
| Minimal triage, initially no loaded models | 43,839 ms | 43,269 ms | 2,466 / 5 | 1 |
| Minimal triage, immediate warm repeat | 11,783 ms | 11,162 ms | 2,466 / 5 | 1 |

Both returned Issue with critical priority, without applying changes. The input
reduction is measurable; **this pair does not establish a warm latency improvement**.
The cold command fell from 53,072 to 43,839 ms, while its HTTP time fell only from
44,974 to 43,269 ms. Client startup and shared-host scheduling also changed. A
warm-to-warm comparison is separate from avoiding cold model startup. Default
`keep_alive="5m"` kept the model resident throughout the following backlog run.

The real disposable tracker then contained three login-regression items, each
initially Feature with priority 3. The same client and four-question catalog were
reused across independent item states.

| Phase | Command/harness time | Changed | Would change | Skipped | Failed | Model requests |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Dry run | 48,024 ms | 0 | 3 | 0 | 0 | 3 |
| Apply | 43,242 ms | 3 | 0 | 0 | 0 | 3 |
| Repeat apply, matching receipts | 656 ms | 0 | 0 | 3 | 0 | 0 |
| Refresh after apply | 35,507 ms | 0 | 0 | 3 | 0 | 3 |

Matching receipts eliminate repeated inference: the repeat apply processed all
three items in 656 ms without model requests. Refresh inferred again and proposed
no qualifying field changes. The endpoint reported 2,466–2,470 input tokens and
five output tokens per request. These narrow synthetic measurements establish
backlog behavior and observed latency, not production classification accuracy.

An independent packed consumer installed a freshly packed combined-branch archive
directly into a fresh real tracker with host SDK 2026.10.10. Doctor passed all five checks. The same real
model then processed two synthetic login regressions through the installed CLI:

| Phase | Launcher | Process wall time | Extension time | Changed / would change / skipped / failed |
| --- | --- | ---: | ---: | --- |
| Dry run | npx | 59,680 ms | 50,227 ms | 0 / 2 / 0 / 0 |
| Apply | native bunx | 58,878 ms | 47,268 ms | 2 / 0 / 0 / 0 |
| Receipt reuse | npx | 14,643 ms | 1,054 ms | 0 / 0 / 2 / 0 |
| Refresh | native bunx | 49,188 ms | 33,994 ms | 0 / 0 / 2 / 0 |

Each invocation emitted exactly two item JSON lines and one summary. Both items
retained exactly one receipt after apply/reuse/dry refresh. The installed host's
mutation guard accepted apply against the current source. Process wall times
include launcher and host startup; the extension's own `elapsed_ms` excludes them.

The opt-in `npm run test:live` suite separately passed **2/2 tests**, zero failed,
canceled or skipped, in 171.2 seconds. Its first case covered triage, dedupe, ask,
positive/negative gates and secret/clean safety gates in 68.9 seconds. Its batch
case covered two synthetic items through dry/apply/reuse/refresh in 97.1 seconds,
using six model requests; receipt reuse made zero requests.
