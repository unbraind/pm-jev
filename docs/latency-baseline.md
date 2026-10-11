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

The feature's after-change and batch acceptance measurements are recorded in the
feature item and PR body. A warm-to-warm comparison is separate from avoiding cold
model startup; none of these narrow measurements establishes production accuracy.
