export function buildSequenceLayout(segments) {
  let cursorUs = 0;
  return segments.map((segment, index) => {
    const durationUs = segment.outUs - segment.inUs;
    const item = {
      segment,
      index,
      sequenceInUs: cursorUs,
      sequenceOutUs: cursorUs + durationUs,
    };
    cursorUs += durationUs;
    return item;
  });
}

export function getSequenceDurationUs(segments) {
  return segments.reduce((total, segment) => total + segment.outUs - segment.inUs, 0);
}

export function mapSequenceToSource(segments, timestampUs) {
  const layout = buildSequenceLayout(segments);
  if (layout.length === 0) return null;
  const durationUs = layout.at(-1).sequenceOutUs;
  const rounded = Number.isFinite(timestampUs) ? Math.round(timestampUs) : 0;
  const clamped = Math.min(Math.max(rounded, 0), durationUs);
  const item = layout.find((candidate) => clamped < candidate.sequenceOutUs) ?? layout.at(-1);
  return {
    index: item.index,
    sourceUs: Math.min(item.segment.outUs, item.segment.inUs + clamped - item.sequenceInUs),
    sequenceUs: clamped,
  };
}

export function mapSourceTimestampsToSequence(segments, timestampsUs) {
  const result = [];
  for (const item of buildSequenceLayout(segments)) {
    for (const timestampUs of timestampsUs) {
      if (timestampUs < item.segment.inUs) continue;
      if (timestampUs >= item.segment.outUs) break;
      result.push(item.sequenceInUs + timestampUs - item.segment.inUs);
    }
  }
  return result;
}

export function resolveEditTimeUs({
  editMode,
  stillMode,
  pendingSourceUs,
  pendingSequenceUs,
  sequencePlayheadUs,
  videoTimeUs,
}) {
  if (stillMode) {
    return editMode === "remove"
      ? pendingSequenceUs ?? sequencePlayheadUs
      : pendingSourceUs ?? videoTimeUs;
  }
  return editMode === "remove" ? sequencePlayheadUs : videoTimeUs;
}

export function subtractSequenceRange(segments, startUs, endUs, createId = () => crypto.randomUUID()) {
  const nextSegments = [];
  for (const item of buildSequenceLayout(segments)) {
    if (endUs <= item.sequenceInUs || startUs >= item.sequenceOutUs) {
      nextSegments.push({ ...item.segment });
      continue;
    }
    const overlapStartUs = Math.max(startUs, item.sequenceInUs);
    const overlapEndUs = Math.min(endUs, item.sequenceOutUs);
    const sourceCutStartUs = item.segment.inUs + overlapStartUs - item.sequenceInUs;
    const sourceCutEndUs = item.segment.inUs + overlapEndUs - item.sequenceInUs;
    if (sourceCutStartUs > item.segment.inUs) {
      nextSegments.push({ id: createId(), inUs: item.segment.inUs, outUs: sourceCutStartUs });
    }
    if (sourceCutEndUs < item.segment.outUs) {
      nextSegments.push({ id: createId(), inUs: sourceCutEndUs, outUs: item.segment.outUs });
    }
  }
  return nextSegments;
}
