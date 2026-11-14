# 0010. Every request is charged

Status: accepted.

## Context

A budget only works if every request costs something. A streamed request to an OpenAI-compatible server reports its
token usage only when the request asks for it with `stream_options.include_usage`. Without that the request was
recorded at a cost of zero, so an agent that always streamed never used any of its budget. The mock upstream sent
usage unasked, which hid this until it was made to behave like the real thing.

## Decision

- The gateway **asks for usage on every streamed request** to an OpenAI-compatible upstream, and keeps any other
  `stream_options` the caller set.
- A caller that did not ask for usage **does not receive** the extra usage-only chunk, since it did not expect one.
- When an upstream reports **no usage at all**, the request is charged an **estimate**, one token for every four
  characters of the request and of the reply, and the log line says `usageEstimated`.
- A stream passes through event by event, and the usage is read as it goes, so a long reply is not kept in memory.

## Costs

- The estimate is rough. It can be well off for languages and content that tokenize unlike English prose. It errs
  toward charging something rather than nothing, which is the right side for a budget.
- A request is charged after it runs, and the budget is checked before it. Requests in flight at the same moment can
  overshoot a budget by what they cost. `maxConcurrent` bounds this.
- A caller that sent `include_usage: false` explicitly still has it turned on towards the upstream, and gets no usage.

## Alternatives considered

- **Refuse streamed requests that do not ask for usage.** Breaks clients that did nothing wrong.
- **Always estimate, never ask.** Throws away exact numbers the provider offers for free.
- **Count the reply's characters and charge only that.** Misses the prompt, which is most of the cost for many agents.
