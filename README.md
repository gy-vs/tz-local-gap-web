# Timezone Data Studio

Local workbench for timezone bundles.

Run `npm install`, then `npm run dev`.

## Bundle format

Bundles are plain text with one zone per block:

```
zone Example/City base +01:00
2024-03-31T01:00Z +02:00
2024-10-27T01:00Z +01:00
```

- `zone <name> base <offset>` opens a zone with its baseline total offset.
- Each following line is a transition: the UTC instant at which a new total
  offset starts. Segments are right-continuous (`[at, nextAt)`).
- Offsets are `[+-]HH` or `[+-]HH:mm`, covering standard + DST. Negative DST
  zones are written the same way (e.g. `-03:00` -> `-02:00`).
- `#` starts a comment.

## Local -> UTC resolution

`GET /api/convert?bundle=<id>&zone=<name>&local=YYYY-MM-DDTHH:mm&policy=<p>`

The server maps the wall time through every neighbouring offset, keeps the
mappings whose offset is actually in effect at the proposed instant, and
classifies the result:

- `unique`: exactly one valid candidate; the response also includes a
  `roundTrip` check that converts the resolved instant back to local time.
- `gap`: zero valid candidates; `gap` carries the local before/after bounds
  and the candidate list carries the two boundary readings.
- `overlap`: multiple valid candidates, returned sorted by UTC instant; every
  candidate includes a `basis` string explaining the offset mapping.

Policies are applied only on the server (`compatible`, `earlier`, `later`,
`reject`); the UI never adds or removes hours itself. `compatible` follows
the Temporal convention (shift a gap forward, take the first overlap reading).

`GET /api/bundles/:id/zones` returns parsed zones and transitions with the
current bundle `revision` (also sent as `ETag`). Editing a bundle bumps its
revision and immediately changes conversions.
