import * as diff from "diff";

export type DiffOperation =
  | { type: "delete"; startPos: number; endPos: number }
  | { type: "insert"; text: string; insertAfterPos: number };

export type EditPredictionDiff = DiffOperation[];

export function calculateDiff(
  originalText: string,
  newText: string
): EditPredictionDiff {
  const changes = diff.diffWordsWithSpace(originalText, newText);
  const operations: EditPredictionDiff = [];
  let originalPosition = 0;

  for (const change of changes) {
    if (change.removed) {
      operations.push({
        type: "delete",
        startPos: originalPosition,
        endPos: originalPosition + change.value.length,
      });
      originalPosition += change.value.length;
      continue;
    }

    if (change.added) {
      operations.push({
        type: "insert",
        text: change.value,
        insertAfterPos: originalPosition,
      });
      continue;
    }

    originalPosition += change.value.length;
  }

  return operations;
}
