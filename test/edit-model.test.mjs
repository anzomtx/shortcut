import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSequenceLayout,
  getSequenceDurationUs,
  mapSequenceToSource,
  subtractSequenceRange,
} from "../public/edit-model.js";

let nextId = 0;
const createId = () => `clip-${nextId++}`;

test("subtracts a range and closes the sequence gap", () => {
  const source = [{ id: "source", inUs: 0, outUs: 10_000_000 }];
  const clips = subtractSequenceRange(source, 3_000_000, 6_000_000, createId);
  assert.deepEqual(
    clips.map(({ inUs, outUs }) => ({ inUs, outUs })),
    [
      { inUs: 0, outUs: 3_000_000 },
      { inUs: 6_000_000, outUs: 10_000_000 },
    ],
  );
  assert.equal(getSequenceDurationUs(clips), 7_000_000);
  assert.equal(mapSequenceToSource(clips, 4_000_000).sourceUs, 7_000_000);
});

test("subtracts a range spanning an existing cut", () => {
  const clips = [
    { id: "first", inUs: 0, outUs: 3_000_000 },
    { id: "second", inUs: 6_000_000, outUs: 10_000_000 },
  ];
  const result = subtractSequenceRange(clips, 2_000_000, 5_000_000, createId);
  assert.deepEqual(
    result.map(({ inUs, outUs }) => ({ inUs, outUs })),
    [
      { inUs: 0, outUs: 2_000_000 },
      { inUs: 8_000_000, outUs: 10_000_000 },
    ],
  );
  assert.deepEqual(
    buildSequenceLayout(result).map(({ sequenceInUs, sequenceOutUs }) => ({ sequenceInUs, sequenceOutUs })),
    [
      { sequenceInUs: 0, sequenceOutUs: 2_000_000 },
      { sequenceInUs: 2_000_000, sequenceOutUs: 4_000_000 },
    ],
  );
});
