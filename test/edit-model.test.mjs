import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSequenceLayout,
  getSequenceDurationUs,
  mapSequenceToSource,
  mapSourceTimestampsToSequence,
  resolveEditTimeUs,
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

test("maps source keyframes into the ripple-closed sequence timeline", () => {
  const clips = [
    { id: "first", inUs: 0, outUs: 1_000_000 },
    { id: "second", inUs: 2_600_000, outUs: 5_000_000 },
  ];
  const keyframesUs = [0, 1_000_000, 2_600_000, 4_000_000];

  assert.deepEqual(mapSourceTimestampsToSequence(clips, keyframesUs), [0, 1_000_000, 2_400_000]);
  assert.equal(mapSequenceToSource(clips, 2_400_000).sourceUs, 4_000_000);
});

test("keeps still-mode source and sequence time domains separate", () => {
  const state = {
    editMode: "remove",
    stillMode: true,
    pendingSourceUs: 4_000_000,
    pendingSequenceUs: 2_400_000,
    sequencePlayheadUs: 2_400_000,
    videoTimeUs: 2_600_000,
  };

  assert.equal(resolveEditTimeUs(state), 2_400_000);
  assert.equal(resolveEditTimeUs({ ...state, editMode: "include" }), 4_000_000);
});

test("rounds sequence positions at the editor model boundary", () => {
  const clips = [{ id: "source", inUs: 0, outUs: 10_000_000 }];
  assert.deepEqual(mapSequenceToSource(clips, 1_234_567.6), {
    index: 0,
    sourceUs: 1_234_568,
    sequenceUs: 1_234_568,
  });
});
