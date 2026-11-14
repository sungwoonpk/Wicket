# 0009. Streamed replies are masked by holding text back

Status: accepted. Replaces the rule in [0008](0008-fail-closed-policy.md) that a streamed reply is not scanned.

## Context

A reply that streams arrives in small pieces, often a word at a time. A card number or an email can be split between
two pieces, so scanning each piece alone misses it. Holding the whole reply until it ends is safe and gives up
streaming. Streamed replies were the largest open gap in the limits list.

## Decision

The gateway scans a streamed reply as it passes and sends text on only once nothing a detector could match crosses
the end of what it sends. The part still in doubt is held, joined with the next piece, and scanned again.

Where text may be cut follows from what the detectors match:

- an email, a social security number and an API key contain **no whitespace**
- a card number and a phone number are made only of **digits, spaces, dashes, dots, plus signs and brackets**

So text may be cut where one side is whitespace and the two sides are not both part of a number. In ordinary prose
that is nearly every space, so only the last word, or the last number, is held. Characters are judged by what they
become when normalized, and invisible characters are skipped, so fullwidth digits and zero-width characters cannot
hide a split. At the end of a choice, or of the stream, whatever is held is released.

A stream that is held back anyway, to judge its tool calls, is masked in full before it is stored or released. A reply
held for approval is therefore stored masked.

## Costs

- Text arrives a word or a number late. A number such as a card is held until it is clear it is over.
- Text that stays one unbroken word for more than 4,096 characters is cut anyway, so one endless token cannot stall a
  stream. A secret that long could be split. Real secrets are far shorter.
- Detection is still pattern based. Names and addresses are missed, as they are for a reply that is not streamed.
- Text with nothing to mask is sent exactly as it was. Text with a match is sent in normalized form, as in a reply
  that is not streamed.
- Tool arguments are not masked, in a stream or otherwise.

## Alternatives considered

- **Hold the whole reply.** Simplest and strongest. It makes every streamed answer arrive at once.
- **Mask each piece alone.** No delay, and misses anything split across pieces, which is the common case for numbers.
- **Hold back a fixed number of characters.** Longer than needed for most text, and still wrong where a number spans
  more than the window. The cut rule is exact for the patterns in use.
